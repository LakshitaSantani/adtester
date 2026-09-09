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
};

export type CandidateResult = {
  sessionId: string;
  path: string | null;
  /** Route patterns from the lexicon that matched this session's URL. */
  matchedRoutes: string[];
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
  }>(
    `SELECT id, project_id, entry_url, started_at, release FROM sessions WHERE id = $1`,
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
        AND COALESCE(deployed_at, authored_at) >= $2::timestamptz - ($3 || ' days')::interval
      ORDER BY COALESCE(deployed_at, authored_at) DESC`,
    [session.project_id, session.started_at, String(windowDays)],
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

  if (matched.length === 0) {
    // Better to say we can't narrow than to fall back to "everything that
    // shipped" and let the caller mistake it for a filtered result.
    base.note =
      routes.length === 0
        ? "No routes indexed yet. Run a repository sync to build the lexicon."
        : `No indexed route matches ${path}, so the code path can't be narrowed.`;
    return base;
  }

  const reachable = await reachableFrom(
    session.project_id,
    matched.map((r) => r.path),
  );
  base.reachableFiles = reachable;

  const reachableSet = new Set(reachable);

  base.candidates = inWindow
    .map((c) => {
      const matchedFiles = (c.files_touched ?? []).filter((f) => reachableSet.has(f));
      return {
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
    base.note = `${inWindow.length} commits shipped in the window, but none touched code this page reaches.`;
  }

  return base;
}
