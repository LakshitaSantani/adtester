/**
 * Keeping Linear issues and their discussion in the database, on the same
 * no-dates-asked footing as Slack.
 *
 * Two jobs, and they feed two different halves of the engine. Issue sync
 * writes linear_issues, the "commits" table for a team with no repository —
 * these are what candidatesForSession will eventually compare a symptom
 * against. Comment sync writes into the same chunk table Slack threads use,
 * because a Linear comment thread is the other place a team argues about why
 * a change was shaped the way it was, and the intent layer does not care
 * which tool a quote came from as long as it is verbatim and attributed.
 */

import { ingestDocument } from "@brain/ingest-docs";
import { getDb } from "@brain/db";
import { syncSince } from "@brain/window";
import { fetchChangedIssues, fetchCommentThread, verifyKey } from "./linear";

/**
 * How old a Linear issue can be and still be a candidate.
 *
 * The equivalent of the git product's commit window. A commit's deploy time
 * is sometimes a guess, which is why that product allows thirty days for an
 * undated one. An issue's transition into a completed state is read from
 * history — a real timestamp, not an estimate — so there is no equivalent
 * excuse to look further back, and a tighter window keeps the candidate list
 * the size an investigation can actually reason about.
 */
export const CHANGE_WINDOW_DAYS = 14;

/**
 * Comment threads fetched per sync.
 *
 * Each is its own request against Linear's complexity budget. Capped so one
 * sync with two hundred completed issues doesn't turn into two hundred
 * comment fetches before anything else in the queue gets a turn.
 */
const MAX_COMMENT_FETCHES = 100;

export type SyncSummary = {
  issues: number;
  completed: number;
  threads: number;
  chunks: number;
  error: string | null;
};

/** Check a key and say whose workspace it is, for the setup page. */
export async function verifyLinearKey(
  apiKey: string,
): Promise<{ organization: string; user: string }> {
  return verifyKey(apiKey);
}

/**
 * Pull issues since the watermark, and the comment threads on the ones that
 * completed.
 *
 * One sync does both, rather than two jobs, because the interesting comment
 * threads are almost always on the issues that just finished — reading
 * comments on everything else would spend the budget on issues nobody has
 * discussed since they were filed.
 */
export async function syncLinear(
  projectId: string,
  apiKey: string,
): Promise<SyncSummary> {
  const db = await getDb();
  const summary: SyncSummary = { issues: 0, completed: 0, threads: 0, chunks: 0, error: null };

  const state = await db.one<{ last_synced_at: string | null }>(
    `SELECT last_synced_at::text FROM linear_sync_state WHERE project_id = $1`,
    [projectId],
  );
  const since = syncSince(state?.last_synced_at ?? null, CHANGE_WINDOW_DAYS);

  let issues;
  try {
    issues = await fetchChangedIssues(apiKey, since);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(
      `INSERT INTO linear_sync_state (project_id, last_error)
       VALUES ($1,$2)
       ON CONFLICT (project_id) DO UPDATE SET last_error = EXCLUDED.last_error`,
      [projectId, message.slice(0, 500)],
    );
    summary.error = message;
    return summary;
  }

  for (const issue of issues) {
    await db.query(
      `INSERT INTO linear_issues
         (id, project_id, identifier, title, description, state_type,
          moved_to_completed_at, created_at, updated_at, team_key, labels,
          assignee, url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (project_id, id) DO UPDATE SET
         title                 = EXCLUDED.title,
         description           = EXCLUDED.description,
         state_type            = EXCLUDED.state_type,
         moved_to_completed_at = EXCLUDED.moved_to_completed_at,
         updated_at            = EXCLUDED.updated_at,
         labels                = EXCLUDED.labels,
         assignee              = EXCLUDED.assignee`,
      [
        issue.id,
        projectId,
        issue.identifier,
        issue.title,
        issue.description,
        issue.stateType,
        issue.movedToCompletedAt,
        issue.createdAt,
        issue.updatedAt,
        issue.teamKey,
        issue.labels,
        issue.assignee,
        issue.url,
      ],
    );
    summary.issues += 1;
    if (issue.stateType === "completed") summary.completed += 1;
  }

  // Comment threads, on the issues that actually shipped something —
  // completed, and within the change window rather than merely touched by
  // this sync's broader "updated since" fetch.
  const candidates = issues
    .filter((i) => i.stateType === "completed" && i.movedToCompletedAt)
    .sort((a, b) => (b.movedToCompletedAt?.getTime() ?? 0) - (a.movedToCompletedAt?.getTime() ?? 0))
    .slice(0, MAX_COMMENT_FETCHES);

  for (const issue of candidates) {
    let thread;
    try {
      thread = await fetchCommentThread(apiKey, issue.id);
    } catch {
      // One issue's comments failing to fetch costs that issue's evidence,
      // not the sync — the issue itself is already saved above.
      continue;
    }
    if (!thread) continue;

    const result = await ingestDocument(projectId, {
      filename: `${thread.issueIdentifier} · ${thread.issueTitle}`,
      text: thread.transcript,
      occurredAt: thread.occurredAt.toISOString(),
      url: thread.url,
      source: "linear",
      // Declared, not sniffed — an issue with two or three comments would
      // fail the five-line heuristic and lose every commenter's name.
      kind: "transcript",
    });

    summary.threads += 1;
    summary.chunks += result.chunks;
  }

  const newest = issues.reduce(
    (max, i) => (i.updatedAt > max ? i.updatedAt : max),
    since,
  );
  await db.query(
    `INSERT INTO linear_sync_state (project_id, last_synced_at, last_error)
     VALUES ($1,$2,NULL)
     ON CONFLICT (project_id) DO UPDATE SET
       last_synced_at = EXCLUDED.last_synced_at,
       last_error = NULL`,
    [projectId, newest.toISOString()],
  );

  return summary;
}
