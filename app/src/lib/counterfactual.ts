/**
 * The counterfactual test.
 *
 * Everything else in the investigator is circumstantial: a change shipped
 * before the problem, and it touches code the page uses. So does half the
 * week's work. This is the one measurement that comes close to an
 * experiment — compare people who got the change against people who didn't,
 * over the same hours, and see whether the symptom follows the change.
 *
 * When some users are still on an older build while others have the new one,
 * that is a natural experiment nobody had to set up. It is the difference
 * between "this is suspicious" and "this is why", and it is the only signal
 * allowed to license high confidence.
 */

import { getDb } from "./db";

/** Each side needs at least this many sessions to mean anything. */
const MIN_GROUP_SIZE = 5;

export type Counterfactual =
  | {
      available: true;
      withChange: { sessions: number; affected: number; rate: number };
      withoutChange: { sessions: number; affected: number; rate: number };
      /** Percentage points. Positive means the change looks responsible. */
      separation: number;
      /** Builds compared, for the evidence trail. */
      releasesWith: string[];
      releasesWithout: string[];
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

type SessionRow = {
  release: string;
  sessions: number;
  affected: number;
};

/**
 * Does a build contain a given commit?
 *
 * Answered by deploy time rather than by commit ancestry: a build deployed
 * at or after the commit's deploy time contains it. That is exact for the
 * ordinary case of a single branch deployed in sequence, and wrong for
 * cherry-picks, hotfix branches and rollbacks.
 *
 * The precise answer needs the commit graph (GitHub's compare endpoint says
 * whether one commit is an ancestor of another), which costs a request per
 * pair and is worth adding when a real repo shows this approximation
 * misattributing something. Until then this keeps the whole test to one
 * query.
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
      detail:
        "This commit has no known deploy time, so we can't tell which builds carry it.",
    };
  }

  // Every build seen since the window opened, with how often the symptom
  // occurred on it — and, separately, when that build was FIRST seen at all.
  //
  // The "first seen at all" part has to look outside the window. Taking the
  // earliest session inside the window instead would date every build to
  // roughly when the window opened, so an old build still being served from
  // cache would look newer than the commit and get counted as carrying it —
  // which quietly collapses the two groups the whole test depends on.
  const rows = await db.query<SessionRow & { first_seen: string | null }>(
    `WITH release_origin AS (
       SELECT release, MIN(started_at) AS first_seen
         FROM sessions
        WHERE project_id = $1 AND release IS NOT NULL AND release <> ''
        GROUP BY release
     )
     SELECT s.release,
            COUNT(*)::int AS sessions,
            COUNT(*) FILTER (WHERE $3 = ANY(s.signatures))::int AS affected,
            MIN(o.first_seen)::text AS first_seen
       FROM sessions s
       JOIN release_origin o ON o.release = s.release
      WHERE s.project_id = $1
        AND s.started_at >= $2::timestamptz
        AND s.release IS NOT NULL AND s.release <> ''
        AND ($4::text IS NULL OR
             split_part(split_part(regexp_replace(s.entry_url, '^https?://[^/]+', ''), '?', 1), '#', 1) = $4)
      GROUP BY s.release`,
    [projectId, windowStart, signature, path],
  );

  if (rows.length === 0) {
    return {
      available: false,
      reason: "no_release_data",
      detail:
        "No sessions in this window recorded which build they were on. " +
        "Set data-swy-release in the install snippet — without it, changes " +
        "can never be separated from each other.",
    };
  }

  const commitTime = new Date(commit.deployed_at).getTime();

  const withChange = { sessions: 0, affected: 0 };
  const withoutChange = { sessions: 0, affected: 0 };
  const releasesWith: string[] = [];
  const releasesWithout: string[] = [];

  for (const row of rows) {
    const releaseTime = row.first_seen ? new Date(row.first_seen).getTime() : null;
    if (releaseTime === null) continue;

    // A build first seen at or after the commit went out carries it.
    const carries = releaseTime >= commitTime;
    const bucket = carries ? withChange : withoutChange;
    bucket.sessions += row.sessions;
    bucket.affected += row.affected;
    (carries ? releasesWith : releasesWithout).push(row.release);
  }

  if (releasesWith.length === 0 || releasesWithout.length === 0) {
    return {
      available: false,
      reason: "no_version_split",
      detail:
        "Every session in this window was on the same side of this change. " +
        "Without users on both sides there is no comparison to make — only " +
        "before and after, which anything else shipping that day would also explain.",
    };
  }

  if (withChange.sessions < MIN_GROUP_SIZE || withoutChange.sessions < MIN_GROUP_SIZE) {
    return {
      available: false,
      reason: "groups_too_small",
      detail:
        `Only ${withChange.sessions} sessions with the change and ` +
        `${withoutChange.sessions} without. Too few to tell a real difference ` +
        `from noise.`,
    };
  }

  const withRate = withChange.affected / withChange.sessions;
  const withoutRate = withoutChange.affected / withoutChange.sessions;

  return {
    available: true,
    withChange: { ...withChange, rate: withRate },
    withoutChange: { ...withoutChange, rate: withoutRate },
    separation: withRate - withoutRate,
    releasesWith,
    releasesWithout,
  };
}
