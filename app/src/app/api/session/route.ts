import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { INGEST_CORS, newSessionId } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...INGEST_CORS, "Access-Control-Allow-Methods": "POST, PATCH, OPTIONS" },
  });
}

/**
 * Corrects the viewport once recording actually starts.
 *
 * The dimensions reported at session start are whatever the page had before
 * layout settled, which for a background-tab preload is nonsense. The
 * recorder re-reports them at snapshot time so the session list shows the
 * size the recording was actually made at.
 */
export async function PATCH(request: Request) {
  let body: { sessionId?: string; viewportWidth?: number; viewportHeight?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers: INGEST_CORS });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: "missing session" }, { status: 400, headers: INGEST_CORS });
  }

  const db = await getDb();
  await db.query(
    `UPDATE sessions SET viewport_width = $2, viewport_height = $3 WHERE id = $1`,
    [body.sessionId, body.viewportWidth ?? null, body.viewportHeight ?? null],
  );

  return new Response(null, { status: 204, headers: INGEST_CORS });
}

type StartBody = {
  key?: string;
  release?: string | null;
  url?: string;
  referrer?: string | null;
  userAgent?: string;
  language?: string;
  timeZone?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  metadata?: Record<string, unknown>;
  previousSessionId?: string | null;
};

/**
 * Starts (or resumes) a recording session.
 *
 * Resume matters more than it looks: without it a page refresh splits one
 * visit into several recordings, and the person watching can't tell that the
 * three sessions they're looking at are the same human.
 */
export async function POST(request: Request) {
  let body: StartBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400, headers: INGEST_CORS });
  }

  if (!body.key) {
    return NextResponse.json({ error: "missing key" }, { status: 400, headers: INGEST_CORS });
  }

  const db = await getDb();

  const project = await db.one<{ id: string }>(
    `SELECT id FROM projects WHERE install_key = $1`,
    [body.key],
  );
  if (!project) {
    // Don't leak whether the key format was wrong vs simply unknown.
    return NextResponse.json({ error: "unknown key" }, { status: 404, headers: INGEST_CORS });
  }

  // Resume only if the prior session belongs to this project and is still
  // open. An id from another project, or one already closed, starts fresh.
  if (body.previousSessionId) {
    const existing = await db.one<{ id: string }>(
      `SELECT id FROM sessions
        WHERE id = $1 AND project_id = $2 AND closed_at IS NULL
          AND last_event_at > now() - interval '30 minutes'`,
      [body.previousSessionId, project.id],
    );
    if (existing) {
      await db.query(`UPDATE sessions SET last_event_at = now() WHERE id = $1`, [
        existing.id,
      ]);
      return NextResponse.json({ sessionId: existing.id, resumed: true }, { headers: INGEST_CORS });
    }
  }

  const id = newSessionId();
  await db.query(
    `INSERT INTO sessions (
        id, project_id, release, entry_url, referrer, user_agent,
        language, time_zone, viewport_width, viewport_height, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      project.id,
      body.release ?? null,
      body.url ?? null,
      body.referrer ?? null,
      body.userAgent ?? null,
      body.language ?? null,
      body.timeZone ?? null,
      body.viewportWidth ?? null,
      body.viewportHeight ?? null,
      JSON.stringify(body.metadata ?? {}),
    ],
  );

  return NextResponse.json({ sessionId: id, resumed: false }, { headers: INGEST_CORS });
}
