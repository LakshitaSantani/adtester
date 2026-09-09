import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { verify, type PostHogConfig } from "@/lib/posthog";
import { ensureWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect a PostHog account and start importing.
 *
 * Credentials are checked before they're stored, so a wrong key fails here
 * with something readable rather than inside a background job an hour later.
 */
export async function POST(request: Request) {
  let body: {
    token?: string;
    host?: string;
    projectId?: string;
    apiKey?: string;
    afterDays?: number;
    limit?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (!body.token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await resolveProject(body.token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const config: PostHogConfig = {
    host: body.host?.trim() || "https://us.i.posthog.com",
    projectId: (body.projectId ?? "").trim(),
    apiKey: (body.apiKey ?? "").trim(),
  };

  if (!config.projectId || !config.apiKey) {
    return NextResponse.json(
      { error: "Both a project id and a personal API key are needed." },
      { status: 400 },
    );
  }

  let name: string;
  try {
    ({ name } = await verify(config));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not reach PostHog." },
      { status: 400 },
    );
  }

  await db.query(
    `INSERT INTO data_sources (id, project_id, kind, config)
     VALUES ($1,$2,'posthog',$3)
     ON CONFLICT (project_id, kind) DO UPDATE SET
       config = EXCLUDED.config, last_error = NULL`,
    [newId("src"), project.id, JSON.stringify(config)],
  );

  await enqueue(project.id, "import_posthog", {
    limit: body.limit ?? 100,
    afterDays: body.afterDays ?? 30,
  });
  await enqueue(project.id, "investigate");
  ensureWorker();

  return NextResponse.json({ connected: true, name });
}

/** Re-import on demand. */
export async function PUT(request: Request) {
  let body: { token?: string; limit?: number; afterDays?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await resolveProject(body.token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  await enqueue(project.id, "import_posthog", {
    limit: body.limit ?? 100,
    afterDays: body.afterDays ?? 30,
  });
  await enqueue(project.id, "investigate");
  ensureWorker();

  return NextResponse.json({ queued: true });
}
