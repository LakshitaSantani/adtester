/**
 * The worker loop and the tasks it runs.
 *
 * Runs inside the web process during local development, because PGlite is an
 * embedded database that only one process can open. Point DATABASE_URL at a
 * real Postgres and the same loop can be run standalone (`npm run worker`)
 * with nothing else changed.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { candidatesForSession } from "./candidates";
import { decrypt } from "./crypto";
import { getDb } from "./db";
import * as gh from "./github";
import { importFromPostHog } from "./import-posthog";
import { investigate } from "./investigate";
import { mineAliases } from "./aliases";
import { discoverCompetitors } from "./competitors";
import { RESEARCH_WINDOW_DAYS, researchCompetitor, saveEvents } from "./market";
import { loadProfile } from "./profile";
import { resolveAnthropicKey } from "./secrets";
import type { PostHogConfig } from "./posthog";
import { claimNext, fail, finish, type Job } from "./jobs";
import {
  apiRoutesInSource,
  classify,
  isBackendFile,
  parseBackendImports,
  resolveBackendImport,
  isBarrel,
  parseBarrel,
  resolveThroughBarrels,
  type BarrelMap,
  inferDeployTimes,
  isIndexable,
  packageRootsFrom,
  parseImports,
  resolveImport,
  saveLexicon,
  type Entity,
} from "./lexicon";
import { describeSymptom, detectSymptoms } from "./symptoms";

const POLL_INTERVAL_MS = 3000;

/** Don't try to read a source file larger than this; it isn't hand-written. */
const MAX_FILE_BYTES = 400 * 1024;

type RepoRow = {
  id: string;
  project_id: string;
  owner: string;
  name: string;
  default_branch: string;
  access_token: string | null;
};

