import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveProject } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ensureWorker } from "@/lib/worker";
import RunInvestigation from "./RunInvestigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InvestigationRow = {
  id: string;
  symptom: string;
  symptom_started: string | null;
  status: string;
  claim: string | null;
  commit_sha: string | null;
  confidence: number | null;
  declined_reason: string | null;
  created_at: string;
};

const DECLINE_LABEL: Record<string, string> = {
  diffuse: "too widespread to pin down",
  no_route: "this page's code wasn't found",
  no_candidates: "nothing shipped that touches this page",
  tied_candidates: "candidates couldn't be separated",
  low_confidence: "evidence too thin",
};

function band(confidence: number): { label: string; cls: string } {
  if (confidence >= 0.8) return { label: "high", cls: "high" };
  if (confidence >= 0.6) return { label: "moderate", cls: "mid" };
  return { label: "low", cls: "low" };
}

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  ensureWorker();
  const db = await getDb();

  const project = await resolveProject(token, "view");
  if (!project) notFound();

  const investigations = await db.query<InvestigationRow>(
    `SELECT id, symptom, symptom_started, status, claim, commit_sha,
            confidence, declined_reason, created_at
       FROM investigations
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [project.id],
  );

  // How often a claim at a given confidence turned out to be right. The
  // whole argument for the product rests on this being honest, and it can
  // only be answered after somebody has judged a few.
  const scored = await db.query<{ confidence: number; was_correct: boolean }>(
    `SELECT i.confidence, f.was_correct
       FROM investigations i
       JOIN feedback f ON f.investigation_id = i.id
      WHERE i.project_id = $1 AND i.confidence IS NOT NULL`,
    [project.id],
  );

  const bands = [
    { label: "0.80 and up", min: 0.8, max: 1.01 },
    { label: "0.60 – 0.79", min: 0.6, max: 0.8 },
    { label: "below 0.60", min: 0, max: 0.6 },
  ].map((b) => {
    const rows = scored.filter((s) => s.confidence >= b.min && s.confidence < b.max);
    const right = rows.filter((s) => s.was_correct).length;
    return { ...b, total: rows.length, right };
  });

  const claimed = investigations.filter((i) => i.status === "claimed");
  const declined = investigations.filter((i) => i.status === "declined");

  return (
    <div className="wrap wide">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <span className="small">
          <Link href={`/p/${token}`}>sessions</Link>
          <span className="muted"> · </span>
          <Link href={`/p/${token}/code`}>code</Link>
          <span className="muted"> · reports</span>
        </span>
      </header>

      <h1>Reports</h1>
      <p className="lede">
        Something started going wrong, and this is what the evidence says caused it — or an
        honest account of why it can&apos;t say.
      </p>

      <RunInvestigation token={token} />

      {scored.length > 0 && (
        <>
          <h2>How often it&apos;s right</h2>
          <p className="lede small">
            Every claim below was scored before anyone knew the answer. {scored.length} have
            been judged so far.
          </p>
          <div className="tablecard" style={{ marginBottom: 18 }}>
            <table>
              <thead>
                <tr>
                  <th>Confidence said</th>
                  <th className="right">Judged</th>
                  <th className="right">Right</th>
                  <th className="right">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.label}>
                    <td className="mono small">{b.label}</td>
                    <td className="right mono small">{b.total}</td>
                    <td className="right mono small">{b.right}</td>
                    <td className="right mono small">
                      {b.total === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        `${Math.round((b.right / b.total) * 100)}%`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {investigations.length > 0 && (
        <p className="small muted" style={{ marginBottom: 18 }}>
          <a href={`/api/export?t=${token}`} download>
            Download the results
          </a>{" "}
          — findings, scores and verdicts as JSON. No credentials, no recordings, no
          document text, so it is safe to send on.
        </p>
      )}

      {investigations.length === 0 ? (
        <div className="card empty">
          <strong>Nothing investigated yet</strong>
          Reports appear when a signature starts happening that wasn&apos;t happening before.
          That needs sessions carrying a build, and a repository connected.
        </div>
      ) : (
        <>
          {claimed.length > 0 && <h2>Findings</h2>}
          {claimed.map((inv) => {
            const b = band(inv.confidence ?? 0);
            return (
              <Link key={inv.id} href={`/p/${token}/reports/${inv.id}`} className="report-card">
                <div className="report-top">
                  <span className="report-symptom">{inv.symptom}</span>
                  <span className={`conf ${b.cls}`}>
                    {(inv.confidence ?? 0).toFixed(2)} · {b.label}
                  </span>
                </div>
                <div className="report-claim">{inv.claim}</div>
                <div className="report-meta">
                  {inv.commit_sha ? `${inv.commit_sha.slice(0, 8)} · ` : ""}
                  {new Date(inv.created_at).toLocaleString()}
                </div>
              </Link>
            );
          })}

          {declined.length > 0 && (
            <>
              <h2>Declined to answer</h2>
              <p className="lede small">
                These are not failures. A product that always answers is a product that is
                often wrong.
              </p>
              {declined.map((inv) => (
                <Link
                  key={inv.id}
                  href={`/p/${token}/reports/${inv.id}`}
                  className="report-card declined"
                >
                  <div className="report-top">
                    <span className="report-symptom">{inv.symptom}</span>
                    <span className="conf none">
                      {DECLINE_LABEL[inv.declined_reason ?? ""] ?? "declined"}
                    </span>
                  </div>
                  <div className="report-claim muted">{inv.claim}</div>
                  <div className="report-meta">
                    {new Date(inv.created_at).toLocaleString()}
                  </div>
                </Link>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
