import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { enqueue } from "@/lib/jobs";
import { ensureWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kick off a symptom sweep by hand, rather than waiting for the next sync. */
export async function POST(request: Request) {
  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await db.one<{ id: string }>(
    `SELECT id FROM projects WHERE view_token = $1`,
    [body.token],
  );
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  await enqueue(project.id, "investigate", { limit: 5 });
  ensureWorker();

  return NextResponse.json({ queued: true });
}
