import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { INGEST_CORS } from "@/lib/ids";
import { appendEvents } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: INGEST_CORS });
}

/** rrweb's own type for custom events. */
const RRWEB_CUSTOM = 5;
const CUSTOM_TAG = "swy";

/**
 * Mirrors CustomEventType in the recorder. Only the five that make a session
 * worth watching become signatures — URL changes and scroll depth are useful
 * during playback but aren't reasons to open a recording.
 */
const SIGNATURES: Record<number, string> = {
  4: "rage_click",
  5: "dead_click",
  6: "field_retry",
  7: "js_error",
  8: "network_error",
};

type Batch = {
  v?: number;
  sessionId?: string;
  batchStartedAt?: number;
  closed?: boolean;
  closeReason?: string;
  events?: unknown[];
};

type RrwebEvent = {
  type?: number;
  data?: { tag?: string; payload?: { type?: number } };
};

async function readBody(request: Request): Promise<string> {
  const raw = Buffer.from(await request.arrayBuffer());
  // The recorder gzips with CompressionStream where the browser supports it.
  // Nothing decompresses request bodies for us, so do it here.
  if (request.headers.get("content-encoding") === "gzip") {
    return gunzipSync(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

export async function POST(request: Request) {
  let batch: Batch;
  try {
    batch = JSON.parse(await readBody(request));
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400, headers: INGEST_CORS });
  }

  const sessionId = batch.sessionId;
  if (!sessionId || !Array.isArray(batch.events)) {
    return NextResponse.json({ error: "bad batch" }, { status: 400, headers: INGEST_CORS });
  }

  const db = await getDb();
  const session = await db.one<{ id: string }>(
    `SELECT id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session) {
    return NextResponse.json({ error: "unknown session" }, { status: 404, headers: INGEST_CORS });
  }

  // Find which signatures fired in this batch, so the session list can be
  // filtered without ever reading the event files back.
  const found = new Set<string>();
  let errors = 0;
  for (const event of batch.events as RrwebEvent[]) {
    if (event?.type !== RRWEB_CUSTOM) continue;
    if (event.data?.tag !== CUSTOM_TAG) continue;
    const kind = event.data.payload?.type;
    if (typeof kind !== "number") continue;
    const signature = SIGNATURES[kind];
    if (signature) {
      found.add(signature);
      if (signature === "js_error") errors += 1;
    }
  }

  let bytes = 0;
  try {
    bytes = await appendEvents(sessionId, batch.events);
  } catch (error) {
    console.error("events: write failed", error);
    // 500 so the recorder retries — the events are still in its buffer,
    // because it only clears them on a confirmed write.
    return NextResponse.json({ error: "write failed" }, { status: 500, headers: INGEST_CORS });
  }

  await db.query(
    `UPDATE sessions SET
        last_event_at = now(),
        event_count   = event_count + $2,
        byte_count    = byte_count + $3,
        error_count   = error_count + $4,
        signatures    = ARRAY(SELECT DISTINCT unnest(signatures || $5::text[])),
        closed_at     = COALESCE(closed_at, $6::timestamptz),
        close_reason  = COALESCE(close_reason, $7)
      WHERE id = $1`,
    [
      sessionId,
      batch.events.length,
      bytes,
      errors,
      Array.from(found),
      batch.closed ? new Date().toISOString() : null,
      batch.closed ? (batch.closeReason ?? "closed") : null,
    ],
  );

  return new Response(null, { status: 204, headers: INGEST_CORS });
}