async function loadRepo(projectId: string): Promise<RepoRow | null> {
  const db = await getDb();
  const row = await db.one<RepoRow>(
    `SELECT id, project_id, owner, name, default_branch, access_token
       FROM repos WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
    [projectId],
  );
  return row ? { ...row, access_token: decrypt(row.access_token) } : null;
}

// --- tasks -----------------------------------------------------------------

/**
 * Pull recent commits and whatever deploy times GitHub knows about.
 *
 * Deliberately a window rather than the whole history: an investigation only
 * ever looks back days, and full history on a large repo is thousands of
 * requests for data nothing will read.
 */
async function syncRepo(job: Job): Promise<void> {
  const repo = await loadRepo(job.project_id);
  if (!repo) throw new Error("no repository connected for this project");

  const db = await getDb();
  const sinceDays = Number(job.payload.sinceDays ?? 30);
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const ref: gh.RepoRef = { owner: repo.owner, name: repo.name, token: repo.access_token };
  const commits = await gh.listCommits(ref, { since, limit: 100 });

  for (const c of commits) {
    await db.query(
      `INSERT INTO commits
         (project_id, sha, authored_at, author, message, pr_number, pr_title, pr_body,
          files_touched, parents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (project_id, sha) DO UPDATE SET
         authored_at = EXCLUDED.authored_at,
         author = EXCLUDED.author,
         message = EXCLUDED.message,
         pr_number = EXCLUDED.pr_number,
         pr_title = EXCLUDED.pr_title,
         pr_body = EXCLUDED.pr_body,
         files_touched = EXCLUDED.files_touched,
         parents = EXCLUDED.parents`,
      [
        job.project_id,
        c.sha,
        c.authoredAt,
        c.author,
        c.message,
        c.prNumber,
        c.prTitle,
        c.prBody,
        c.filesTouched,
        c.parents,
      ],
    );
  }

  // Real deployment records win over anything we infer.
  for (const d of await gh.listDeployments(ref)) {
    await db.query(
      `UPDATE commits SET deployed_at = $3 WHERE project_id = $1 AND sha = $2`,
      [job.project_id, d.sha, d.deployedAt],
    );
  }

  const inferred = await inferDeployTimes(job.project_id);

  await db.query(
    `UPDATE repos SET last_synced_at = now(), last_error = NULL WHERE id = $1`,
    [repo.id],
  );

  console.log(
    `sync_repo: ${commits.length} commits for ${repo.owner}/${repo.name}` +
      (inferred > 0 ? `, ${inferred} deploy times inferred from sessions` : ""),
  );
}

/**
 * Build the lexicon and the import graph.
 *
 * Downloads the repo as a single tarball rather than fetching files one at a
 * time — one request instead of hundreds, and it stays well inside GitHub's
 * rate limit even on a big repo.
 */
async function indexRepo(job: Job): Promise<void> {
  const repo = await loadRepo(job.project_id);
  if (!repo) throw new Error("no repository connected for this project");

  const workdir = await mkdtemp(path.join(tmpdir(), "swy-repo-"));
  try {
    const root = await downloadTarball(
      { owner: repo.owner, name: repo.name, token: repo.access_token },
      repo.default_branch,
      workdir,
    );

    const files = (await walk(root)).map((abs) =>
      path.relative(root, abs).split(path.sep).join("/"),
    );
    const indexable = files.filter(isIndexable);
    const known = new Set(indexable);
    // Computed from the full file list, not the indexable subset, because
    // package.json isn't source.
    const packageRoots = packageRootsFrom(files);

    const entities: Entity[] = indexable.map(classify);
    const edges: Array<[string, string]> = [];

    // First pass: read the barrels, so the second pass can route named
    // imports past them to the file that actually defines the thing.
    const barrels = new Map<string, BarrelMap>();
    for (const rel of indexable) {
      if (!isBarrel(rel)) continue;
      try {
        const abs = path.join(root, rel);
        if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
        barrels.set(rel, parseBarrel(await readFile(abs, "utf8")));
      } catch {
        // A barrel we can't read just stops being a shortcut.
      }
    }

    let throughBarrels = 0;
    // Routes a framework registers in code rather than by file location.
    // Collected while reading, then folded into the entity list below.
    const runtimeRoutes = new Map<string, string[]>();

    for (const rel of indexable) {
      const abs = path.join(root, rel);
      try {
        if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
        const source = await readFile(abs, "utf8");

        if (isBackendFile(rel)) {
          const declared = apiRoutesInSource(source);
          if (declared.length > 0) runtimeRoutes.set(rel, declared);

          for (const specifier of parseBackendImports(source)) {
            const target = resolveBackendImport(rel, specifier, known);
            if (target && target !== rel) edges.push([rel, target]);
          }
        }

        for (const ref of parseImports(source)) {
          const targets = resolveThroughBarrels(rel, ref, known, barrels, packageRoots);
          for (const target of targets) {
            if (target !== rel) edges.push([rel, target]);
          }
          if (targets.length > 0 && ref.names.length > 0 && !ref.wholeModule) {
            const direct = resolveImport(rel, ref.specifier, known, packageRoots);
            if (direct && barrels.has(direct)) throughBarrels += 1;
          }
        }
      } catch {
        // An unreadable file costs us its imports, not the whole index.
      }
    }

    // A file that registers routes in code becomes an api entity, which the
    // path-based rules could not have known.
    for (const [path, routes] of runtimeRoutes) {
      const existing = entities.find((e) => e.path === path);
      const primary = routes[0];
      if (existing && existing.kind !== "api") {
        existing.kind = "api";
        existing.route = primary;
        existing.aliases = [...new Set([...existing.aliases, ...routes])];
      }
      // A single file often serves several routes; each needs its own entity
      // so a URL can match the one it belongs to.
      for (const route of routes.slice(1)) {
        entities.push({
          path,
          kind: "api",
          name: route.split("/").filter(Boolean).join(" "),
          route,
          aliases: [route],
        });
      }
    }

    await saveLexicon(job.project_id, entities, edges);

    const routes = entities.filter((e) => e.kind === "route").length;
    const apis = entities.filter((e) => e.kind === "api").length;
    console.log(
      `index_repo: ${entities.length} files, ${routes} routes, ${apis} api routes, ${edges.length} imports` +
        (barrels.size > 0 ? `, ${barrels.size} barrels (${throughBarrels} imports routed past)` : "") +
        (packageRoots.length > 1 ? `, ${packageRoots.length} packages` : ""),
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Look for new symptoms and investigate them.
 *
 * One at a time, most-affected first. Investigating everything at once would
 * bury the thing that matters under a list, and the whole point is to hand
 * someone a short answer rather than another dashboard.
 */
async function runInvestigations(job: Job): Promise<void> {
  const db = await getDb();
  const symptoms = await detectSymptoms(job.project_id);

  if (symptoms.length === 0) {
    console.log("investigate: nothing new to look into");
    return;
  }

  const limit = Number(job.payload.limit ?? 3);
  // A key passed for this run only, rather than stored on the project.
  const suppliedKey =
    typeof job.payload.apiKey === "string" ? decrypt(job.payload.apiKey) : null;
  let done = 0;

  for (const symptom of symptoms.slice(0, limit)) {
    // Don't re-investigate something already reported. A symptom that keeps
    // going is the same symptom, and a stream of duplicates is how a useful
    // product turns into noise someone mutes.
    const existing = await db.one<{ id: string }>(
      `SELECT id FROM investigations
        WHERE project_id = $1 AND symptom = $2
          AND created_at > now() - interval '24 hours'`,
      [job.project_id, describeSymptom(symptom)],
    );
    if (existing) continue;

    const result = await investigate(job.project_id, symptom, suppliedKey);
    done += 1;
    console.log(
      `investigate: ${result.symptom} -> ${result.status}` +
        (result.confidence !== null ? ` (${result.confidence.toFixed(2)})` : "") +
        (result.declinedReason ? ` [${result.declinedReason}]` : ""),
    );
  }

  if (done === 0) console.log("investigate: all current symptoms already reported");
}

/**
 * Pull a window of real recordings out of a PostHog account.
 *
 * Enqueues an investigation afterwards, because the entire reason to import
 * is to point the brain at real behaviour immediately.
 */
async function importPostHog(job: Job): Promise<void> {
  const db = await getDb();
  const source = await db.one<{ id: string; config: Record<string, unknown> | string }>(
    `SELECT id, config FROM data_sources WHERE project_id = $1 AND kind = 'posthog'`,
    [job.project_id],
  );
  if (!source) throw new Error("no PostHog account connected for this project");

  const config = (
    typeof source.config === "string" ? JSON.parse(source.config) : source.config
  ) as PostHogConfig;
  config.apiKey = decrypt(config.apiKey) ?? "";

  try {
    const summary = await importFromPostHog(job.project_id, config, {
      limit: Number(job.payload.limit ?? 100),
      afterDays: Number(job.payload.afterDays ?? 30),
    });

    await db.query(
      `UPDATE data_sources SET last_synced_at = now(), last_error = NULL WHERE id = $1`,
      [source.id],
    );

    const signatures = Object.entries(summary.signatureCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(
      `import_posthog: ${summary.imported} imported, ${summary.skipped} already had, ` +
        `${summary.failed} failed, ${summary.withRelease} carried a build` +
        (signatures ? ` | ${signatures}` : ""),
    );
  } catch (error) {
    await db.query(`UPDATE data_sources SET last_error = $2 WHERE id = $1`, [
      source.id,
      error instanceof Error ? error.message : String(error),
    ]);
    throw error;
  }
}

/**
 * Look up what competitors have been doing.
 *
 * Runs on a schedule rather than during an investigation, because search is
 * slow and the answer to "what changed in the market last month" doesn't
 * depend on which symptom is being looked at. By the time a finding needs
 * context, the context is already there.
 */
async function researchMarket(job: Job): Promise<void> {
  const profile = await loadProfile(job.project_id);
  const competitors = profile?.competitors ?? [];

  if (competitors.length === 0) {
    console.log("research_market: no competitors named in the profile, nothing to look up");
    return;
  }

  const apiKey = await resolveAnthropicKey(job.project_id);
  if (!apiKey) {
    console.log("research_market: needs an Anthropic key to search");
    return;
  }

  const since = new Date(Date.now() - RESEARCH_WINDOW_DAYS * 86_400_000);
  let total = 0;
  let dropped = 0;

  for (const competitor of competitors.slice(0, 8)) {
    const events = await researchCompetitor(
      competitor,
      { whatWeDo: profile?.whatWeDo ?? null, since },
      apiKey,
    );
    const saved = await saveEvents(job.project_id, events);
    total += saved;
    dropped += events.length - saved;
  }

  console.log(
    `research_market: ${total} new observations across ${competitors.length} competitors` +
      (dropped > 0 ? ` (${dropped} already known)` : ""),
  );
}

async function inferDeploys(job: Job): Promise<void> {
  const count = await inferDeployTimes(job.project_id);
  console.log(`infer_deploys: filled ${count} deploy times`);
}

// --- tarball ---------------------------------------------------------------

/**
 * Fetch and unpack the repo. Uses the system `tar`, which ships with Windows
 * 10+, macOS and every Linux — one less npm dependency, and it handles the
 * formats GitHub emits without us parsing an archive by hand.
 */
async function downloadTarball(
  ref: gh.RepoRef,
  branch: string,
  workdir: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.name}/tarball/${branch}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "simplywhy",
      ...(ref.token ? { Authorization: `Bearer ${ref.token}` } : {}),
    },
    redirect: "follow",
  });

  if (!response.ok || !response.body) {
    throw new Error(`could not download repository archive (${response.status})`);
  }

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createGunzip(),
    createWriteStream(path.join(workdir, "repo.tar")),
  );

  // Relative filename with cwd set, never an absolute path: the tar that
  // ships with Windows reads "C:\..." as a remote host spec and tries to
  // open a network connection to a host called "C".
  await run("tar", ["-xf", "repo.tar"], workdir);

  // GitHub wraps everything in one directory named owner-repo-sha.
  const entries = await readdir(workdir, { withFileTypes: true });
  const extracted = entries.find((e) => e.isDirectory());
  if (!extracted) throw new Error("repository archive was empty");
  return path.join(workdir, extracted.name);
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

// --- loop ------------------------------------------------------------------

/**
 * Learn what this team calls things, once per sync.
 *
 * Runs after the lexicon is built and the documents are in, because it needs
 * both sides of the mapping. Costs one model call and buys every later
 * investigation a search that knows the team's own vocabulary.
 */
async function mineProjectAliases(job: Job): Promise<void> {
  const apiKey = await resolveAnthropicKey(job.project_id);
  if (!apiKey) {
    console.log("mine_aliases: needs an Anthropic key to read the documents");
    return;
  }

  const result = await mineAliases(job.project_id, apiKey);

  if (result.proposed === 0) {
    console.log("mine_aliases: no names proposed");
    return;
  }

  console.log(
    `mine_aliases: ${result.accepted.length} of ${result.proposed} names kept` +
      (result.accepted.length > 0
        ? ` (${result.accepted.map((a) => `"${a.alias}" -> ${a.path}`).join(", ")})`
        : ""),
  );
  for (const { alias, reason } of result.rejected) {
    console.log(`mine_aliases: dropped "${alias}" — ${reason}`);
  }
}

/**
 * Go and find out who this company competes with.
 *
 * Runs before the market research rather than instead of it: research reads
 * the confirmed list, and this only ever adds to the pile of suggestions
 * waiting for a person. Re-running matters as much as the first run — the
 * competitor worth knowing about is usually the one that did not exist when
 * the profile was filled in.
 */
async function findCompetitors(job: Job): Promise<void> {
  const apiKey = await resolveAnthropicKey(job.project_id);
  if (!apiKey) {
    console.log("discover_competitors: needs an Anthropic key to search");
    return;
  }

  const result = await discoverCompetitors(job.project_id, apiKey);

  if (result.proposed === 0) {
    console.log(
      "discover_competitors: nothing proposed — either the search found no one " +
        "new, or the profile has no description to search on",
    );
    return;
  }

  console.log(
    `discover_competitors: ${result.suggestions.length} of ${result.proposed} kept` +
      (result.suggestions.length > 0
        ? ` (${result.suggestions.map((s) => `${s.name} [${s.kind}]`).join(", ")})`
        : ""),
  );
  for (const { name, reason } of result.rejected) {
    console.log(`discover_competitors: dropped ${name || "(unnamed)"} — ${reason}`);
  }
}

const HANDLERS: Record<string, (job: Job) => Promise<void>> = {
  sync_repo: syncRepo,
  index_repo: indexRepo,
  infer_deploys: inferDeploys,
  investigate: runInvestigations,
  import_posthog: importPostHog,
  research_market: researchMarket,
  mine_aliases: mineProjectAliases,
  discover_competitors: findCompetitors,
};

// Same reasoning as the database singleton: a hot reload must not start a
// second polling loop against the same queue.
const globalForWorker = globalThis as typeof globalThis & { __swyWorker?: boolean };

export async function runOnce(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;

  const handler = HANDLERS[job.kind];
  if (!handler) {
    await fail(job, new Error(`unknown job kind "${job.kind}"`));
    return true;
  }

  try {
    await handler(job);
    await finish(job.id);
  } catch (error) {
    await fail(job, error);
  }
  return true;
}

/**
 * Start the loop if it isn't already running. Safe to call from anywhere —
 * every route that enqueues work or displays its results calls this, so the
 * worker comes up on the first request that could possibly need it.
 *
 * Called from route handlers and server components rather than from
 * instrumentation.ts, because Next compiles instrumentation for the edge
 * runtime as well, and nothing here can run on edge — it shells out to tar
 * and reads the filesystem.
 */
export function ensureWorker(): void {
  if (globalForWorker.__swyWorker) return;
  if (process.env.SWY_DISABLE_WORKER === "1") return;
  globalForWorker.__swyWorker = true;
  console.log("worker: started");

  const tick = async () => {
    try {
      // Drain rather than doing one per tick, so a queued sync+index pair
      // doesn't take two polling intervals to get going.
      while (await runOnce()) {
        /* keep going while there's work */
      }
    } catch (error) {
      console.error("worker: loop error", error);
    } finally {
      setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  void tick();
}

export { candidatesForSession };
