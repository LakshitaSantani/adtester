import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { getSecret, maskKey } from "@/lib/secrets";
import { ensureWorker } from "@/lib/worker";
import SetupForm, { type SetupState } from "./SetupForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SetupPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  ensureWorker();
  const db = await getDb();

  const project = await db.one<{ id: string; name: string; install_key: string }>(
    `SELECT id, name, install_key FROM projects WHERE view_token = $1`,
    [token],
  );
  if (!project) notFound();

  const posthog = await db.one<{ config: Record<string, unknown> | string }>(
    `SELECT config FROM data_sources WHERE project_id = $1 AND kind = 'posthog'`,
    [project.id],
  );
  const phConfig = posthog
    ? ((typeof posthog.config === "string"
        ? JSON.parse(posthog.config)
        : posthog.config) as { host?: string; projectId?: string })
    : null;

  const repo = await db.one<{ owner: string; name: string }>(
    `SELECT owner, name FROM repos WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
    [project.id],
  );

  const documents = await db.query<{ title: string | null }>(
    `SELECT title FROM documents WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 12`,
    [project.id],
  );

  const [counts] = await db.query<{ sessions: number }>(
    `SELECT COUNT(*)::int AS sessions FROM sessions WHERE project_id = $1`,
    [project.id],
  );

  const anthropic = await getSecret(project.id, "anthropic");
  const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:3000";

  const state: SetupState = {
    posthog: {
      connected: Boolean(posthog),
      host: phConfig?.host ?? null,
      projectId: phConfig?.projectId ?? null,
    },
    repo: {
      connected: Boolean(repo),
      label: repo ? `${repo.owner}/${repo.name}` : null,
    },
    anthropic: { connected: Boolean(anthropic), hint: maskKey(anthropic) },
    documents: {
      count: documents.length,
      titles: documents.map((d) => d.title ?? "Untitled").slice(0, 6),
    },
    sessions: counts?.sessions ?? 0,
    installSnippet: `<script src="${origin}/rec.js"\n        data-swy-key="${project.install_key}"\n        data-swy-release="YOUR_GIT_SHA" async></script>`,
  };

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <span className="small">
          <span className="muted">setup · </span>
          <Link href={`/p/${token}/reports`}>reports</Link>
          <span className="muted"> · </span>
          <Link href={`/p/${token}`}>sessions</Link>
        </span>
      </header>

      <h1>Connect your data</h1>
      <p className="lede">
        Four things, two of them required. Then it works out what broke, which change caused
        it, and what to do about it.
      </p>

      <SetupForm token={token} state={state} />
    </div>
  );
}
