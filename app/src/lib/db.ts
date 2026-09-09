/**
 * Database access.
 *
 * Two backends behind one tiny interface, both speaking real Postgres SQL:
 *
 *   - No DATABASE_URL  -> PGlite, Postgres compiled to WASM, stored in ./data/pg.
 *                         Nothing to install, nothing to sign up for.
 *   - DATABASE_URL set  -> a real Postgres server.
 *
 * Because both are genuinely Postgres, moving from one to the other is a
 * change of environment variable, not a migration. The schema in db/schema.sql
 * runs unmodified against either.
 */

import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
}

const DATA_DIR = process.env.DATA_DIR ?? "./data";

/**
 * Cached on globalThis, not in a module variable.
 *
 * Next's dev server re-evaluates modules on hot reload, which would give
 * each reload its own connection. With PGlite that isn't just wasteful — it
 * is fatal, because two instances can't hold the same data directory and the
 * second one aborts the process. globalThis survives module re-evaluation,
 * so there is exactly one database per process however many times this file
 * is re-imported.
 */
const globalForDb = globalThis as typeof globalThis & {
  __swyDb?: Promise<Db>;
};

async function createPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = path.resolve(DATA_DIR, "pg");
  mkdirSync(dir, { recursive: true });

  // Refuse to be the second process in here.
  //
  // PGlite is Postgres compiled to WASM and embedded in one process. Nothing
  // stops a second process opening the same directory, and nothing warns you
  // that you have: the two write over each other and the damage surfaces
  // later as a database that won't open. A one-line script run against
  // ./data/pg while the dev server is up is enough to lose the data — which
  // is exactly how this was found.
  //
  // Postgres's own postmaster.pid can't answer the question. It holds a pid
  // from inside the WASM runtime, which has nothing to do with any process on
  // this machine. So we keep our own, holding a real one.
  claimDataDir(dir);

  // Clear a stale lock left by an unclean shutdown.
  //
  // Postgres writes postmaster.pid while running and removes it on exit. Kill
  // the dev server (Ctrl-C, a crash, `pkill`) and the file survives, after
  // which every subsequent open aborts the process with an unhelpful
  // "Aborted()" — which looks like database corruption and isn't. Safe to
  // delete only because the claim above just proved nothing else is running.
  try {
    rmSync(path.join(dir, "postmaster.pid"), { force: true });
  } catch {
    /* nothing to clear */
  }

  let pg: InstanceType<typeof PGlite>;
  try {
    pg = new PGlite(dir);
    await pg.waitReady;
  } catch (cause) {
    // The embedded database does not survive a hard kill mid-write, and a
    // crash, a `pkill` or closing the terminal all qualify. It then refuses
    // to open, reporting only "Aborted()" — which reads like a bug in your
    // code rather than a damaged data directory.
    //
    // We can't repair it here: the instance that just failed still holds
    // handles on the directory, and Windows won't let anything rename or
    // delete a directory with open handles. Repair belongs to a process that
    // never opened it, which is why `npm run dev` runs scripts/db-check.mjs
    // first. So: say clearly what happened and what fixes it.
    throw new Error(
      `The local database at ${dir} could not be opened, which happens when the ` +
        `server is killed mid-write. Restart with \`npm run dev\` — the health ` +
        `check resets it automatically — or run \`npm run db:reset\`. Local ` +
        `recordings are disposable; nothing else is lost.`,
      { cause },
    );
  }

  // Give it the chance to shut down cleanly so the next start doesn't rely
  // on the recovery above.
  const close = () => {
    releaseDataDir(dir);
    void pg.close().catch(() => {});
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.once("beforeExit", close);

  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await pg.query<T>(sql, params);
      return result.rows;
    },
    async one<T extends Row>(sql: string, params: unknown[] = []): Promise<T | null> {
      const result = await pg.query<T>(sql, params);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
}

/** Our own lock file, holding a pid this machine's kernel knows about. */
const LOCK_FILE = "owner.pid";

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimDataDir(dir: string): void {
  const lock = path.join(dir, LOCK_FILE);

  let holder: number | null = null;
  try {
    holder = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
  } catch {
    /* no lock, or an unreadable one — either way it holds nobody */
  }

  if (holder && holder !== process.pid && Number.isFinite(holder) && isAlive(holder)) {
    throw new Error(
      `The local database at ${dir} is already open in process ${holder}. ` +
        `It is an embedded, single-process database, and a second one writing ` +
        `to it corrupts both. Stop that process first — or, to run two things ` +
        `at once, point them at a real Postgres with DATABASE_URL. To read or ` +
        `change data while the dev server is running, go through its HTTP API ` +
        `rather than opening this directory.`,
    );
  }

  writeFileSync(lock, String(process.pid), "utf8");
}

function releaseDataDir(dir: string): void {
  try {
    const lock = path.join(dir, LOCK_FILE);
    if (Number.parseInt(readFileSync(lock, "utf8").trim(), 10) === process.pid) {
      rmSync(lock, { force: true });
    }
  } catch {
    /* nothing held, or already gone */
  }
}

async function createPg(connectionString: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
    async one<T extends Row>(sql: string, params: unknown[] = []): Promise<T | null> {
      const result = await pool.query(sql, params);
      return (result.rows[0] as T | undefined) ?? null;
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
}

async function initialise(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  const db = url ? await createPg(url) : await createPglite();

  // The schema is idempotent (every statement is IF NOT EXISTS), so running
  // it on every cold start is safe and means there's no migrate step to
  // forget during development.
  const schemaPath = path.resolve(process.cwd(), "../db/schema.sql");
  const fallbackPath = path.resolve(process.cwd(), "db/schema.sql");
  let schema: string;
  try {
    schema = await readFile(schemaPath, "utf8");
  } catch {
    schema = await readFile(fallbackPath, "utf8");
  }
  await db.exec(schema);

  console.log(url ? "db: connected to Postgres" : `db: using embedded Postgres in ${DATA_DIR}/pg`);
  return db;
}

export function getDb(): Promise<Db> {
  if (!globalForDb.__swyDb) globalForDb.__swyDb = initialise();
  return globalForDb.__swyDb;
}
