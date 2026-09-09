import { NextResponse } from "next/server";
import { resolveProject } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { getRepoMeta, parseRepo } from "@/lib/github";
import { newId } from "@/lib/ids";
import { enqueue } from "@/lib/jobs";
import { verify, type PostHogConfig } from "@/lib/posthog";
import { saveSecret } from "@/lib/secrets";
import { ensureWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  token?: string;
  posthog?: { host?: string; projectId?: string; apiKey?: string } | null;
  repo?: { url?: string; accessToken?: string } | null;
  anthropicKey?: string | null;
  /** When false the key is verified, used for this run, and never stored. */
  storeAnthropicKey?: boolean;
  run?: boolean;
};

/**
 * Save whatever the setup page collected, then start the work.
 *
 * Every credential is checked against its service before being stored, so a
 * typo fails here with something readable instead of inside a background job
 * twenty minutes later. Each connection is independent: a bad PostHog key
 * doesn't stop a good GitHub one being saved.
 */
export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await resolveProject(body.token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const errors: Record<string, string> = {};
  const connected: string[] = [];
  /** Set when the key was verified but deliberately not stored. */
  let oneShotKey: string | null = null;

  // --- PostHog -------------------------------------------------------------

  if (body.posthog?.projectId && body.posthog?.apiKey) {
    const config: PostHogConfig = {
      host: body.posthog.host?.trim() || "https://us.i.posthog.com",
      projectId: body.posthog.projectId.trim(),
      apiKey: body.posthog.apiKey.trim(),
    };
    try {
      await verify(config);
      await db.query(
        `INSERT INTO data_sources (id, project_id, kind, config)
         VALUES ($1,$2,'posthog',$3)
         ON CONFLICT (project_id, kind) DO UPDATE SET
           config = EXCLUDED.config, last_error = NULL`,
        [newId("src"), project.id, JSON.stringify({ ...config, apiKey: encrypt(config.apiKey) })],
      );
      connected.push("posthog");
    } catch (error) {
      errors.posthog = error instanceof Error ? error.message : "Could not reach PostHog.";
    }
  }

  // --- GitHub --------------------------------------------------------------

  if (body.repo?.url) {
    const parsed = parseRepo(body.repo.url);
    if (!parsed) {
      errors.repo = "Could not read that as a repository. Try owner/name or a GitHub URL.";
    } else {
      try {
        const { defaultBranch } = await getRepoMeta({
          owner: parsed.owner,
          name: parsed.name,
          token: body.repo.accessToken ?? null,
        });
        await db.query(
          `DELETE FROM repos WHERE project_id = $1 AND NOT (owner = $2 AND name = $3)`,
          [project.id, parsed.owner, parsed.name],
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
            body.repo.accessToken ? encrypt(body.repo.accessToken) : null,
          ],
        );
        connected.push("github");
      } catch (error) {
        errors.repo = error instanceof Error ? error.message : "Could not reach that repository.";
      }
    }
  }

  // --- Anthropic -----------------------------------------------------------

  if (body.anthropicKey?.trim()) {
    const key = body.anthropicKey.trim();
    // A cheap call that fails loudly on a bad key, rather than discovering it
    // during an investigation an hour from now.
    try {
      const check = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (check.status === 401 || check.status === 403) {
        errors.anthropic = "Anthropic rejected that key.";
      } else if (body.storeAnthropicKey) {
        await saveSecret(project.id, "anthropic", key);
        connected.push("anthropic");
      } else {
        // Verified and deliberately not stored. It rides along with this run
        // in the job payload and is wiped when the job finishes.
        oneShotKey = key;
        connected.push("anthropic (this run only)");
      }
    } catch {
      errors.anthropic = "Could not reach Anthropic to check the key.";
    }
  }

  // --- start the work ------------------------------------------------------

  if (body.run) {
    const hasPostHog = await db.one(
      `SELECT 1 FROM data_sources WHERE project_id = $1 AND kind = 'posthog'`,
      [project.id],
    );
    const hasRepo = await db.one(`SELECT 1 FROM repos WHERE project_id = $1`, [project.id]);

    // Order matters. Recordings and the lexicon both have to exist before an
    // investigation can narrow anything, and the queue runs in insertion
    // order, so enqueueing them in this sequence is the scheduling.
    if (hasPostHog) await enqueue(project.id, "import_posthog", { limit: 100, afterDays: 30 });
    if (hasRepo) {
      await enqueue(project.id, "sync_repo", { sinceDays: 30 });
      await enqueue(project.id, "index_repo");
    }
    // Market research runs before the investigation so a finding can be
    // published with its context already attached rather than appearing bare
    // and gaining it minutes later.
    await enqueue(project.id, "research_market");
    await enqueue(project.id, "investigate", {
      limit: 5,
      ...(oneShotKey ? { apiKey: encrypt(oneShotKey) } : {}),
    });
    ensureWorker();
  }

  return NextResponse.json({
    connected,
    errors,
    ok: Object.keys(errors).length === 0,
  });
}
