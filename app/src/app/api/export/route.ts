import { NextResponse } from "next/server";
import { resolveProject } from "@brain/auth";
import { getDb } from "@brain/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything needed to judge whether the analysis was any good, and nothing
 * else.
 *
 * When somebody runs this on their own machine the results live there, so
 * there has to be a way to send back what happened without handing over a
 * database, a set of credentials, or recordings of their users.
 *
 * Deliberately excluded: API keys and tokens, session recordings, document
 * text, and the quotes pulled from their PRDs and meetings. What's left is
 * the shape of each finding, the numbers behind it, and whether a human said
 * it was right.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  const project = await resolveProject(token, "view");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const db = await getDb();

  const investigations = await db.query(
    `SELECT i.id, i.symptom, i.symptom_started, i.status, i.commit_sha,
            i.confidence, i.declined_reason, i.created_at,
            f.was_correct, f.note AS feedback_note
       FROM investigations i
       LEFT JOIN feedback f ON f.investigation_id = i.id
      WHERE i.project_id = $1
      ORDER BY i.created_at`,
    [project.id],
  );

  // Signal contributions, so a wrong answer can be traced to which signal
  // misled it rather than just noted as wrong.
  const signals = await db.query(
    `SELECT e.investigation_id, e.kind, e.contribution, e.detail
       FROM evidence e
       JOIN investigations i ON i.id = e.investigation_id
      WHERE i.project_id = $1 AND e.kind IN ('signal','counterfactual')`,
    [project.id],
  );

  const [counts] = await db.query<{
    sessions: number;
    commits: number;
    documents: number;
    routes: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM sessions WHERE project_id = $1) AS sessions,
       (SELECT COUNT(*)::int FROM commits WHERE project_id = $1) AS commits,
       (SELECT COUNT(*)::int FROM documents WHERE project_id = $1) AS documents,
       (SELECT COUNT(*)::int FROM code_entities
         WHERE project_id = $1 AND route IS NOT NULL) AS routes`,
    [project.id],
  );

  return new NextResponse(
    JSON.stringify(
      { exportedAt: new Date().toISOString(), scale: counts, investigations, signals },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="simplywhy-results.json"`,
      },
    },
  );
}
