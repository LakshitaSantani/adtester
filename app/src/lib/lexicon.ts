/**
 * Building the repo lexicon and the import graph.
 *
 * Two jobs:
 *
 * 1. Work out what each file IS — a route, a component, a plain module — and
 *    what a person would call it. Nobody in a meeting says
 *    "src/checkout/validation.ts line 42"; they say "the phone thing". The
 *    lexicon is what bridges that, and it's why the codebase is a first-class
 *    source rather than a detail of the git connector.
 *
 * 2. Work out what each file IMPORTS, so we can answer the question phase 4
 *    actually needs: given the URL a session was on, which files could
 *    possibly be involved?
 *
 * This is heuristic, and deliberately so. A real parser (tree-sitter, or the
 * TypeScript compiler API) would be more accurate and much slower, and the
 * accuracy it buys mostly doesn't change which commits survive the filter.
 * If the filter starts letting through commits it shouldn't, this is the
 * first place to spend effort.
 */

import { getDb } from "./db";
import { newId } from "./ids";

const SOURCE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/;

/**
 * Never worth indexing.
 *
 * Test fixtures matter more than they look. A repo with framework fixtures
 * (shadcn-ui/ui has a dozen) contributes a dozen files that all look like
 * the route "/" — and since reachability unions across every matching
 * route, one real page would drag in the imports of eleven fake ones and
 * let through commits that have nothing to do with it. Excluding fixtures
 * is the difference between a filter and a formality.
 */
const IGNORED_PATH =
  /(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor|__tests__|__mocks__|__fixtures__|fixtures|test|tests|e2e|cypress|playwright|storybook|\.storybook)(\/|$)|\.(test|spec|stories|d)\.[jt]sx?$/;

export type Entity = {
  path: string;
  kind: "route" | "component" | "module" | "flag";
  name: string;
  route: string | null;
  aliases: string[];
};

// --- naming ----------------------------------------------------------------

/**
 * The words a person might use for this identifier. "PhoneInput" yields
 * "phone input", "phone" and "input", so a transcript saying "the phone
 * field" can reach it.
 */
export function humanAliases(name: string): string[] {
  const words = name
    .replace(SOURCE_EXTENSIONS, "")
    .replace(/[-_.]+/g, " ")
    // Split camelCase and PascalCase, keeping acronyms together:
    // "parseHTTPResponse" -> "parse HTTP Response"
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  if (words.length === 0) return [];

  const aliases = new Set<string>();
  aliases.add(words.join(" "));
  for (const word of words) aliases.add(word);

  // Adjacent pairs catch the phrases people actually say — "phone input",
  // "checkout form" — without exploding into every combination.
  for (let i = 0; i < words.length - 1; i++) {
    aliases.add(`${words[i]} ${words[i + 1]}`);
  }

  return Array.from(aliases);
}

const STOP_WORDS = new Set([
  "index", "src", "app", "lib", "utils", "util", "helpers", "common",
  "component", "components", "page", "pages", "the", "and", "for",
]);

// --- routes ----------------------------------------------------------------

/**
 * Map a file path to the URL it serves, for the framework conventions worth
 * supporting. Returns null for files that aren't routes.
 */
export function routeForPath(path: string): string | null {
  // Next.js app router: app/checkout/page.tsx -> /checkout
  const appRouter = path.match(/(?:^|\/)app\/(.*)\/?page\.(tsx?|jsx?)$/);
  if (appRouter) return normaliseSegments(appRouter[1]);

  // Next.js app router at the root: app/page.tsx -> /
  if (/(?:^|\/)app\/page\.(tsx?|jsx?)$/.test(path)) return "/";

  // SvelteKit: src/routes/checkout/+page.svelte -> /checkout
  const sveltekit = path.match(/(?:^|\/)routes\/(.*)\/?\+page\.svelte$/);
  if (sveltekit) return normaliseSegments(sveltekit[1]);

  // Next.js pages router: pages/checkout.tsx -> /checkout
  const pagesRouter = path.match(/(?:^|\/)pages\/(.+)\.(tsx?|jsx?)$/);
  if (pagesRouter) {
    if (pagesRouter[1].startsWith("api/")) return null; // API routes aren't pages
    if (pagesRouter[1] === "_app" || pagesRouter[1] === "_document") return null;
    return normaliseSegments(pagesRouter[1].replace(/\/?index$/, ""));
  }

  // Remix: app/routes/checkout.tsx -> /checkout (dots are separators)
  const remix = path.match(/(?:^|\/)routes\/(.+)\.(tsx?|jsx?)$/);
  if (remix && !remix[1].includes("/")) {
    return normaliseSegments(remix[1].replace(/\./g, "/"));
  }

  return null;
}

function normaliseSegments(raw: string): string {
  const segments = raw
    .split("/")
    .filter(Boolean)
    // Route groups like (marketing) organise files without affecting the URL.
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => {
      // [id] and [...slug] become wildcards we can match a real URL against.
      if (/^\[\.\.\..+\]$/.test(s)) return "*";
      if (/^\[.+\]$/.test(s)) return ":param";
      return s;
    });
  return `/${segments.join("/")}`.replace(/\/+$/, "") || "/";
}

/**
 * Does a concrete URL path match a route pattern? Handles the `:param` and
 * `*` produced above.
 */
export function routeMatches(pattern: string, actual: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const a = actual.split("/").filter(Boolean);

  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") return true; // catch-all swallows the rest
    if (i >= a.length) return false;
    if (p[i] === ":param") continue;
    if (p[i] !== a[i]) return false;
  }
  return p.length === a.length;
}

// --- imports ---------------------------------------------------------------

