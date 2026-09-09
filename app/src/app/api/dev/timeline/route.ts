import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { buildTimeline, formatTimeline } from "@/lib/session-timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read a recording back as a description of what the person did. */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { token, sessionId } = (await request.json()) as {
    token?: string;
    sessionId?: string;
  };
  if (!token || !sessionId) {
    return NextResponse.json({ error: "need a token and a session id" }, { status: 400 });
  }

  const db = await getDb();
  const session = await db.one<{ id: string }>(
    `SELECT s.id FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1 AND p.view_token = $2`,
    [sessionId, token],
  );
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const entries = await buildTimeline(sessionId);
  return NextResponse.json({ entries: entries.length, timeline: formatTimeline(entries) });
}
