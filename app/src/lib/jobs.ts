/**
 * The background job queue.
 *
 * A table, a worker loop, and no other infrastructure. Claiming is done with
 * a conditional UPDATE so two workers can't take the same row, which is the
 * only part of a queue that actually has to be correct.
 *
 * A note on where the worker runs. The design calls for a separate worker
 * process, and with a real Postgres that's exactly what you get — run
 * `npm run worker`. But PGlite is an embedded database and only one process
 * can open it, so in local development the loop runs inside the web app
 * instead (see instrumentation.ts). Same code, same queue, different host.
 */

import { getDb } from "./db";
import { newId } from "./ids";

export type JobKind = "sync_repo" | "index_repo" | "infer_deploys" | "investigate" | "import_posthog";

export type Job = {
  id: string;
  project_id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
};

const MAX_ATTEMPTS = 3;

export async function enqueue(
  projectId: string,
  kind: JobKind,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const db = await getDb();
  const id = newId("job");
  await db.query(
    `INSERT INTO jobs (id, project_id, kind, payload) VALUES ($1,$2,$3,$4)`,
    [id, projectId, kind, JSON.stringify(payload)],
  );
  return id;
}

/**
 * Take the next runnable job. The WHERE clause re-checks the status inside
 * the UPDATE, so if another worker claimed it a microsecond earlier this
 * returns nothing rather than a duplicate.
 */
export async function claimNext(): Promise<Job | null> {
  const db = await getDb();
  const row = await db.one<{
    id: string;
    project_id: string;
    kind: JobKind;
    payload: Record<string, unknown> | string;
    attempts: number;
  }>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= now()
         ORDER BY created_at
         LIMIT 1
      )
      AND status = 'pending'
      RETURNING id, project_id, kind, payload, attempts`,
  );
  if (!row) return null;
  return {
    ...row,
    payload:
      typeof row.payload === "string"
        ? (JSON.parse(row.payload) as Record<string, unknown>)
        : row.payload,
  };
}

/**
 * Mark a job done and drop its payload.
 *
 * A payload can carry a credential supplied for one run only. Keeping it
 * after the work is finished would quietly turn "don't store my key" into
 * storing it in a different table.
 */
export async function finish(jobId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE jobs SET status = 'done', completed_at = now(), last_error = NULL,
            payload = '{}'::jsonb
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Failures retry with a widening delay, then stop. A job that has given up
 * stays in the table as a row you can read — which is most of the reason
 * this is a table rather than a queue service.
 */
export async function fail(job: Job, error: unknown): Promise<void> {
  const db = await getDb();
  const message = error instanceof Error ? error.message : String(error);
  const giveUp = job.attempts >= MAX_ATTEMPTS;
  const backoffSeconds = job.attempts * 30;

  await db.query(
    giveUp
      ? `UPDATE jobs SET status = 'failed', last_error = $2, completed_at = now(),
             payload = '{}'::jsonb WHERE id = $1`
      : `UPDATE jobs SET status = 'pending', last_error = $2,
             run_after = now() + ($3 || ' seconds')::interval WHERE id = $1`,
    giveUp ? [job.id, message] : [job.id, message, String(backoffSeconds)],
  );

  console.error(
    `job ${job.kind} ${job.id} failed (attempt ${job.attempts}${giveUp ? ", giving up" : ""}):`,
    message,
  );
}
