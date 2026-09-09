import { NextResponse } from "next/server";
import {
  parseBarrel,
  parseImports,
  resolveThroughBarrels,
  type BarrelMap,
} from "@/lib/lexicon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check that a named import is routed past a barrel to the file that actually
 * defines it.
 *
 * This is worth checking directly because it fails quietly. A barrel that
 * re-exports fifty components makes all fifty reachable from anything that
 * imports one, which doesn't break anything — it just lets irrelevant commits
 * through the code-path filter until the narrowing stops narrowing.
 *
 * Development only.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  // A small repository shaped the way real ones are: a page importing one
  // component from a barrel that re-exports many.
  const files: Record<string, string> = {
    "app/checkout/page.tsx": `import { PhoneInput } from "@/ui";\nimport Legal from "@/ui/Legal";`,
    "ui/index.ts": [
      `export { PhoneInput } from "./PhoneInput";`,
      `export { Button } from "./Button";`,
      `export { Modal } from "./Modal";`,
      `export { Table } from "./Table";`,
      `export * from "./icons";`,
    ].join("\n"),
    "ui/PhoneInput.tsx": "export const PhoneInput = () => null;",
    "ui/Button.tsx": "export const Button = () => null;",
    "ui/Modal.tsx": "export const Modal = () => null;",
    "ui/Table.tsx": "export const Table = () => null;",
    "ui/Legal.tsx": "export default () => null;",
    "ui/icons/index.ts": `export { Star } from "./Star";`,
    "ui/icons/Star.tsx": "export const Star = () => null;",
  };

  const known = new Set(Object.keys(files));
  const barrels = new Map<string, BarrelMap>();
  for (const [path, source] of Object.entries(files)) {
    if (/(^|\/)index\.(tsx?|jsx?|mjs)$/.test(path)) {
      barrels.set(path, parseBarrel(source));
    }
  }

  const entry = "app/checkout/page.tsx";
  const refs = parseImports(files[entry]);

  const routed: string[] = [];
  const naive: string[] = [];

  for (const ref of refs) {
    for (const target of resolveThroughBarrels(entry, ref, known, barrels, [])) {
      if (!routed.includes(target)) routed.push(target);
    }
    // What the old behaviour produced: land on the barrel, then everything it
    // re-exports becomes reachable one hop later.
    if (ref.specifier === "@/ui") {
      naive.push("ui/index.ts", "ui/PhoneInput.tsx", "ui/Button.tsx", "ui/Modal.tsx", "ui/Table.tsx", "ui/icons/index.ts");
    }
  }

  return NextResponse.json({
    imported: refs.map((r) => ({ from: r.specifier, names: r.names, wholeModule: r.wholeModule })),
    routedTo: routed,
    wouldHaveReachedBefore: [...new Set(naive)],
    correct:
      routed.includes("ui/PhoneInput.tsx") &&
      !routed.includes("ui/Button.tsx") &&
      !routed.includes("ui/Modal.tsx"),
  });
}
