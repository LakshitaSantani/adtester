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

import { getDb } from "@brain/db";
import { newId } from "@brain/ids";

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
  /** "api" is a route served to the browser rather than rendered by it. */
  kind: "route" | "api" | "component" | "module" | "flag";
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

/**
 * What a file imports, and by what name.
 *
 * The names matter because of barrel files. `import { Button } from "./ui"`
 * resolves to ui/index.ts, and a barrel re-exporting fifty components would
 * otherwise make all fifty reachable from anything that imported one. On a
 * barrel-heavy repository that inflates the reachable set until the code-path
 * filter stops filtering — and it fails quietly, by letting irrelevant commits
 * through rather than by breaking.
 *
 * Still regex rather than a real parser. An AST would be more accurate, and
 * the accuracy it buys mostly does not change which commits survive: what
 * changes the answer is barrels, and those are handled directly below.
 */
export type ImportRef = {
  specifier: string;
  /** Named imports. Empty for a default, namespace or side-effect import. */
  names: string[];
  /** True when the whole module is pulled in, so no name can narrow it. */
  wholeModule: boolean;
};

const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
// Everything that ISN'T a named import: default, namespace, side-effect.
// The lookahead is load-bearing — without it this also matched
// `import { X } from "y"`, marked the whole module as pulled in, and silently
// switched off the barrel routing below.
const OTHER_IMPORT = /import\s+(?![^"';]*\{)[^"';]*?["']([^"']+)["']/g;
const REQUIRE_LIKE = /(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;
const NAMED_REEXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const STAR_REEXPORT = /export\s+\*\s*(?:as\s+\w+\s*)?from\s*["']([^"']+)["']/g;

function splitNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    // `{ Button as Btn }` — the exported name is what the barrel knows it by.
    .map((part) => part.split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

export function parseImports(source: string): ImportRef[] {
  const bySpecifier = new Map<string, ImportRef>();

  const add = (specifier: string, names: string[], wholeModule: boolean) => {
    const existing = bySpecifier.get(specifier);
    if (existing) {
      for (const n of names) if (!existing.names.includes(n)) existing.names.push(n);
      existing.wholeModule = existing.wholeModule || wholeModule;
      return;
    }
    bySpecifier.set(specifier, { specifier, names: [...names], wholeModule });
  };

  for (const [pattern, hasNames] of [
    [NAMED_IMPORT, true],
    [NAMED_REEXPORT, true],
  ] as const) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      add(m[2], splitNames(m[1]), false);
    }
  }

  for (const pattern of [OTHER_IMPORT, REQUIRE_LIKE, STAR_REEXPORT]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      // A default, namespace or star import gives no name to narrow by, so
      // the whole module really is reachable.
      add(m[1], [], true);
    }
  }

  return [...bySpecifier.values()];
}

/** Files named index.* are where re-export barrels live. */
export function isBarrel(path: string): boolean {
  return /(^|\/)index\.(tsx?|jsx?|mjs)$/.test(path);
}

export type BarrelMap = {
  /** Exported name -> the specifier it actually comes from. */
  named: Map<string, string>;
  /** `export * from "..."` — no names, so nothing can be narrowed. */
  stars: string[];
};

export function parseBarrel(source: string): BarrelMap {
  const named = new Map<string, string>();
  const stars: string[] = [];

  NAMED_REEXPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_REEXPORT.exec(source)) !== null) {
    for (const name of splitNames(m[1])) named.set(name, m[2]);
  }

  STAR_REEXPORT.lastIndex = 0;
  while ((m = STAR_REEXPORT.exec(source)) !== null) stars.push(m[1]);

  return { named, stars };
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

/**
 * Follow a named import through any barrels in the way.
 *
 * `import { Button } from "./ui"` lands on ui/index.ts, which re-exports fifty
 * components. Without this, importing one of them makes all fifty reachable,
 * and on a barrel-heavy repository the reachable set inflates until the
 * code-path filter stops filtering anything out.
 *
 * Resolving by name gives the edge that actually exists: the page depends on
 * Button.tsx, not on everything Button.tsx happens to sit beside.
 *
 * Falls back to the barrel itself when a name can't be traced — a `export *`
 * chain, a default import, or a name the barrel doesn't declare. Losing
 * precision there is right: an unresolvable name means we genuinely don't know
 * which file it came from, and pretending otherwise would drop a real edge.
 */
export function resolveThroughBarrels(
  fromPath: string,
  ref: ImportRef,
  known: Set<string>,
  barrels: Map<string, BarrelMap>,
  packageRoots: string[],
  maxHops = 4,
): string[] {
  const first = resolveImport(fromPath, ref.specifier, known, packageRoots);
  if (!first) return [];
  if (!barrels.has(first) || ref.wholeModule || ref.names.length === 0) {
    return [first];
  }

  const out = new Set<string>();

  for (const name of ref.names) {
    let currentFile = first;
    let currentName = name;
    let resolved: string | null = null;

    // Barrels re-export from other barrels often enough to need a loop, and
    // a cap because they occasionally re-export from each other.
    for (let hop = 0; hop < maxHops; hop++) {
      const barrel = barrels.get(currentFile);
      if (!barrel) {
        resolved = currentFile;
        break;
      }

      const specifier = barrel.named.get(currentName);
      if (!specifier) {
        // Only reached through `export *`, so the name can't be traced.
        // Keeping the barrel is the honest answer.
        resolved = currentFile;
        break;
      }

      const next = resolveImport(currentFile, specifier, known, packageRoots);
      if (!next) {
        resolved = currentFile;
        break;
      }
      currentFile = next;
      // The name keeps its identity across a re-export chain.
    }

    if (resolved && resolved !== fromPath) out.add(resolved);
  }

  // A barrel that resolved nothing still represents a real dependency.
  return out.size > 0 ? [...out] : [first];
}

function tryExtensions(base: string, known: Set<string>): string | null {
  for (const ext of EXTENSION_CANDIDATES) {
    const candidate = `${base}${ext}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

// --- classification --------------------------------------------------------

/**
 * Server-side languages worth indexing.
 *
 * Until now only frontend files were, so a regression in a Python or Go
 * handler produced "nothing that shipped touches this page" -- which is worse
 * than an incomplete answer, because it reads as an exoneration of the code
 * when nobody had looked at most of it.
 */
const BACKEND_EXTENSIONS = /\.(py|go|rb|java|kt|rs|php|cs|ex|exs|scala)$/;

/** Directories that usually mean "this runs on a server". */
const SERVER_DIRS =
  /(^|\/)(api|server|backend|services?|handlers?|controllers?|routes?|functions?|lambdas?)(\/|$)/;

export function isBackendFile(path: string): boolean {
  if (IGNORED_PATH.test(path)) return false;
  if (BACKEND_EXTENSIONS.test(path)) return true;
  // A TypeScript file can be server code too; the directory is the only hint
  // available without reading it.
  return SOURCE_EXTENSIONS.test(path) && SERVER_DIRS.test(path);
}

/**
 * The HTTP path a file serves, from its location alone.
 *
 * Convention-based frameworks put the answer in the file path, which makes
 * this exact rather than a guess. Everything else needs the source, and is
 * handled by apiRoutesInSource below.
 */
export function apiRouteForPath(path: string): string | null {
  // Next.js app router: app/api/checkout/validate/route.ts -> /api/checkout/validate
  const appRouter = path.match(/(?:^|\/)app\/(api\/.*)\/route\.(tsx?|jsx?)$/);
  if (appRouter) return normaliseApiSegments(appRouter[1]);

  // Next.js pages router: pages/api/checkout.ts -> /api/checkout
  const pagesRouter = path.match(/(?:^|\/)pages\/(api\/.+)\.(tsx?|jsx?)$/);
  if (pagesRouter) return normaliseApiSegments(pagesRouter[1].replace(/\/index$/, ""));

  // Serverless conventions: functions/checkout.ts, netlify/functions/checkout.js
  const fn = path.match(/(?:^|\/)(?:netlify\/)?functions\/([\w-]+)\.(tsx?|jsx?|py|go|rb)$/);
  if (fn) return `/.netlify/functions/${fn[1]}`;

  return null;
}

function normaliseApiSegments(raw: string): string {
  const segments = raw
    .split("/")
    .filter(Boolean)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => {
      if (/^\[\.\.\..+\]$/.test(s)) return "*";
      if (/^\[.+\]$/.test(s)) return ":param";
      return s;
    });
  return `/${segments.join("/")}`;
}

/**
 * Routes declared in the source, for frameworks that register them by hand.
 *
 * Covers the decorator and router-call shapes used by FastAPI, Flask, Express,
 * Fastify, Gin, Echo, Spring and net/http. It is pattern matching rather than
 * parsing, so a route built at runtime from a variable is invisible -- and a
 * route this misses simply means a backend commit stays out of the candidate
 * set, which is the same blindness we had before rather than a new wrong
 * answer.
 *
 * Only run on server-side files. The same shapes appear in frontend code as
 * `axios.get("/api/x")`, which would otherwise register the caller as the
 * thing being called.
 */
const ROUTE_PATTERNS = [
  // @app.get("/x") / @router.post("/x") / @app.route("/x")  — FastAPI, Flask
  /@\w+\.(?:get|post|put|patch|delete|route)\(\s*["'`]([^"'`]+)["'`]/gi,
  // app.get("/x" / router.post('/x'  — Express, Fastify
  /\b(?:app|router|r|srv|server|api)\.(?:get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]/g,
  // r.GET("/x"  — Gin, Echo, chi
  /\b\w+\.(?:GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\(\s*["'`]([^"'`]+)["'`]/g,
  // @GetMapping("/x") / @RequestMapping("/x")  — Spring
  /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
];

export function apiRoutesInSource(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of ROUTE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const route = match[1].trim();
      // A bare "/" registers the whole site and matches everything, which
      // makes it useless for narrowing.
      if (!route.startsWith("/") || route === "/") continue;
      found.add(normaliseRuntimeRoute(route));
    }
  }
  return [...found];
}

/** Framework parameter syntax varies; the matcher only understands one form. */
function normaliseRuntimeRoute(route: string): string {
  return route
    .replace(/\{[^}]+\}/g, ":param") // FastAPI, Spring
    .replace(/:[A-Za-z_][\w]*/g, ":param") // Express, Gin
    .replace(/<[^>]+>/g, ":param") // Flask
    .replace(/\*+$/, "*")
    .replace(/\/+$/, "") || "/";
}

/**
 * Imports in server-side languages.
 *
 * Only local imports resolve to files we hold, which is the point -- a change
 * inside a third-party package is not a commit in this repository and cannot
 * be a candidate.
 */
const BACKEND_IMPORT_PATTERNS = [
  /^\s*from\s+([.\w]+)\s+import\s/gm, // Python
  /^\s*import\s+([.\w]+)\s*$/gm, // Python
  /^\s*require\s+["']([^"']+)["']/gm, // Ruby
  /^\s*import\s+"([^"]+)"/gm, // Go
  /^\s*use\s+(?:crate|self|super)::([\w:]+)/gm, // Rust
];

export function parseBackendImports(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of BACKEND_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return [...found];
}

/**
 * Resolve a server-side import to a file in the repository.
 *
 * Dotted and slashed module paths both map onto directories, so this tries the
 * obvious translations and gives up rather than guessing. Anything unresolved
 * is a package, and packages are out of scope.
 */
export function resolveBackendImport(
  fromPath: string,
  specifier: string,
  known: Set<string>,
): string | null {
  const dir = fromPath.split("/").slice(0, -1);
  const asPath = specifier.replace(/^\.+/, "").replace(/[.:]+/g, "/");
  const leadingDots = (specifier.match(/^\.+/) ?? [""])[0].length;

  const bases: string[] = [];
  if (leadingDots > 0) {
    // Python relative import: one dot is this package, each extra goes up.
    const up = dir.slice(0, dir.length - (leadingDots - 1));
    bases.push([...up, asPath].join("/"));
  }
  bases.push([...dir, asPath].join("/"), asPath);

  for (const base of bases) {
    for (const ext of [".py", ".go", ".rb", ".rs", ".java", ".kt", ".php", ".cs", "/__init__.py", "/mod.rs"]) {
      const candidate = `${base}${ext}`;
      if (known.has(candidate)) return candidate;
    }
  }
  return null;
}

export function isIndexable(path: string): boolean {
  if (IGNORED_PATH.test(path)) return false;
  return SOURCE_EXTENSIONS.test(path) || BACKEND_EXTENSIONS.test(path);
}

export function classify(path: string): Entity {
  const file = path.split("/").pop() ?? path;
  const bare = file.replace(SOURCE_EXTENSIONS, "").replace(BACKEND_EXTENSIONS, "");

  // API routes are checked first: app/api/x/route.ts would otherwise be read
  // as a page by the app-router rule.
  const apiRoute = apiRouteForPath(path);
  if (apiRoute) {
    const words = apiRoute.split("/").filter((s) => s && !s.startsWith(":") && s !== "api");
    const name = words.join(" ") || "api";
    return {
      path,
      kind: "api",
      name,
      route: apiRoute,
      aliases: [...new Set([...humanAliases(name), apiRoute, ...words])],
    };
  }

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
