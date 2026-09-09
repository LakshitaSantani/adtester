import { NextResponse } from "next/server";
import { parseEventsForTesting } from "@/lib/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check that uncheckable claims are actually dropped.
 *
 * The prompt asks for sourced facts; only the parser enforces it. If that
 * filtering ever loosens, the product starts showing plausible-sounding market
 * claims nobody can verify — which would quietly undo the thing that makes the
 * rest of it trustworthy. A live search is too slow and too non-deterministic
 * to catch that, so it is checked against a fixture instead.
 *
 * Development only.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const since = new Date(Date.now() - 45 * 86_400_000);
  const ago = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const cases = [
    { why: "sourced and dated — should be kept", kind: "pricing", occurredOn: ago(10), headline: "Cut entry plan to $9", detail: "was $15", url: "https://rival.example/pricing", dateExact: true },
    { why: "no source URL", kind: "launch", occurredOn: ago(5), headline: "Launched an AI assistant", url: "", dateExact: true },
    { why: "no date", kind: "feature", occurredOn: "", headline: "Added bulk export", url: "https://rival.example/blog", dateExact: true },
    { why: "outside the window", kind: "funding", occurredOn: ago(400), headline: "Raised a Series B", url: "https://rival.example/news", dateExact: true },
    { why: "URL isn't a real link", kind: "other", occurredOn: ago(3), headline: "Something happened", url: "rival.example/no-scheme", dateExact: true },
    { why: "unknown kind — kept, normalised to other", kind: "rumour", occurredOn: ago(2), headline: "Shipped a mobile app", url: "https://rival.example/app", dateExact: false },
  ];

  const kept = parseEventsForTesting(
    JSON.stringify({ events: cases }),
    "Rival",
    since,
  );
  const keptHeadlines = new Set(kept.map((k) => k.headline));

  return NextResponse.json({
    submitted: cases.length,
    kept: kept.length,
    results: cases.map((c) => ({
      why: c.why,
      headline: c.headline,
      kept: keptHeadlines.has(c.headline),
    })),
    normalisedKinds: kept.map((k) => k.kind),
  });
}
