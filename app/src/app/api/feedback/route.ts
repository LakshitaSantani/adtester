import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether a finding was actually right.
 *
 * The single most valuable thing this product can collect, and the only way
 * to know whether a confidence score means anything. Without it "is the
 * analysis correct" is answered by an impression in somebody's head that
 * never reaches anyone who could act on it.
 *
 * Recorded against a prediction that was made BEFORE the answer was known,
 * which is what makes it calibration rather than marking your own homework.
 */
export async function POST(request: Request) {
  let body: { token?: string; investigationId?: string; wasCorrect?: boolean; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const project = await resolveProject(body.token, "view");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!body.investigationId || typeof body.wasCorrect !== "boolean") {
    return NextResponse.json({ error: "need an investigation and a verdict" }, { status: 400 });
  }

  const db = await getDb();
  const investigation = await db.one<{ id: string }>(
    `SELECT id FROM investigations WHERE id = $1 AND project_id = $2`,
    [body.investigationId, project.id],
  );
  if (!investigation) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.query(
    `INSERT INTO feedback (investigation_id, was_correct, note)
     VALUES ($1,$2,$3)
     ON CONFLICT (investigation_id) DO UPDATE SET
       was_correct = EXCLUDED.was_correct, note = EXCLUDED.note, created_at = now()`,
    [body.investigationId, body.wasCorrect, body.note?.slice(0, 1000) ?? null],
  );

  return NextResponse.json({ recorded: true });
}
