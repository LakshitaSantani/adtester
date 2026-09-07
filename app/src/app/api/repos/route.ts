import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getRepoMeta, parseRepo } from "@/lib/github";
import { newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { ensureWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect a repository.
 *
 * Takes a personal access token the customer creates themselves — two
 * minutes of their time, and no OAuth app, app review or marketplace listing
 * of ours. That trade stops being right in phase 6, when people we don't
 * know start signing up and "paste a token with repo access" becomes an
 * unreasonable ask.
 */
export async function POST(request: Request) {
  let body: { token?: string; repo?: string; accessToken?: string };
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

  const parsed = parseRepo(body.repo ?? "");
  if (!parsed) {
    return NextResponse.json(
      { error: "Could not read that as a repository. Try owner/name or a GitHub URL." },
      { status: 400 },
    );
  }

  // Verify before saving, so a typo or a bad token fails here with a clear
  // message rather than silently inside a background job an hour later.
  let defaultBranch = "main";
  try {
    ({ defaultBranch } = await getRepoMeta({
      owner: parsed.owner,
      name: parsed.name,
      token: body.accessToken ?? null,
    }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not reach that repository." },
      { status: 400 },
    );
  }

  // One repository per project, matching what the UI presents. Connecting a
  // different one replaces the old rather than quietly adding a second that
  // the rest of the system would never look at.
  await db.query(
    `DELETE FROM repos WHERE project_id = $1 AND NOT (owner = $2 AND name = $3)`,
    [project.id, parsed.owner, parsed.name],
  );
  // Drop work queued against the repo we just disconnected; it would only
  // retry against data that no longer applies.
  await db.query(
    `DELETE FROM jobs WHERE project_id = $1 AND status IN ('pending','failed')`,
    [project.id],
  );

  await db.query(
    `INSERT INTO repos (id, project_id, owner, name, default_branch, access_token)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id, owner, name) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       default_branch = EXCLUDED.default_branch,
       last_error = NULL`,
    [
      newId("repo"),
      project.id,
      parsed.owner,
      parsed.name,
      defaultBranch,
      body.accessToken ?? null,
    ],
  );

  await enqueue(project.id, "sync_repo", { sinceDays: 30 });
  await enqueue(project.id, "index_repo");
  ensureWorker();

  return NextResponse.json({
    owner: parsed.owner,
    name: parsed.name,
    defaultBranch,
    queued: true,
  });
}

/** Re-sync on demand. */
export async function PUT(request: Request) {
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

  await enqueue(project.id, "sync_repo", { sinceDays: 30 });
  await enqueue(project.id, "index_repo");
  ensureWorker();

  return NextResponse.json({ queued: true });
}
