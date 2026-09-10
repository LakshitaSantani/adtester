import { NextResponse } from "next/server";
import { screenSuggestions } from "@/lib/competitors";

export const runtime = "nodejs";

/**
 * Check the competitor screening without spending a search.
 *
 * A fabricated market event is visible nonsense in a report. A fabricated
 * competitor is a plausible company name that gets accepted by someone who
 * assumes we checked, and then quietly redirects every future search. This is
 * where that gets caught, so it has to be testable without the network.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const known = new Set(["northwind pay"]);
  const ourName = "Storefront";

  const cases: Array<{ raw: Record<string, unknown>; expect: "keep" | "drop"; why: string }> = [
    {
      raw: {
        name: "Harbor Checkout",
        kind: "established",
        because: "Sells hosted checkout to independent retail brands on the same per-transaction model.",
        url: "https://example.com/harbor",
      },
      expect: "keep",
      why: "a real rival, with a reason and a source",
    },
    {
      raw: {
        name: "Tidewater",
        kind: "emerging",
        because: "Launched in 2025 doing one-tap checkout for small merchants, undercutting on fees.",
        url: "https://example.com/tidewater/about",
      },
      expect: "keep",
      why: "the case this exists for — a recent entrant nobody would have typed in",
    },
    {
      raw: {
        name: "Meridian Commerce",
        kind: "established",
        because: "A similar company in the same space.",
        url: "https://example.com/meridian",
      },
      expect: "keep",
      why: "a weak reason, but it clears the ten-character bar and a person can judge it",
    },
    {
      raw: { name: "Blackfin Systems", kind: "established", because: "Competes on checkout for small retailers.", url: "" },
      expect: "drop",
      why: "no source — the difference between something found and something recalled",
    },
    {
      raw: { name: "Alder Pay", kind: "established", because: "Similar.", url: "https://example.com/alder" },
      expect: "drop",
      why: "no actual reason given",
    },
    {
      raw: {
        name: "Northwind Pay",
        kind: "established",
        because: "Direct competitor on transaction fees for the same customers.",
        url: "https://example.com/northwind",
      },
      expect: "drop",
      why: "already on the list, so proposing it again is noise",
    },
    {
      raw: {
        name: "Storefront",
        kind: "established",
        because: "Offers checkout and subscriptions to independent brands.",
        url: "https://example.com/self",
      },
      expect: "drop",
      why: "that is this company — models name it as its own rival surprisingly often",
    },
    {
      raw: {
        name: "Tidewater",
        kind: "emerging",
        because: "Also does checkout for small merchants with low fees.",
        url: "https://example.com/tidewater",
      },
      expect: "drop",
      why: "the same company twice in one answer",
    },
    {
      raw: {
        name: "T",
        kind: "established",
        because: "Competes directly on hosted checkout for independents.",
        url: "https://example.com/t",
      },
      expect: "drop",
      why: "not a company name",
    },
  ];

  const result = screenSuggestions(
    cases.map((c) => c.raw),
    known,
    ourName,
  );

  const kept = new Set(result.suggestions.map((s) => s.name));
  const seen = new Set<string>();
  const checked = cases.map((c) => {
    const name = String(c.raw.name ?? "");
    // The duplicate case shares a name with the one that was kept, so the
    // second occurrence is judged by position rather than by name.
    const isRepeat = seen.has(name);
    seen.add(name);
    const actual = !isRepeat && kept.has(name) ? "keep" : "drop";
    return {
      name,
      expected: c.expect,
      actual,
      correct: actual === c.expect,
      why: c.why,
      reason: result.rejected.find((r) => r.name === name)?.reason ?? null,
    };
  });

  return NextResponse.json({
    pass: checked.every((c) => c.correct),
    proposed: result.proposed,
    kept: result.suggestions.map((s) => `${s.name} [${s.kind}]`),
    checked,
  });
}
