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
  data?: { tag?: string; payload?: { type?: number; path?: string; url?: string } };
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
  // Where each signature fired. In a single-page app this is rarely the page
  // the session started on, and reasoning from the entry URL would send the
  // whole pipeline looking at the wrong page's code.
  const paths: Record<string, string[]> = {};
  // Every page the session was on. This is the denominator when working out
  // a rate — "12 of 40 people on /checkout hit this" needs to know about the
  // 28 who didn't, and they leave no signature behind.
  const visited = new Set<string>();
  // Paths of requests that failed. This is the only thread from a session back
  // to server-side code: a frontend page reaches its own files by import, but
  // a backend handler is only ever reached over the network.
  const apiPaths = new Set<string>();
  let errors = 0;

  for (const event of batch.events as RrwebEvent[]) {
    if (event?.type !== RRWEB_CUSTOM) continue;
    if (event.data?.tag !== CUSTOM_TAG) continue;
    const payload = event.data.payload;
    const kind = payload?.type;
    if (typeof kind !== "number") continue;

    // A URL change (type 1) is how we learn a page was visited at all.
    if (kind === 1 && typeof payload?.url === "string") {
      try {
        visited.add(new URL(payload.url).pathname || "/");
      } catch {
        /* a malformed URL costs one page, not the batch */
      }
      continue;
    }

    const signature = SIGNATURES[kind];
    if (!signature) continue;

    found.add(signature);
    if (signature === "js_error") errors += 1;

    // A failed request names the endpoint behind it. Successful ones are not
    // recorded, which is the right subset here — a backend change that made
    // responses slower or subtly wrong leaves no trace this way, and that
    // limitation is real.
    if (signature === "network_error" && typeof payload?.url === "string") {
      try {
        const u = new URL(payload.url, "http://x");
        if (u.pathname && u.pathname !== "/") apiPaths.add(u.pathname);
      } catch {
        /* an unparseable URL costs one endpoint, not the batch */
      }
    }

    const path = typeof payload?.path === "string" ? payload.path : null;
    if (path) {
      visited.add(path);
      const list = paths[signature] ?? [];
      if (!list.includes(path)) list.push(path);
      paths[signature] = list;
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
        paths         = ARRAY(SELECT DISTINCT unnest(paths || $9::text[])),
        api_paths     = ARRAY(SELECT DISTINCT unnest(api_paths || $10::text[])),
        -- Merge rather than replace: a later batch can add a page an earlier
        -- one didn't see, and losing that would undo the whole point.
        signature_paths = (
          SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
            FROM (
              SELECT k, to_jsonb(ARRAY(SELECT DISTINCT unnest(
                       ARRAY(SELECT jsonb_array_elements_text(COALESCE(sessions.signature_paths -> k, '[]'::jsonb)))
                       || ARRAY(SELECT jsonb_array_elements_text(COALESCE($8::jsonb -> k, '[]'::jsonb)))
                     ))) AS v
                FROM (
                  SELECT jsonb_object_keys(sessions.signature_paths || $8::jsonb) AS k
                ) keys
            ) merged
        ),
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
      JSON.stringify(paths),
      Array.from(visited),
      Array.from(apiPaths),
    ],
  );

  return new Response(null, { status: 204, headers: INGEST_CORS });
}
