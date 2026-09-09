import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { retrieveCandidates } from "@/lib/intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Show what retrieval surfaces for a commit, before any model sees it.
 *
 * The retrieval half and the verification half fail in completely different
 * ways — bad retrieval means the right passage never gets considered, bad
 * verification means the wrong one gets quoted. Being able to look at the
 * first half alone is the difference between fixing the actual problem and
 * guessing at the prompt.
 *
 * Development only.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const { token, sha } = (await request.json()) as { token?: string; sha?: string };
  if (!token || !sha) {
    return NextResponse.json({ error: "need a token and a commit sha" }, { status: 400 });
  }

  const db = await getDb();
  const project = await db.one<{ id: string }>(
    `SELECT id FROM projects WHERE view_token = $1`,
    [token],
  );
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const commit = await db.one<{
    message: string;
    files_touched: string[];
    deployed_at: string | null;
  }>(
    `SELECT message, files_touched, deployed_at::text FROM commits
      WHERE project_id = $1 AND sha = $2`,
    [project.id, sha],
  );
  if (!commit) return NextResponse.json({ error: "unknown commit" }, { status: 404 });

  const { candidates, stats } = await retrieveCandidates(
    project.id,
    commit.files_touched,
    commit.message,
    commit.deployed_at,
  );

  return NextResponse.json({
    commit: commit.message,
    files: commit.files_touched,
    verifierEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    stats,
    candidates: candidates.map((c) => ({
      score: c.score,
      matchedTerms: c.terms,
      source: c.row.source,
      speaker: c.row.speaker,
      title: c.row.title,
      text: c.row.text.slice(0, 260),
    })),
  });
}
