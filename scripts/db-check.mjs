/**
 * Verify the embedded database opens, and reset it if it doesn't.
 *
 * Runs before `next dev` starts, and it has to be a separate step for a
 * Windows reason: once a PGlite instance has failed to open a directory, it
 * still holds file handles on it, and Windows refuses to rename or delete a
 * directory with open handles. So the process that repairs the directory
 * must be one that has never touched it.
 *
 * The check therefore happens in a child process. If the child can't open
 * the database, the child exits, its handles go with it, and this parent —
 * which never opened anything — can safely clear the directory.
 *
 * Only ever touches PGlite. With DATABASE_URL set this exits immediately;
 * a real Postgres is never reset by us.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.DATABASE_URL) process.exit(0);

const root = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(root, "..", "app", process.env.DATA_DIR ?? "data", "pg");

if (!existsSync(dir)) process.exit(0);

const probe = `
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(${JSON.stringify(dir)});
  await pg.waitReady;
  await pg.query("select 1");
  await pg.close();
`;

const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
  stdio: "ignore",
  cwd: path.resolve(root, ".."),
});

if (result.status !== 0) {
  console.warn(
    `\n  The local database at ${dir} is damaged and is being reset.\n` +
      `  This happens when the dev server is killed mid-write. Local recordings\n` +
      `  are disposable — everything is recreated on the next request.\n`,
  );
  rmSync(dir, { recursive: true, force: true });
}
