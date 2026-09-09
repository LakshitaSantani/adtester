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
 * Below this, two adjacent windows land at different times of day and a
 * diurnal traffic swing looks like a change in behaviour.
 *
 * It is the threshold between two shapes of comparison, not a refusal. It
 * used to be a refusal, and that made the tool useless exactly when it was
 * needed: nothing could be investigated until a full day after the deploy,
 * which is a day after anyone wants to know. Under a day, the comparison
 * moves to the same clock hours on preceding days instead.
 */
const MIN_TEMPORAL_WINDOW_HOURS = 24;

/**
 * How many preceding days the short-window comparison draws its control from.
 *
 * More than one, because a single previous day is one day's noise — a
 * campaign, an outage, a public holiday. Rates are compared rather than
 * counts, so an unequal number of days on either side costs nothing.
 */
const PRIOR_DAYS = 7;

/**
 * Under this much time since the deploy there is nothing to measure yet.
 *
 * Not a diurnal argument — an arithmetic one. Whoever is on the site in the
 * first minutes after a deploy is whoever happened to be mid-session, and
 * that is a sample of the clock rather than of the change.
 */
const MIN_ELAPSED_HOURS = 1;

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
      /**
       * How many builds were sorted by the commit graph rather than by when
       * they first appeared. Timestamps assume history is a line; the graph
       * knows it isn't.
       */
      buildsByAncestry: number;
      /** Builds compared in total, so the reader can see the other number. */
      buildsCompared: number;
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
      /**
       * What the "before" group was.
       *
       * "adjacent" is the window immediately before the deploy. "prior_days"
       * is the same clock hours on preceding days, used when the change is
       * younger than a day and an adjacent window would compare times of day.
       */
      comparison: "adjacent" | "prior_days";
      /** Hours on each side, so the report can say what it looked at. */
      windowHours: number;
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
    commitSha,
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

/**
 * Does the build named by this release string contain that commit?
 *
 * Timestamps answer this wrongly whenever history isn't a line. A cherry-pick
 * lands the change in a build whose own commit is older than the change. A
 * rollback re-serves an old build under a fresh identifier, which then looks
 * newer than the change it was rolled back to escape. In both cases the
 * groups come out swapped, and swapped groups don't produce a weak answer —
 * they produce a confident inverted one.
 *
 * Git already knows the answer, in the parent links. This walks them.
 */
type Ancestry = "carries" | "does_not_carry" | "unknown";

/**
 * The commit a release string refers to, if it names one.
 *
 * Teams that stamp a build with its commit SHA get an exact answer here.
 * Teams that stamp "v2.4.1" or a build number don't, and fall back to
 * timestamps — worse, but no worse than before.
 */
async function resolveRelease(
  db: Db,
  projectId: string,
  release: string,
): Promise<string | null> {
  const hex = release.match(/[0-9a-f]{7,40}/i);
  if (!hex) return null;
  const prefix = hex[0].toLowerCase();

  const rows = await db.query<{ sha: string }>(
    `SELECT sha FROM commits
      WHERE project_id = $1 AND lower(sha) LIKE $2 || '%'
      LIMIT 2`,
    [projectId, prefix],
  );

  // Two matches means the prefix is ambiguous, which is not an answer.
  return rows.length === 1 ? rows[0].sha : null;
}

/**
 * Walk a build's ancestry looking for a commit.
 *
 * Returns "unknown" rather than "does_not_carry" when the walk runs out of
 * stored history before it can rule the commit out. The sync keeps a window
 * of recent commits, so a path can leave the set we hold — and "we didn't
 * find it" then means we ran out of data, not that it isn't there. Reporting
 * that as absence is how a build gets put in the wrong group with no sign
 * anything went wrong.
 */
async function containsCommit(
  db: Db,
  projectId: string,
  buildSha: string,
  commitSha: string,
): Promise<Ancestry> {
  if (buildSha === commitSha) return "carries";

  const [row] = await db.query<{ found: boolean; complete: boolean }>(
    `WITH RECURSIVE target AS (
       SELECT COALESCE(deployed_at, authored_at) AS t
         FROM commits WHERE project_id = $1 AND sha = $3
     ),
     walk AS (
       SELECT sha, parents, message, COALESCE(deployed_at, authored_at) AS t
         FROM commits WHERE project_id = $1 AND sha = $2
       UNION
       SELECT c.sha, c.parents, c.message, COALESCE(c.deployed_at, c.authored_at)
         FROM commits c
         JOIN walk w ON c.sha = ANY(w.parents)
        WHERE c.project_id = $1
     )
     SELECT
       (
         EXISTS (SELECT 1 FROM walk WHERE sha = $3)
         -- A cherry-pick is a different commit carrying the same change, so
         -- ancestry alone says no and means it. git cherry-pick -x writes the
         -- original SHA into the message, which is the one place the link
         -- survives; without -x there is nothing to read and this misses it.
         OR EXISTS (
           SELECT 1 FROM walk
            WHERE message ILIKE '%cherry picked from commit ' || substr($3, 1, 7) || '%'
         )
       ) AS found,
       -- Whether the walk ran out of history or ran out of OUR history.
       --
       -- Only commits newer than the target matter. Parent links run
       -- backwards in time, so once the walk drops below the target's own
       -- timestamp nothing further down can be it, and the walk may stop
       -- there with the question answered.
       --
       -- Above that line, a commit is only accounted for if its parents were
       -- recorded and we hold them. An empty parents array reads as "root
       -- commit" and almost never is one: it means the parents were never
       -- collected — every commit synced before this column existed looks
       -- like that. Treating those as roots would answer "this build does
       -- not contain that change" for an entire project's history, with
       -- complete confidence and no sign anything was missing.
       NOT EXISTS (
         SELECT 1 FROM walk w, target
          WHERE w.t > target.t
            AND (
              cardinality(w.parents) = 0
              OR EXISTS (
                SELECT 1 FROM unnest(w.parents) AS p
                 WHERE NOT EXISTS (
                   SELECT 1 FROM commits c
                    WHERE c.project_id = $1 AND c.sha = p
                 )
              )
            )
       ) AS complete`,
    [projectId, buildSha, commitSha],
  );

  if (row?.found) return "carries";
  return row?.complete ? "does_not_carry" : "unknown";
}

