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

import { getDb } from "@brain/db";
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
 * Hops that are always walked, whatever the graph looks like.
 *
 * Three covers page -> feature component -> shared helper, which is where
 * most real bugs live. It is a floor rather than a limit: walking fewer
 * would make the filter miss things it used to catch.
 */
const MIN_IMPORT_DEPTH = 3;

/**
 * Where the walk stops even if the graph is still selective.
 *
 * Only a termination guard for pathological graphs — the selectivity rule
 * below almost always stops first.
 */
const MAX_IMPORT_DEPTH = 8;

/**
 * The largest share of the repository the reachable set may grow to.
 *
 * The set exists to tell commits apart. A set holding most of the repository
 * tells them apart from nothing, so growing past this buys reach at the cost
 * of the only thing reach was for.
 *
 * This replaced a hard three-hop cutoff, which failed in both directions
 * depending on the repository it met. In a layered backend — handler ->
 * controller -> domain service -> client -> shared validator — the bug lives
 * five hops out and a three-hop walk pruned the culprit, reporting that
 * nothing shipped touched this page. In a densely shared frontend, three hops
 * already reach most of the tree and the filter was doing nothing. One
 * constant cannot be right for both, because the question is about the shape
 * of the graph rather than about a number of hops.
 */
const SELECTIVITY_LIMIT = 0.35;

/**
 * The reachable set is always allowed to grow to at least this many files.
 *
 * A share of the repository is the right measure of "too big to discriminate"
 * and a nonsense one when the repository is small: a share of forty indexed
 * files is a budget of fourteen, which stops the walk after a couple of hops
 * for no reason connected to selectivity. Nothing is diluted by reaching most
 * of a small codebase — there was never much to tell apart — so below this
 * size the rule simply does not apply.
 */
const MIN_REACHABLE_BUDGET = 40;

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
  /**
   * Import hops from the page to the nearest file this commit touched.
   *
   * 0 is the route file itself. Distance is not a filter — it is weighed,
   * so a deep match still counts, just for less than a direct one.
   */
  nearestHop: number;
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
  /** Files reachable from those routes, as far as the walk stayed useful. */
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
 * Breadth-first with a visited set, so a cyclic import graph (which every
 * real codebase has) terminates. Returns how many hops each file sits from
 * an entry, because distance is evidence: a helper the page imports directly
 * is a far better explanation for the page breaking than a validator forty
 * other modules also use.
 *
 * The walk goes as deep as it can while the set still discriminates, rather
 * than to a fixed number of hops. A whole layer is taken or left — never
 * part of one, which would mean including files for no better reason than
 * the order the database returned them.
 */
async function reachableFrom(
  projectId: string,
  entries: string[],
  fileBudget: number,
): Promise<Map<string, number>> {
  const db = await getDb();
  const depths = new Map<string, number>();
  for (const entry of entries) depths.set(entry, 0);
  let frontier = entries;

  for (let hop = 1; hop <= MAX_IMPORT_DEPTH && frontier.length > 0; hop++) {
    const rows = await db.query<{ to_path: string }>(
      `SELECT DISTINCT to_path FROM code_edges
        WHERE project_id = $1 AND from_path = ANY($2::text[])`,
      [projectId, frontier],
    );

    const next: string[] = [];
    for (const row of rows) {
      if (depths.has(row.to_path)) continue;
      next.push(row.to_path);
    }
    if (next.length === 0) break;

    // The first few hops are taken whatever they cost. Past those, a layer
    // that would swell the set beyond discriminating is where the walk ends.
    if (hop > MIN_IMPORT_DEPTH && depths.size + next.length > fileBudget) break;

    for (const p of next) depths.set(p, hop);
    frontier = next;
  }

  return depths;
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
  // How large the reachable set may grow before it stops telling commits
  // apart, measured against this repository rather than assumed.
  const [{ n: indexedFiles }] = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM code_entities WHERE project_id = $1`,
    [session.project_id],
  );
  const fileBudget = Math.max(
    MIN_REACHABLE_BUDGET,
    Math.floor(indexedFiles * SELECTIVITY_LIMIT),
  );

  const [fromRoutes, fromApis] = await Promise.all([
    matched.length > 0
      ? reachableFrom(session.project_id, matched.map((r) => r.path), fileBudget)
      : Promise.resolve(new Map<string, number>()),
    matchedApis.length > 0
      ? reachableFrom(session.project_id, matchedApis.map((r) => r.path), fileBudget)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const routeSet = new Set(fromRoutes.keys());
  const apiSet = new Set(fromApis.keys());

  // A file both chains reach sits at whichever distance is shorter.
  const hops = new Map<string, number>(fromRoutes);
  for (const [file, hop] of fromApis) {
    hops.set(file, Math.min(hop, hops.get(file) ?? Infinity));
  }

  base.reachableFiles = [...hops.keys()];
  const reachableSet = new Set(hops.keys());

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
        nearestHop: Math.min(...matchedFiles.map((f) => hops.get(f) ?? MAX_IMPORT_DEPTH)),
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