const IMPORT_PATTERNS = [
  /import\s+[\s\S]*?from\s+["']([^"']+)["']/g,
  /import\s+["']([^"']+)["']/g,
  /require\(\s*["']([^"']+)["']\s*\)/g,
  /import\(\s*["']([^"']+)["']\s*\)/g,
  /export\s+[\s\S]*?from\s+["']([^"']+)["']/g,
];

export function parseImports(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      found.add(match[1]);
    }
  }
  return Array.from(found);
}

const EXTENSION_CANDIDATES = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx",
];

/**
 * Resolve an import specifier to a file we actually have.
 *
 * Handles relative paths and the common "@/..." alias. Package imports
 * resolve to nothing on purpose — a change inside node_modules isn't a
 * commit in this repo, so it can't be a candidate.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  known: Set<string>,
  packageRoots: string[] = [],
): string | null {
  if (specifier.startsWith(".")) {
    const dir = fromPath.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") dir.pop();
      else dir.push(part);
    }
    return tryExtensions(dir.join("/"), known);
  }

  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    const rest = specifier.slice(2);

    // "@/" means "the root of THIS package", which in a monorepo is not the
    // root of the repository. Resolving it repo-relative finds almost
    // nothing — the first version of this missed roughly 90% of the imports
    // in a workspace repo, which quietly gutted the code-path filter.
    //
    // So: walk up from the importing file to its nearest package root, and
    // try that first.
    const enclosing = nearestPackageRoot(fromPath, packageRoots);
    const bases = enclosing ? [enclosing, ...packageRoots] : packageRoots;

    for (const base of [...bases, ""]) {
      for (const inner of ["", "src", "app"]) {
        const candidate = [base, inner, rest].filter(Boolean).join("/");
        const hit = tryExtensions(candidate, known);
        if (hit) return hit;
      }
    }
    return null;
  }

  return null; // a published package — not a change in this repo
}

/** The deepest package root that contains this file. */
function nearestPackageRoot(filePath: string, packageRoots: string[]): string | null {
  let best: string | null = null;
  for (const root of packageRoots) {
    if (root === "") continue;
    if (!filePath.startsWith(`${root}/`)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/** Directories holding a package.json — the roots an "@/" alias can mean. */
export function packageRootsFrom(files: string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    if (!file.endsWith("package.json")) continue;
    const dir = file.split("/").slice(0, -1).join("/");
    roots.add(dir);
  }
  return Array.from(roots).sort((a, b) => b.length - a.length);
}

function tryExtensions(base: string, known: Set<string>): string | null {
  for (const ext of EXTENSION_CANDIDATES) {
    const candidate = `${base}${ext}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

// --- classification --------------------------------------------------------

export function isIndexable(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path) && !IGNORED_PATH.test(path);
}

export function classify(path: string): Entity {
  const file = path.split("/").pop() ?? path;
  const bare = file.replace(SOURCE_EXTENSIONS, "");
  const route = routeForPath(path);

  if (route !== null) {
    // A route's own filename is usually meaningless ("page"), so name it
    // after the URL it serves — which is also what a person would say.
    const fromRoute = route.split("/").filter(Boolean).filter((s) => !s.startsWith(":"));
    const name = fromRoute.length > 0 ? fromRoute.join(" ") : "home";
    return {
      path,
      kind: "route",
      name,
      route,
      aliases: Array.from(new Set([...humanAliases(name), route, ...fromRoute])),
    };
  }

  // PascalCase filenames are components by convention nearly everywhere.
  const isComponent = /^[A-Z]/.test(bare) && /\.(tsx|jsx|vue|svelte)$/.test(file);

  return {
    path,
    kind: isComponent ? "component" : "module",
    name: bare,
    route: null,
    aliases: humanAliases(bare),
  };
}

// --- persistence -----------------------------------------------------------

export async function saveLexicon(
  projectId: string,
  entities: Entity[],
  edges: Array<[string, string]>,
): Promise<void> {
  const db = await getDb();

  // The repo is the source of truth, so a rebuild replaces rather than
  // merges — otherwise deleted files linger in the lexicon forever.
  await db.query(`DELETE FROM code_entities WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM code_edges WHERE project_id = $1`, [projectId]);

  for (const entity of entities) {
    await db.query(
      `INSERT INTO code_entities (id, project_id, path, kind, name, route, aliases)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId("ce"),
        projectId,
        entity.path,
        entity.kind,
        entity.name,
        entity.route,
        entity.aliases,
      ],
    );
  }

  for (const [from, to] of edges) {
    await db.query(
      `INSERT INTO code_edges (project_id, from_path, to_path) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [projectId, from, to],
    );
  }
}

/**
 * Fill in deploy times from the recordings themselves.
 *
 * Most teams don't publish GitHub Deployments, but we have something better
 * anyway: the first session that reports a given build is direct evidence
 * that the build was live by then. It's a lower bound rather than an exact
 * time, and it comes from the users rather than from the pipeline — which
 * for our purposes is the more honest signal, because it reflects when code
 * actually reached people.
 *
 * Only fills nulls, so a real deployment record always wins.
 */
export async function inferDeployTimes(projectId: string): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ sha: string }>(
    `UPDATE commits c
        SET deployed_at = f.first_seen
       FROM (
         SELECT release, MIN(started_at) AS first_seen
           FROM sessions
          WHERE project_id = $1 AND release IS NOT NULL AND release <> ''
          GROUP BY release
       ) f
      WHERE c.project_id = $1
        AND c.deployed_at IS NULL
        AND (c.sha = f.release OR c.sha LIKE f.release || '%')
      RETURNING c.sha`,
    [projectId],
  );
  return result.length;
}
