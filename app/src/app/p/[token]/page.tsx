import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveProject } from "@brain/auth";
import { getDb } from "@brain/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionRow = {
  id: string;
  release: string | null;
  started_at: string;
  last_event_at: string;
  closed_at: string | null;
  entry_url: string | null;
  user_agent: string | null;
  event_count: number;
  byte_count: string | number;
  signatures: string[];
  error_count: number;
};

function browser(ua: string | null): string {
  if (!ua) return "unknown";
  if (/edg\//i.test(ua)) return "Edge";
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/safari/i.test(ua)) return "Safari";
  return "other";
}

function duration(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function when(iso: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function path(url: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

export default async function Dashboard({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = await getDb();

  const project = await resolveProject(token, "view");
  if (!project) notFound();

  const sessions = await db.query<SessionRow>(
    `SELECT id, release, started_at, last_event_at, closed_at, entry_url,
            user_agent, event_count, byte_count, signatures, error_count
       FROM sessions
      WHERE project_id = $1
      ORDER BY started_at DESC
      LIMIT 200`,
    [project.id],
  );

  const interesting = sessions.filter((s) => s.signatures.length > 0);

  return (
    <div className="wrap wide">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <span className="small">
          <span className="muted">sessions · </span>
          <Link href={`/p/${token}/code`}>code</Link>
          <span className="muted"> · </span>
          <Link href={`/p/${token}/reports`}>reports</Link>
        </span>
      </header>

      <h1>Sessions</h1>
      <p className="lede">
        {sessions.length === 0
          ? "Nothing recorded yet."
          : `${sessions.length} recorded${
              interesting.length > 0
                ? ` · ${interesting.length} worth a look`
                : ""
            }.`}
      </p>

      {sessions.length === 0 ? (
        <div className="card empty">
          <strong>Waiting for the first session</strong>
          Paste the snippet into a page and load it. Recordings appear here within about ten
          seconds.
          <pre className="snippet" style={{ marginTop: 20, textAlign: "left" }}>
            {`<script src="/rec.js" data-swy-key="${project.installKey}" async></script>`}
          </pre>
        </div>
      ) : (
        <div className="tablecard">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Length</th>
                <th>Page</th>
                <th>Build</th>
                <th>Browser</th>
                <th className="right">Events</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/p/${token}/s/${s.id}`}>{when(s.started_at)}</Link>
                  </td>
                  <td className="mono small">
                    {duration(s.started_at, s.closed_at ?? s.last_event_at)}
                  </td>
                  <td className="mono small">{path(s.entry_url)}</td>
                  <td>
                    {s.release ? (
                      <span className="pill release">{s.release.slice(0, 8)}</span>
                    ) : (
                      <span className="muted small">not set</span>
                    )}
                  </td>
                  <td className="small">{browser(s.user_agent)}</td>
                  <td className="right mono small">{s.event_count}</td>
                  <td>
                    {s.signatures.length === 0 ? (
                      <span className="muted small">—</span>
                    ) : (
                      s.signatures.map((sig) => (
                        <span key={sig} className={`pill ${sig}`}>
                          {sig.replace("_", " ")}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sessions.length > 0 && sessions.every((s) => !s.release) && (
        <div className="note warn">
          <b>No build set on any session.</b> Add <code>data-swy-release</code> to the script
          tag with your git SHA. Until then these recordings can&apos;t be linked to code
          changes, and that link is the whole point of what comes next.
        </div>
      )}
    </div>
  );
}
