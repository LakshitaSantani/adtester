import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The bundle is served from the app's public folder, so a customer loads one
// file from one origin. Bundling rrweb in (rather than loading it from a CDN)
// means no third-party origin in the customer's CSP and nothing that can
// disappear out from under them.
const outfile = resolve(here, "../../app/public/rec.js");
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(here, "src/index.ts")],
  outfile,
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "iife",
  target: ["es2020", "chrome80", "firefox80", "safari14"],
  legalComments: "none",
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
});

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`rec.js built — ${(bytes / 1024).toFixed(1)} kB (uncompressed)`);
