import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@brain/db";
import Candidates from "./Candidates";
import Player from "./Player";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  release: string | null;
  started_at: string;
  last_event_at: string;
  closed_at: string | null;
  close_reason: string | null;
  entry_url: string | null;
  user_agent: string | null;
  language: string | null;
  time_zone: string | null;
  viewport_width: number | null;
  viewport_height: number | null;
  event_count: number;
  signatures: string[];
  error_count: number;
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ token: string; id: string }>;
}) {
  const { token, id } = await params;
  const db = await getDb();

  const session = await db.one<Row>(
    `SELECT s.id, s.release, s.started_at, s.last_event_at, s.closed_at,
            s.close_reason, s.entry_url, s.user_agent, s.language, s.time_zone,
            s.viewport_width, s.viewport_height, s.event_count, s.signatures,
            s.error_count
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1 AND (p.view_token = $2 OR p.admin_token = $2)`,
    [id, token],
  );
  if (!session) notFound();

  const seconds = Math.round(
    (new Date(session.closed_at ?? session.last_event_at).getTime() -
      new Date(session.started_at).getTime()) /
      1000,
  );

  return (
    <div className="wrap wide">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <Link href={`/p/${token}`} className="small">
          ← all sessions
        </Link>
      </header>

      <h1>Session {session.id.slice(0, 8)}</h1>
      <p className="lede">
        {new Date(session.started_at).toLocaleString()} · {seconds}s ·{" "}
        {session.event_count} events
        {session.release ? (
          <>
            {" "}
            · build <span className="pill release">{session.release.slice(0, 8)}</span>
          </>
        ) : null}
      </p>

      {session.signatures.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {session.signatures.map((sig) => (
            <span key={sig} className={`pill ${sig}`}>
              {sig.replace("_", " ")}
            </span>
          ))}
        </div>
      )}

      <Player sessionId={session.id} token={token} />

      <Candidates sessionId={session.id} />

      <h2>Details</h2>
      <div className="tablecard">
        <table>
          <tbody>
            <tr>
              <th style={{ width: 200 }}>Entry page</th>
              <td className="mono small">{session.entry_url ?? "—"}</td>
            </tr>
            <tr>
              <th>Build</th>
              <td className="mono small">
                {session.release ?? (
                  <span className="muted">
                    not set — this session can&apos;t be linked to a code change
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Viewport</th>
              <td className="mono small">
                {session.viewport_width ?? "?"} × {session.viewport_height ?? "?"}
              </td>
            </tr>
            <tr>
              <th>Locale</th>
              <td className="mono small">
                {session.language ?? "—"} · {session.time_zone ?? "—"}
              </td>
            </tr>
            <tr>
              <th>Ended</th>
              <td className="mono small">
                {session.closed_at
                  ? `${new Date(session.closed_at).toLocaleTimeString()} (${session.close_reason ?? "closed"})`
                  : "still open, or ended without a goodbye"}
              </td>
            </tr>
            <tr>
              <th>User agent</th>
              <td className="mono small" style={{ wordBreak: "break-all" }}>
                {session.user_agent ?? "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
