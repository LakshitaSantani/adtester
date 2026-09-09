/**
 * The counterfactual test.
 *
 * Everything else in the investigator is circumstantial: a change shipped
 * before the problem, and it touches code the page uses. So does half the
 * week's work. This is the one measurement that comes close to an experiment
 * — compare people who got the change against people who didn't.
 *
 * There are two ways to find those two groups, and they are not equally
 * strong:
 *
 *   VERSION SPLIT — some users are on the new build while others are still on
 *   the old one, at the same time. Time is held constant and the only
 *   difference is the code. Near-experimental, and the only thing allowed to
 *   license high confidence.
 *
 *   TEMPORAL — nobody stamped a build, but we know when the deploy landed, so
 *   sessions before it ran the old code and sessions after ran the new one.
 *   The grouping is a fact, not a guess. What's weaker is the comparison: the
 *   groups differ in time as well as in code, so anything else that changed
 *   that afternoon is confounded with it.
 *
 * The temporal path matters more than it looks. Almost no analytics tool
 * records the customer's build version, so without it the strongest signal
 * would be unavailable on nearly all imported data and everything would sit
 * at the cap forever.
 */

import { getDb } from "./db";

/** Each side needs at least this many sessions to mean anything. */
const MIN_GROUP_SIZE = 5;

/** How far either side of a deploy the temporal comparison reaches. */
const TEMPORAL_WINDOW_HOURS = 72;

/**
 * Below this the two windows land at different times of day, and a diurnal
 * traffic swing looks like a change in behaviour.
 */
const MIN_TEMPORAL_WINDOW_HOURS = 24;

/**
 * Deploys within this of each other are one release event. Commits inside it
 * are indistinguishable by timing alone, which is worth saying out loud
 * rather than pretending to separate them.
 */
const CO_DEPLOY_MINUTES = 30;

type Group = { sessions: number; affected: number; rate: number };

export type Counterfactual =
  | {
      available: true;
      mode: "version_split";
      withChange: Group;
      withoutChange: Group;
      separation: number;
      releasesWith: string[];
      releasesWithout: string[];
      /** The stretch when both sets of builds were serving traffic. */
      overlap: { start: string; end: string; hours: number };
    }
  | {
      available: true;
      mode: "temporal";
      withChange: Group;
      withoutChange: Group;
      separation: number;
      /** Other commits that went out at the same moment. */
      coDeployed: number;
      deployedAt: string;
    }
  | {
      available: false;
      reason:
        | "no_release_data"
        | "no_version_split"
        | "groups_too_small"
        | "no_deploy_time";
      detail: string;
    };

/**
 * Was this session on the page in question?
 *
 * Checks the pages it actually visited, falling back to the entry URL for
 * sessions recorded before that was tracked. Using the entry URL alone breaks
 * every single-page app: people land on the homepage and click through, so
 * nobody looks like they were ever on /checkout and there is nothing left to
 * compare.
 */
const ON_PAGE = `(
  $4::text IS NULL
  OR $4 = ANY(s.paths)
  OR (s.paths = '{}' AND split_part(split_part(regexp_replace(s.entry_url, '^https?://[^/]+', ''), '?', 1), '#', 1) = $4)
)`;

/** Did the signature fire on that page, rather than merely somewhere? */
const BROKE_HERE = `(
  CASE WHEN s.signature_paths <> '{}'::jsonb
       THEN COALESCE(s.signature_paths -> $3, '[]'::jsonb) ? COALESCE($4, '')
        OR ($4::text IS NULL AND $3 = ANY(s.signatures))
       ELSE $3 = ANY(s.signatures)
  END
)`;

/**
 * Does a build contain a given commit?
 *
 * Answered by deploy time rather than commit ancestry: a build first seen at
 * or after the commit went out contains it. Exact for a single branch
 * deployed in sequence; wrong for cherry-picks, hotfix branches and
 * rollbacks. The precise answer needs the commit graph, which costs a request
 * per pair and is worth adding when a real repo shows this misattributing
 * something.
 */
