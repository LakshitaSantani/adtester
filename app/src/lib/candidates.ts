/**
 * Narrowing suspects with queries alone.
 *
 * This is the phase 3 deliverable and the load-bearing idea of the whole
 * product: given a session, list the commits that could plausibly have
 * affected it — using nothing but exact edges. No model, no embeddings, no
 * guessing. Just: what shipped before this, and does it touch code this page
 * actually reaches?
 *
 * Getting from forty candidates to three here is what makes the expensive
 * reasoning in later phases both affordable and accurate. A model handed
 * forty diffs will always find a story; handed three, it can do real work.
 */

import { getDb } from "./db";
import { routeMatches } from "./lexicon";

/** How far back to look for changes that could explain a session. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * How far back to look when a commit has no deploy time.
 *
 * Seven days is the right window for "when did this ship", and the wrong one
 * for "when was this written". A team without release tagging in CI leaves
 * deployed_at null and the query falls back to authored_at — so a commit
 * written on a branch ten days ago, reviewed, merged and shipped yesterday
 * falls outside a seven-day window and never becomes a candidate at all. The
 * investigation then reports that nothing touching this page shipped
 * recently, which is false, and which no reader can tell is false.
 *
 * Author dates are a poor proxy for deploy dates, so this buys coverage with
 * precision: the pool gets wider and the counterfactual has to do more of the
 * work. That is the right way round. A candidate that was never considered
 * cannot be ruled out by any amount of later evidence.
 */
const UNDATED_WINDOW_DAYS = 30;

/**
 * How many import hops out from the route file we consider "reachable".
 * Three covers page -> feature component -> shared helper, which is where
 * most real bugs live. Deeper and nearly every file in the repo becomes
 * reachable, which defeats the point of filtering.
 */
const MAX_IMPORT_DEPTH = 3;

export type Candidate = {
  sha: string;
  message: string;
  author: string | null;
  deployedAt: string | null;
  authoredAt: string | null;
  prNumber: number | null;
  prTitle: string | null;
  /** The reachable files this commit touched — the reason it's a suspect. */
  matchedFiles: string[];
  filesTouchedCount: number;
  /**
   * Which evidence chain connects this change to the symptom.
   *
   * "api" means it was reached from an endpoint the session called and got an
   * error from; "route" means it was reached through the page's imports. For a
   * failed request those are not equally good explanations — the response came
   * from the server, and a client-side file cannot make a server return 500.
   */
  reachedVia: "route" | "api" | "both";
};

export type CandidateResult = {
  sessionId: string;
  path: string | null;
  /** Route patterns from the lexicon that matched this session's URL. */
  matchedRoutes: string[];
  /** Endpoints the session called that failed, and we could place in the repo. */
  matchedApiRoutes: string[];
  /** Files reachable from those routes, within MAX_IMPORT_DEPTH. */
  reachableFiles: string[];
  /** Everything deployed in the window, before code-path filtering. */
  deployedInWindow: number;
  candidates: Candidate[];
  /** Set when we can't narrow — the caller should say so rather than guess. */
  note: string | null;
};

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname || "/";
  } catch {
    return null;
  }
}

/**
 * Walk the import graph outward from a set of entry files.
 *
 * Breadth-first with a depth cap and a visited set, so a cyclic import graph
 * (which every real codebase has) terminates.
 */
async function reachableFrom(
  projectId: string,
  entries: string[],
  maxDepth = MAX_IMPORT_DEPTH,
): Promise<string[]> {
  const db = await getDb();
  const seen = new Set<string>(entries);
  let frontier = entries;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const rows = await db.query<{ to_path: string }>(
      `SELECT DISTINCT to_path FROM code_edges
        WHERE project_id = $1 AND from_path = ANY($2::text[])`,
      [projectId, frontier],
    );

    const next: string[] = [];
    for (const row of rows) {
      if (seen.has(row.to_path)) continue;
      seen.add(row.to_path);
      next.push(row.to_path);
    }
    frontier = next;
  }

  return Array.from(seen);
}

