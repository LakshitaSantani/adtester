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
import { getDb } from "./db";
import * as gh from "./github";
import { claimNext, fail, finish, type Job } from "./jobs";
import {
  classify,
  inferDeployTimes,
  isIndexable,
  packageRootsFrom,
  parseImports,
  resolveImport,
  saveLexicon,
  type Entity,
} from "./lexicon";

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
  return db.one<RepoRow>(
    `SELECT id, project_id, owner, name, default_branch, access_token
       FROM repos WHERE project_id = $1 ORDER BY created_at LIMIT 1`,
    [projectId],
  );
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
         (project_id, sha, authored_at, author, message, pr_number, pr_title, pr_body, files_touched)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id, sha) DO UPDATE SET
         authored_at = EXCLUDED.authored_at,
         author = EXCLUDED.author,
         message = EXCLUDED.message,
         pr_number = EXCLUDED.pr_number,
         pr_title = EXCLUDED.pr_title,
         pr_body = EXCLUDED.pr_body,
         files_touched = EXCLUDED.files_touched`,
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

    for (const rel of indexable) {
      const abs = path.join(root, rel);
      try {
        if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
        const source = await readFile(abs, "utf8");
        for (const specifier of parseImports(source)) {
          const target = resolveImport(rel, specifier, known, packageRoots);
          if (target && target !== rel) edges.push([rel, target]);
        }
      } catch {
        // An unreadable file costs us its imports, not the whole index.
      }
    }

    await saveLexicon(job.project_id, entities, edges);

    const routes = entities.filter((e) => e.route !== null).length;
    console.log(
      `index_repo: ${entities.length} files, ${routes} routes, ${edges.length} imports` +
        (packageRoots.length > 1 ? `, ${packageRoots.length} packages` : ""),
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
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

const HANDLERS: Record<string, (job: Job) => Promise<void>> = {
  sync_repo: syncRepo,
  index_repo: indexRepo,
  infer_deploys: inferDeploys,
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