export async function testCounterfactual(
  projectId: string,
  commitSha: string,
  signature: string,
  path: string | null,
  windowStart: string,
): Promise<Counterfactual> {
  const db = await getDb();

  const commit = await db.one<{ deployed_at: string | null }>(
    `SELECT deployed_at FROM commits WHERE project_id = $1 AND sha = $2`,
    [projectId, commitSha],
  );

  if (!commit?.deployed_at) {
    return {
      available: false,
      reason: "no_deploy_time",
      detail: "This commit has no known deploy time, so there is nothing to split users on.",
    };
  }

  const split = await tryVersionSplit(
    db,
    projectId,
    commit.deployed_at,
    signature,
    path,
    windowStart,
  );
  if (split) return split;

  // No usable build stamps. Fall back to comparing the same page before and
  // after the deploy landed.
  return tryTemporal(db, projectId, commitSha, commit.deployed_at, signature, path);
}

type Db = Awaited<ReturnType<typeof getDb>>;

/** The strong path: two builds live at once. */
async function tryVersionSplit(
  db: Db,
  projectId: string,
  commitDeployedAt: string,
  signature: string,
  path: string | null,
  windowStart: string,
): Promise<Counterfactual | null> {
  // Each build's first appearance has to be measured across all history, not
  // just inside the window — otherwise every build looks like it started when
  // the window opened, and an old build still being served from cache gets
  // counted as carrying the change.
  // When each build started AND stopped serving. The stop time is what makes
  // a rollback visible: a build that was withdrawn has a last_seen in the
  // past while an older one carries on.
  const fleet = await db.query<{
    release: string;
    first_seen: string;
    last_seen: string;
  }>(
    `SELECT release,
            MIN(started_at)::text AS first_seen,
            MAX(started_at)::text AS last_seen
       FROM sessions
      WHERE project_id = $1 AND release IS NOT NULL AND release <> ''
      GROUP BY release`,
    [projectId],
  );

  if (fleet.length === 0) return null; // nothing stamped — try temporal

  const commitTime = new Date(commitDeployedAt).getTime();
  const carriers = fleet.filter((r) => new Date(r.first_seen).getTime() >= commitTime);
  const priors = fleet.filter((r) => new Date(r.first_seen).getTime() < commitTime);

  if (carriers.length === 0 || priors.length === 0) return null;

  // Compare only the stretch when both sets of builds were actually live.
  //
  // Classifying by first appearance and then counting everything afterwards
  // assumes deploys only ever move forward. They don't. A team that spots an
  // outage and rolls back leaves the new build serving for an hour and the old
  // one serving for the two days either side — so "with the change" is one bad
  // hour and "without it" is mostly the calm afterwards, and the arithmetic
  // reports a difference that is really the rollback's shape rather than the
  // code's effect. Restricting both groups to the window when both were
  // running removes it, and does the same favour for a canary that was still
  // ramping.
  //
  // Note what this does NOT fix: a cherry-pick puts the same change in a build
  // whose first appearance predates the commit, and no amount of timing can
  // see that. Only commit ancestry can, and that needs parent SHAs the repo
  // sync doesn't record yet.
  const overlapStart = Math.min(...carriers.map((r) => new Date(r.first_seen).getTime()));
  const overlapEnd = Math.min(
    Math.max(...carriers.map((r) => new Date(r.last_seen).getTime())),
    Math.max(...priors.map((r) => new Date(r.last_seen).getTime())),
  );

  const overlapHours = (overlapEnd - overlapStart) / 3_600_000;
  if (overlapHours <= 0) return null; // never concurrent — try temporal

  const startIso = new Date(Math.max(overlapStart, new Date(windowStart).getTime())).toISOString();
  const endIso = new Date(overlapEnd).toISOString();

  const rows = await db.query<{
    release: string;
    sessions: number;
    affected: number;
  }>(
    `SELECT s.release,
            COUNT(*)::int AS sessions,
            COUNT(*) FILTER (WHERE ${BROKE_HERE})::int AS affected
       FROM sessions s
      WHERE s.project_id = $1
        AND s.started_at >= $2::timestamptz
        AND s.started_at <= $5::timestamptz
        AND s.release IS NOT NULL AND s.release <> ''
        AND ${ON_PAGE}
      GROUP BY s.release`,
    [projectId, startIso, signature, path, endIso],
  );

  const carrierNames = new Set(carriers.map((r) => r.release));
  const withChange = { sessions: 0, affected: 0 };
  const withoutChange = { sessions: 0, affected: 0 };
  const releasesWith: string[] = [];
  const releasesWithout: string[] = [];

  for (const row of rows) {
    const carries = carrierNames.has(row.release);
    const bucket = carries ? withChange : withoutChange;
    bucket.sessions += row.sessions;
    bucket.affected += row.affected;
    (carries ? releasesWith : releasesWithout).push(row.release);
  }

  const usable =
    releasesWith.length > 0 &&
    releasesWithout.length > 0 &&
    withChange.sessions >= MIN_GROUP_SIZE &&
    withoutChange.sessions >= MIN_GROUP_SIZE;

  if (!usable) return null; // fall through to temporal

  const withRate = withChange.affected / withChange.sessions;
  const withoutRate = withoutChange.affected / withoutChange.sessions;

  return {
    available: true,
    mode: "version_split",
    withChange: { ...withChange, rate: withRate },
    withoutChange: { ...withoutChange, rate: withoutRate },
    separation: withRate - withoutRate,
    releasesWith,
    releasesWithout,
    overlap: {
      start: startIso,
      end: endIso,
      hours: (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000,
    },
  };
}

/**
 * The fallback: the same page, before and after the deploy.
 *
 * Which code each session ran is known for certain — that part is not
 * inferred. What can't be ruled out is everything else that moved at the same
 * time, which is why this mode is capped lower and why co-deployed commits
 * are counted and reported.
 */
async function tryTemporal(
  db: Db,
  projectId: string,
  commitSha: string,
  deployedAt: string,
  signature: string,
  path: string | null,
): Promise<Counterfactual> {
  // Match the two windows to whichever side is shorter.
  //
  // A commit deployed two hours ago would otherwise be compared against 72
  // hours of "before" and 2 hours of "after". Traffic swings between night and
  // day, so an unmatched comparison manufactures a difference out of the clock
  // rather than the code — the exact false pattern the counterfactual exists
  // to rule out.
  const sinceDeploy = (Date.now() - new Date(deployedAt).getTime()) / 3_600_000;
  const windowHours = Math.min(TEMPORAL_WINDOW_HOURS, Math.max(1, sinceDeploy));

  // Under a full day either side, the two windows sit at different times of
  // day and the comparison is between a morning and an evening as much as
  // between two builds.
  if (windowHours < MIN_TEMPORAL_WINDOW_HOURS) {
    return {
      available: false,
      reason: "groups_too_small",
      detail:
        `This deployed ${sinceDeploy.toFixed(1)} hours ago. Comparing that against ` +
        `the same span beforehand would mostly measure the time of day. Worth ` +
        `re-running once a full day has passed.`,
    };
  }

  const [row] = await db.query<{
    before_sessions: number;
    before_affected: number;
    after_sessions: number;
    after_affected: number;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE s.started_at <  $2::timestamptz)::int AS before_sessions,
       COUNT(*) FILTER (WHERE s.started_at <  $2::timestamptz
                          AND ${BROKE_HERE})::int AS before_affected,
       COUNT(*) FILTER (WHERE s.started_at >= $2::timestamptz)::int AS after_sessions,
       COUNT(*) FILTER (WHERE s.started_at >= $2::timestamptz
                          AND ${BROKE_HERE})::int AS after_affected
       FROM sessions s
      WHERE s.project_id = $1
        AND s.started_at >= $2::timestamptz - ($5 || ' hours')::interval
        AND s.started_at <= $2::timestamptz + ($5 || ' hours')::interval
        AND ${ON_PAGE}`,
    [projectId, deployedAt, signature, path, String(windowHours)],
  );

  const before = row?.before_sessions ?? 0;
  const after = row?.after_sessions ?? 0;

  if (before < MIN_GROUP_SIZE || after < MIN_GROUP_SIZE) {
    return {
      available: false,
      reason: "groups_too_small",
      detail:
        `Only ${before} sessions on this page before the deploy and ${after} after. ` +
        `Too few either side to tell a real difference from noise.`,
    };
  }

  // How many other commits went out at the same moment? They share this exact
  // comparison, so timing alone cannot tell them apart.
  const [co] = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM commits
      WHERE project_id = $1 AND sha <> $2 AND deployed_at IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (deployed_at - $3::timestamptz))) <= $4`,
    [projectId, commitSha, deployedAt, CO_DEPLOY_MINUTES * 60],
  );

  const beforeRate = (row?.before_affected ?? 0) / before;
  const afterRate = (row?.after_affected ?? 0) / after;

  return {
    available: true,
    mode: "temporal",
    withChange: { sessions: after, affected: row?.after_affected ?? 0, rate: afterRate },
    withoutChange: {
      sessions: before,
      affected: row?.before_affected ?? 0,
      rate: beforeRate,
    },
    separation: afterRate - beforeRate,
    coDeployed: co?.n ?? 0,
    deployedAt,
  };
}
