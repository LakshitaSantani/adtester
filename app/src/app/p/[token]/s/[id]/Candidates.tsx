import { candidatesForSession } from "@/lib/candidates";

/**
 * The phase 3 payoff, rendered.
 *
 * Shows the narrowing as a funnel — everything that shipped, then what this
 * page's code actually reaches — because the number that matters isn't how
 * many suspects there are, it's how many were ruled out and why.
 *
 * Nothing here involves a model. It is entirely database queries over exact
 * edges: a build stamp, a route pattern, an import graph, and a file list.
 */
export default async function Candidates({ sessionId }: { sessionId: string }) {
  const result = await candidatesForSession(sessionId);
  if (!result) return null;

  const { deployedInWindow, candidates, reachableFiles, matchedRoutes, note } = result;

  return (
    <>
      <h2>Candidate changes</h2>
      <p className="lede">
        Commits deployed in the seven days before this session that touch code this page
        actually reaches.
      </p>

      {deployedInWindow > 0 && (
        <div className="funnel">
          <div className="funnel-step">
            <span className="n">{deployedInWindow}</span>
            <span className="l">shipped in the window</span>
          </div>
          <div className="funnel-step">
            <span className="n">{matchedRoutes.length}</span>
            <span className="l">routes matched {result.path ?? ""}</span>
          </div>
          <div className="funnel-step">
            <span className="n">{reachableFiles.length}</span>
            <span className="l">files reachable</span>
          </div>
          <div className="funnel-step final">
            <span className="n">{candidates.length}</span>
            <span className="l">candidates left</span>
          </div>
        </div>
      )}

      {note && (
        <div className="note">
          {note}
          {deployedInWindow === 0 && (
            <>
              {" "}
              Once a repository is connected, this panel narrows those commits down to the
              ones that could actually have affected this page.
            </>
          )}
        </div>
      )}

      {candidates.map((c) => (
        <div className="candidate" key={c.sha}>
          <div className="candidate-head">
            <span className="candidate-sha">{c.sha.slice(0, 8)}</span>
            <span className="candidate-msg">{c.message.slice(0, 100)}</span>
          </div>
          <div className="candidate-meta">
            {c.author ?? "unknown author"}
            {c.prNumber ? ` · PR #${c.prNumber}` : ""}
            {" · "}
            {c.deployedAt
              ? `deployed ${new Date(c.deployedAt).toLocaleString()}`
              : "deploy time unknown"}
            {" · "}
            {c.matchedFiles.length} of {c.filesTouchedCount} changed files are on this page&apos;s
            path
          </div>
          <div className="candidate-files">
            {c.matchedFiles.slice(0, 6).map((f) => (
              <span key={f}>{f}</span>
            ))}
            {c.matchedFiles.length > 6 && (
              <span className="muted">+{c.matchedFiles.length - 6} more</span>
            )}
          </div>
        </div>
      ))}

      {candidates.length > 1 && (
        <div className="note">
          <b>{candidates.length} candidates is not an answer.</b> Phase 4 separates them with
          the counterfactual — comparing how this signature behaves on builds that carry each
          change against builds that don&apos;t.
        </div>
      )}
    </>
  );
}
