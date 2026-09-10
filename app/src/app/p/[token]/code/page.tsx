import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveProject } from "@brain/auth";
import { getDb } from "@brain/db";
import { ensureWorker } from "@/lib/worker";
import ConnectRepo from "./ConnectRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function when(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function CodePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Picks up anything left pending by a restart.
  ensureWorker();
  const db = await getDb();

  const project = await resolveProject(token, "view");
  if (!project) notFound();

  const repo = await db.one<{
    owner: string;
    name: string;
    default_branch: string;
    last_synced_at: string | null;
    last_error: string | null;
  }>(
    `SELECT owner, name, default_branch, last_synced_at, last_error
       FROM repos WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
    [project.id],
  );

  const [counts] = await db.query<{
    commits: string;
    deployed: string;
    files: string;
    routes: string;
    edges: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM commits WHERE project_id = $1) AS commits,
       (SELECT COUNT(*) FROM commits WHERE project_id = $1 AND deployed_at IS NOT NULL) AS deployed,
       (SELECT COUNT(*) FROM code_entities WHERE project_id = $1) AS files,
       (SELECT COUNT(*) FROM code_entities WHERE project_id = $1 AND route IS NOT NULL) AS routes,
       (SELECT COUNT(*) FROM code_edges WHERE project_id = $1) AS edges`,
    [project.id],
  );

  const jobs = await db.query<{
    kind: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
  }>(
    `SELECT kind, status, attempts, last_error, created_at
       FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [project.id],
  );

  const routes = await db.query<{ route: string; path: string }>(
    `SELECT route, path FROM code_entities
      WHERE project_id = $1 AND route IS NOT NULL
      ORDER BY route LIMIT 40`,
    [project.id],
  );

  const commits = await db.query<{
    sha: string;
    message: string;
    author: string | null;
    deployed_at: string | null;
    authored_at: string | null;
    files_touched: string[];
  }>(
    `SELECT sha, message, author, deployed_at, authored_at, files_touched
       FROM commits WHERE project_id = $1
      ORDER BY COALESCE(deployed_at, authored_at) DESC LIMIT 15`,
    [project.id],
  );

  const working = jobs.some((j) => j.status === "pending" || j.status === "running");

  return (
    <div className="wrap wide">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <span className="small">
          <Link href={`/p/${token}`}>sessions</Link>
          <span className="muted"> · code · </span>
          <Link href={`/p/${token}/reports`}>reports</Link>
        </span>
      </header>

      <h1>Code</h1>
      <p className="lede">
        One GitHub connection gives two things: the commit history, and the codebase itself.
        The second is what lets a session&apos;s URL point at the files that serve it.
      </p>

      <ConnectRepo token={token} existing={repo ? { owner: repo.owner, name: repo.name } : null} />

      {repo && (
        <>
          {repo.last_error && (
            <div className="note warn">
              <b>Last sync failed.</b> {repo.last_error}
            </div>
          )}

          {working && (
            <div className="note">
              <b>Working…</b> Syncing commits and indexing the codebase. Refresh in a moment.
            </div>
          )}

          <div className="statgrid">
            <div className="stat">
              <span className="stat-n">{counts?.commits ?? 0}</span>
              <span className="stat-l">commits</span>
            </div>
            <div className="stat">
              <span className="stat-n">{counts?.deployed ?? 0}</span>
              <span className="stat-l">with a deploy time</span>
            </div>
            <div className="stat">
              <span className="stat-n">{counts?.files ?? 0}</span>
              <span className="stat-l">files indexed</span>
            </div>
            <div className="stat">
              <span className="stat-n">{counts?.routes ?? 0}</span>
              <span className="stat-l">routes</span>
            </div>
            <div className="stat">
              <span className="stat-n">{counts?.edges ?? 0}</span>
              <span className="stat-l">imports mapped</span>
            </div>
            <div className="stat">
              <span className="stat-n small mono" style={{ fontSize: 15 }}>
                {when(repo.last_synced_at)}
              </span>
              <span className="stat-l">last synced</span>
            </div>
          </div>

          {Number(counts?.deployed ?? 0) === 0 && Number(counts?.commits ?? 0) > 0 && (
            <div className="note">
              <b>No deploy times yet.</b> They get filled in two ways: from GitHub
              Deployments if your pipeline publishes them, or — more usefully — from the
              first session that reports each build. That second one needs sessions
              carrying <code>data-swy-release</code>.
            </div>
          )}

          <h2>Routes</h2>
          {routes.length === 0 ? (
            <div className="card empty">
              <strong>No routes found</strong>
              The indexer knows Next.js (app and pages), SvelteKit and Remix conventions. If
              this repo uses something else, routes need a new rule in{" "}
              <code>routeForPath</code>.
            </div>
          ) : (
            <div className="tablecard">
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Served by</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r) => (
                    <tr key={r.path}>
                      <td className="mono small">{r.route}</td>
                      <td className="mono small muted">{r.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>Recent commits</h2>
          {commits.length === 0 ? (
            <div className="card empty">
              <strong>No commits yet</strong>
              The first sync pulls the last 30 days.
            </div>
          ) : (
            <div className="tablecard">
              <table>
                <thead>
                  <tr>
                    <th>Commit</th>
                    <th>Message</th>
                    <th>Author</th>
                    <th>Deployed</th>
                    <th className="right">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {commits.map((c) => (
                    <tr key={c.sha}>
                      <td className="mono small">{c.sha.slice(0, 8)}</td>
                      <td className="small">{c.message.split("\n")[0].slice(0, 80)}</td>
                      <td className="small muted">{c.author ?? "—"}</td>
                      <td className="small mono">
                        {c.deployed_at ? (
                          when(c.deployed_at)
                        ) : (
                          <span className="muted">unknown</span>
                        )}
                      </td>
                      <td className="right mono small">{c.files_touched?.length ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {jobs.length > 0 && (
            <>
              <h2>Recent jobs</h2>
              <div className="tablecard">
                <table>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j, i) => (
                      <tr key={i}>
                        <td className="mono small">{j.kind}</td>
                        <td className="small">
                          <span className={`pill job-${j.status}`}>{j.status}</span>
                        </td>
                        <td className="mono small right">{j.attempts}</td>
                        <td className="small muted">{j.last_error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