export async function candidatesForSession(
  sessionId: string,
  {
    windowDays = DEFAULT_WINDOW_DAYS,
    path: explicitPath,
  }: { windowDays?: number; path?: string | null } = {},
): Promise<CandidateResult | null> {
  const db = await getDb();

  const session = await db.one<{
    id: string;
    project_id: string;
    entry_url: string | null;
    started_at: string;
    release: string | null;
    api_paths: string[];
  }>(
    `SELECT id, project_id, entry_url, started_at, release, api_paths
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!session) return null;

  // The page the problem happened on, when the caller knows it. Falling back
  // to the entry URL is only right for a multi-page site: in a single-page app
  // somebody lands on the homepage and clicks through, so the entry URL sends
  // this looking at code the failure never touched.
  const path = explicitPath ?? pathOf(session.entry_url);

  const base: CandidateResult = {
    sessionId,
    path,
    matchedRoutes: [],
    matchedApiRoutes: [],
    reachableFiles: [],
    deployedInWindow: 0,
    candidates: [],
    note: null,
  };

  // Everything that shipped in the window, regardless of what it touched.
  // This is the "before" number — the pile we're trying to shrink.
  const inWindow = await db.query<{
    sha: string;
    message: string;
    author: string | null;
    deployed_at: string | null;
    authored_at: string | null;
    pr_number: number | null;
    pr_title: string | null;
    files_touched: string[];
  }>(
    `SELECT sha, message, author, deployed_at, authored_at, pr_number, pr_title, files_touched
       FROM commits
      WHERE project_id = $1
        AND COALESCE(deployed_at, authored_at) <= $2::timestamptz
        AND CASE
              WHEN deployed_at IS NOT NULL
                THEN deployed_at >= $2::timestamptz - ($3 || ' days')::interval
              ELSE authored_at >= $2::timestamptz - ($4 || ' days')::interval
            END
      ORDER BY COALESCE(deployed_at, authored_at) DESC`,
    [
      session.project_id,
      session.started_at,
      String(windowDays),
      String(Math.max(windowDays, UNDATED_WINDOW_DAYS)),
    ],
  );

  base.deployedInWindow = inWindow.length;

  if (inWindow.length === 0) {
    base.note = "No commits recorded in the window. Connect a repository, or sync it.";
    return base;
  }

  if (!path) {
    base.note = "This session has no entry URL, so its code path can't be resolved.";
    return base;
  }

  // Which route in the lexicon does this URL correspond to?
  const routes = await db.query<{ path: string; route: string }>(
    `SELECT path, route FROM code_entities
      WHERE project_id = $1 AND kind = 'route' AND route IS NOT NULL`,
    [session.project_id],
  );

  const matched = routes.filter((r) => routeMatches(r.route, path));
  base.matchedRoutes = matched.map((r) => r.route);

  // Endpoints this session called that failed. A page reaches its own files
  // through imports, but a backend handler is only ever reached over the
  // network — so without this a server-side regression looks like "nothing
  // that shipped touches this page", which reads as an exoneration of code
  // nobody actually examined.
  const apiEntities =
    (session.api_paths ?? []).length > 0
      ? await db.query<{ path: string; route: string }>(
          `SELECT path, route FROM code_entities
            WHERE project_id = $1 AND kind = 'api' AND route IS NOT NULL`,
          [session.project_id],
        )
      : [];

  const matchedApis = apiEntities.filter((entity) =>
    (session.api_paths ?? []).some((called) => routeMatches(entity.route, called)),
  );
  base.matchedApiRoutes = matchedApis.map((r) => r.route);

  if (matched.length === 0 && matchedApis.length === 0) {
    // Better to say we can't narrow than to fall back to "everything that
    // shipped" and let the caller mistake it for a filtered result.
    base.note =
      routes.length === 0
        ? "No routes indexed yet. Run a repository sync to build the lexicon."
        : (session.api_paths ?? []).length > 0
          ? `No indexed route matches ${path}, and none of the endpoints this ` +
            `session called (${(session.api_paths ?? []).slice(0, 3).join(", ")}) ` +
            `matched a handler in the repository either.`
          : `No indexed route matches ${path}, so the code path can't be narrowed.`;
    return base;
  }

  // Kept apart rather than merged, because which chain reached a file is
  // itself evidence about what could have caused what.
  const [fromRoutes, fromApis] = await Promise.all([
    matched.length > 0
      ? reachableFrom(session.project_id, matched.map((r) => r.path))
      : Promise.resolve([]),
    matchedApis.length > 0
      ? reachableFrom(session.project_id, matchedApis.map((r) => r.path))
      : Promise.resolve([]),
  ]);

  const routeSet = new Set(fromRoutes);
  const apiSet = new Set(fromApis);
  const reachable = [...new Set([...fromRoutes, ...fromApis])];
  base.reachableFiles = reachable;

  const reachableSet = new Set(reachable);

  base.candidates = inWindow
    .map((c) => {
      const matchedFiles = (c.files_touched ?? []).filter((f) => reachableSet.has(f));
      const viaApi = matchedFiles.some((f) => apiSet.has(f));
      const viaRoute = matchedFiles.some((f) => routeSet.has(f));
      return {
        reachedVia: (viaApi && viaRoute ? "both" : viaApi ? "api" : "route") as Candidate["reachedVia"],
        sha: c.sha,
        message: c.message.split("\n")[0],
        author: c.author,
        deployedAt: c.deployed_at,
        authoredAt: c.authored_at,
        prNumber: c.pr_number,
        prTitle: c.pr_title,
        matchedFiles,
        filesTouchedCount: (c.files_touched ?? []).length,
      };
    })
    .filter((c) => c.matchedFiles.length > 0);

  if (base.candidates.length === 0) {
    const reach =
      matchedApis.length > 0
        ? "code this page reaches, or the endpoints it called"
        : "code this page reaches";
    base.note = `${inWindow.length} commits shipped in the window, but none touched ${reach}.`;
  }

  return base;
}