/** The strong path: two builds live at once. */
async function tryVersionSplit(
  db: Db,
  projectId: string,
  commitSha: string,
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

  // Ask the commit graph which builds contain the change, and fall back to
  // first-appearance only where it can't say.
  const carriers: typeof fleet = [];
  const priors: typeof fleet = [];
  let byAncestry = 0;

  for (const build of fleet) {
    const buildSha = await resolveRelease(db, projectId, build.release);
    const verdict: Ancestry = buildSha
      ? await containsCommit(db, projectId, buildSha, commitSha)
      : "unknown";

    if (verdict !== "unknown") byAncestry += 1;

    const carries =
      verdict === "carries"
        ? true
        : verdict === "does_not_carry"
          ? false
          : new Date(build.first_seen).getTime() >= commitTime;

    (carries ? carriers : priors).push(build);
  }

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
    buildsByAncestry: byAncestry,
    buildsCompared: fleet.length,
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

  if (sinceDeploy < MIN_ELAPSED_HOURS) {
    return {
      available: false,
      reason: "groups_too_small",
      detail:
        `This deployed ${Math.round(sinceDeploy * 60)} minutes ago — too recently for ` +
        `anyone to have used the new code much. Worth re-running in an hour.`,
    };
  }

  // Which control group to compare against depends on how long the change has
  // been live.
  //
  // Once a day has passed, the window immediately before the deploy is the
  // best control there is: it is the nearest thing in time, so the least has
  // moved between the two sides.
  //
  // Before that, it is the worst control there is. Comparing the three hours
  // after a lunchtime deploy against the three before it compares the
  // lunchtime peak with the morning, and reports the clock as a regression.
  // The same three hours on preceding days holds the time of day fixed, which
  // is the confounder that actually bites at this length. What it gives up is
  // adjacency — a week is long enough for the traffic mix to drift — and that
  // is the right thing to give up, because a diurnal swing is guaranteed to
  // be there and a week-long drift is not.
  const dayAligned = sinceDeploy < MIN_TEMPORAL_WINDOW_HOURS;
  const windowHours = dayAligned
    ? sinceDeploy
    : Math.min(TEMPORAL_WINDOW_HOURS, sinceDeploy);

  const [row] = dayAligned
    ? await db.query<{
        before_sessions: number;
        before_affected: number;
        after_sessions: number;
        after_affected: number;
      }>(
        // The window since the deploy, against the same clock window on each
        // of the preceding days. Every prior window ends at or before the
        // deploy, because the window is shorter than the day it is shifted
        // by — so no session that ran the new code can land in the control.
        `WITH after_window AS (
           SELECT * FROM sessions s
            WHERE s.project_id = $1
              AND s.started_at >= $2::timestamptz
              AND s.started_at <  $2::timestamptz + ($5 || ' hours')::interval
              AND ${ON_PAGE}
         ),
         before_window AS (
           SELECT s.* FROM sessions s
             JOIN generate_series(1, $6::int) AS k ON true
            WHERE s.project_id = $1
              AND s.started_at >= $2::timestamptz - make_interval(days => k)
              AND s.started_at <  $2::timestamptz - make_interval(days => k)
                                  + ($5 || ' hours')::interval
              AND ${ON_PAGE}
         )
         SELECT
           (SELECT COUNT(*)::int FROM before_window s) AS before_sessions,
           (SELECT COUNT(*)::int FROM before_window s WHERE ${BROKE_HERE})
             AS before_affected,
           (SELECT COUNT(*)::int FROM after_window s) AS after_sessions,
           (SELECT COUNT(*)::int FROM after_window s WHERE ${BROKE_HERE})
             AS after_affected`,
        [projectId, deployedAt, signature, path, String(windowHours), String(PRIOR_DAYS)],
      )
    : await db.query<{
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
      detail: dayAligned
        ? `Only ${after} sessions on this page in the ${windowHours.toFixed(1)} hours ` +
          `since the deploy, and ${before} in the same hours on the previous ` +
          `${PRIOR_DAYS} days. Too few either side to tell a real difference from noise.`
        : `Only ${before} sessions on this page before the deploy and ${after} after. ` +
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
    comparison: dayAligned ? "prior_days" : "adjacent",
    windowHours,
  };
}
