// Standalone worker, for when DATABASE_URL points at a real Postgres.
// With PGlite the web process owns the database, so run it there instead
// (that happens automatically — see src/instrumentation.ts).
import { ensureWorker } from "./src/lib/worker.ts";

if (!process.env.DATABASE_URL) {
  console.error(
    "Refusing to start: PGlite can only be opened by one process, and the " +
      "web app already has it. Set DATABASE_URL to run the worker separately.",
  );
  process.exit(1);
}

ensureWorker();
