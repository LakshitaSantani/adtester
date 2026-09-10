/**
 * Answering "does this build contain that commit" from the commit graph.
 *
 * Lives here rather than in the engine because it is the one part of the
 * comparison that is specific to git. Everything else the counterfactual does
 * — splitting sessions, restricting to the window both builds were live,
 * measuring the difference — works the same whether a change is a commit or
 * an issue moving to Released. Only this needs parents.
 *
 * A source that cannot answer this passes nothing, and the comparison sorts
 * builds by when they first appeared instead. That is what everything did
 * before ancestry existed, and it is defeated by a rollback — which is why
 * the report says which basis it used.
 */

import type { Ancestry } from "@brain/changes";
import { getDb } from "@brain/db";

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


/**
 * The callback the counterfactual asks for, bound to one commit.
 *
 * Returns undefined when this project has no commits at all, so the engine
 * falls back to timing rather than asking a question nothing can answer.
 */
export async function gitAncestry(
  projectId: string,
  commitSha: string,
): Promise<((release: string) => Promise<Ancestry>) | undefined> {
  const db = await getDb();
  const any = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM commits WHERE project_id = $1`,
    [projectId],
  );
  if ((any?.n ?? 0) === 0) return undefined;

  return async (release: string) => {
    const buildSha = await resolveRelease(db, projectId, release);
    if (!buildSha) return "unknown";
    return containsCommit(db, projectId, buildSha, commitSha);
  };
}
