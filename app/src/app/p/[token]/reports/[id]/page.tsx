import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import Verdict from "./Verdict";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EvidenceRow = {
  id: string;
  kind: string;
  ref: string | null;
  quote: string | null;
  detail: Record<string, unknown> | string;
  contribution: number | null;
};

const DECLINE_EXPLAIN: Record<string, string> = {
  diffuse:
    "The symptom appears on too many different pages to be traced to the code behind any one of them.",
  no_route:
    "The code behind this page was never found, so nothing could be ruled in or out. " +
    "Usually the repository doesn't serve this URL, or its framework isn't one the " +
    "indexer recognises yet.",
  no_candidates:
    "Nothing that shipped in the window touches code this page reaches.",
  tied_candidates:
    "More than one change fits the evidence equally well, and separating them would be a guess.",
  low_confidence: "A leading candidate exists, but the evidence behind it is too thin to assert.",
};

function parse(detail: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof detail === "string") {
    try {
      return JSON.parse(detail) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return detail ?? {};
}

export default async function ReportPage({
  params,
}: {
  params: Promise<{ token: string; id: string }>;
}) {
  const { token, id } = await params;
  const db = await getDb();

  const inv = await db.one<{
    id: string;
    symptom: string;
    symptom_started: string | null;
    status: string;
    claim: string | null;
    commit_sha: string | null;
    confidence: number | null;
    declined_reason: string | null;
    created_at: string;
  }>(
    `SELECT i.* FROM investigations i
       JOIN projects p ON p.id = i.project_id
      WHERE i.id = $1 AND (p.view_token = $2 OR p.admin_token = $2)`,
    [id, token],
  );
  if (!inv) notFound();

  const verdict = await db.one<{ was_correct: boolean; note: string | null }>(
    `SELECT was_correct, note FROM feedback WHERE investigation_id = $1`,
    [id],
  );

  const evidence = await db.query<EvidenceRow>(
    `SELECT id, kind, ref, quote, detail, contribution
       FROM evidence WHERE investigation_id = $1`,
    [id],
  );

  const sessions = evidence.filter((e) => e.kind === "session");
  const intent = evidence.filter((e) => e.kind === "prd" || e.kind === "transcript");
  const analysis = evidence.find((e) => e.kind === "analysis");
  const a = analysis ? parse(analysis.detail) : null;
  const fix = (a?.fix ?? null) as Record<string, unknown> | null;
  const commits = evidence
    .filter((e) => e.kind === "commit")
    .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0));

  const signalsFor = (sha: string) =>
    evidence.filter(
      (e) => (e.kind === "signal" || e.kind === "counterfactual") && e.ref === sha,
    );

  const winner = inv.commit_sha;
  const capped = commits.some((c) => parse(c.detail).capped === true);

  return (
    <div className="wrap wide">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <Link href={`/p/${token}/reports`} className="small">
          ← all reports
        </Link>
      </header>

      <div className="report-head">
        <div className="eyebrow-line">{inv.symptom}</div>
        <h1>{inv.claim}</h1>
        {inv.status === "claimed" && (
          <div className="confidence-line">
            <span className="conf big">{(inv.confidence ?? 0).toFixed(2)}</span>
            <span className="muted small">
              confidence{capped ? " · capped, see below" : ""}
            </span>
          </div>
        )}
        {inv.status === "declined" && (
          <div className="note">
            <b>No answer given.</b>{" "}
            {DECLINE_EXPLAIN[inv.declined_reason ?? ""] ?? "The evidence didn't support a claim."}
          </div>
        )}
      </div>

      {a && (
        <>
          <h2>What happened</h2>
          <div className="analysis">
            <div className="analysis-row">
              <span className="analysis-label">The change</span>
              <p>{String(a.whatChanged ?? "")}</p>
            </div>
            <div className="analysis-row">
              <span className="analysis-label">How it broke</span>
              <p>{String(a.howItBroke ?? "")}</p>
            </div>
            <div className="analysis-row">
              <span className="analysis-label">What users hit</span>
              <p>{String(a.whatUsersHit ?? "")}</p>
            </div>
          </div>
        </>
      )}

      {fix && (
        <>
          <h2>Suggested fix</h2>
          <div className="analysis">
            <div className="analysis-row">
              <span className="analysis-label">{String(fix.path ?? "")}</span>
              <p>{String(fix.rationale ?? "")}</p>
            </div>
            {fix.patch ? (
              <pre className="snippet">{String(fix.patch)}</pre>
            ) : (
              <div className="note guard" style={{ margin: "10px 0 0" }}>
                <b>No patch offered.</b> {String(fix.caveat ?? "This needs a human decision.")}
              </div>
            )}
          </div>
        </>
      )}

      <h2>The evidence</h2>

      {sessions.length > 0 && (
        <div className="ev-block">
          <div className="ev-kind">Recordings</div>
          <div className="ev-body">
            {sessions.length} session{sessions.length > 1 ? "s" : ""} showing this. Watch one
            and see it happen:
            <div className="ev-links">
              {sessions.slice(0, 8).map((s) => (
                <Link key={s.id} href={`/p/${token}/s/${s.ref}`} className="mono small">
                  {String(s.ref).slice(0, 8)}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {intent.map((m) => {
        const d = parse(m.detail);
        const when = d.occurredAt ? String(d.occurredAt).slice(0, 10) : null;
        return (
          <div key={m.id} className="ev-block intent-block">
            <div className="ev-kind">
              {m.kind === "transcript" ? "Said in a meeting" : "Written in a PRD"}
              <span className="ev-score mono muted">explains</span>
            </div>
            <div className="ev-body">
              <blockquote className="intent-quote">{m.quote}</blockquote>
              <div className="candidate-meta">
                {d.speaker ? `${String(d.speaker)} · ` : ""}
                {String(d.title ?? "")}
                {when ? ` · ${when}` : ""}
                {d.kind ? ` · ${String(d.kind)}` : ""}
              </div>
              {d.relevance ? (
                <div className="small" style={{ marginTop: 6 }}>
                  {String(d.relevance)}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}

      {intent.length > 0 && (
        <div className="note guard">
          <b>This is context, not proof.</b> What the team meant to build does not move the
          confidence number by a single point. It explains how the change came to be written
          this way — which is usually what someone actually wants to know, and is exactly why
          it must not be allowed to make the score look stronger.
        </div>
      )}

      {commits.map((c) => {
        const detail = parse(c.detail);
        const isWinner = c.ref === winner;
        const matched = (detail.matchedFiles as string[]) ?? [];
        return (
          <div key={c.id} className={`ev-block candidate-block ${isWinner ? "winner" : ""}`}>
            <div className="ev-kind">
              {isWinner ? "Cause" : "Also considered"}
              <span className="ev-score mono">{(c.contribution ?? 0).toFixed(2)}</span>
            </div>
            <div className="ev-body">
              <div className="candidate-head">
                <span className="candidate-sha">{String(c.ref).slice(0, 8)}</span>
                <span className="candidate-msg">{c.quote}</span>
              </div>
              <div className="candidate-meta">
                {(detail.author as string) ?? "unknown"} ·{" "}
                {matched.length} of {String(detail.filesTouched ?? "?")} changed files on this
                page&apos;s path
              </div>
              <div className="candidate-files">
                {matched.slice(0, 5).map((f) => (
                  <span key={f}>{f}</span>
                ))}
              </div>

              <table className="signals">
                <tbody>
                  {signalsFor(String(c.ref)).map((s) => {
                    const sd = parse(s.detail);
                    const contribution = s.contribution ?? 0;
                    return (
                      <tr key={s.id}>
                        <th>{String(sd.label ?? sd.signal ?? "signal")}</th>
                        <td>{s.quote}</td>
                        <td
                          className={`mono right ${contribution < 0 ? "neg" : contribution > 0 ? "pos" : "muted"}`}
                        >
                          {contribution >= 0 ? "+" : ""}
                          {contribution.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <Verdict
        token={token}
        investigationId={inv.id}
        existing={
          verdict ? { wasCorrect: verdict.was_correct, note: verdict.note } : null
        }
      />

      <div className="note">
        <b>How to read the numbers.</b> Everything except the comparison is circumstantial —
        plenty of changes ship before a problem and touch code the page uses. Comparing users
        who got a change against users who didn&apos;t is what turns suspicion into evidence,
        and there are two ways to get those groups. When some users were on the old build
        while others had the new one, time is held constant and only the code differs: that
        can reach full confidence. When nobody stamped a build, the comparison is the same
        page before and after the deploy — which code each session ran is still certain, but
        anything else that changed that afternoon is mixed in, so it is capped at 0.85. With
        no comparison at all, the ceiling is 0.70.
      </div>
    </div>
  );
}
