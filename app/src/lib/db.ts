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
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
}

const DATA_DIR = process.env.DATA_DIR ?? "./data";

let dbPromise: Promise<Db> | null = null;

async function createPglite(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = path.resolve(DATA_DIR, "pg");
  mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;

  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await pg.query<T>(sql, params);
      return result.rows;
    },
    async one<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await pg.query<T>(sql, params);
      return result.rows[0] ?? null;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
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
    async one<T extends Row>(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return (result.rows[0] as T) ?? null;
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
  if (!dbPromise) dbPromise = initialise();
  return dbPromise;
}
