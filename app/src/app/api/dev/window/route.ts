import { NextResponse } from "next/server";
import { retrievalLookbackDays } from "@brain/intent";
import { RESYNC_OVERLAP_DAYS, backfillDays, syncSince } from "@brain/window";

export const runtime = "nodejs";

/**
 * Check that nobody has to supply a date.
 *
 * Every connector needs a "fetch since when", and the two easy answers are
 * both wrong: asking the user makes them do arithmetic with constants they
 * cannot see, and hardcoding a round number means the day somebody widens the
 * retrieval window the ingest quietly stops covering it. Evidence then goes
 * missing with nothing failing, which is the worst way for this product to be
 * wrong.
 *
 * So the window is derived, and this is where the derivation is checked.
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const CHANGE_WINDOW = 14;
  const look = retrievalLookbackDays();
  const ago = (d: Date) => Math.round((Date.now() - d.getTime()) / 86_400_000);

  const scenarios = [
    { name: "first ever sync", watermark: null as Date | null, window: CHANGE_WINDOW },
    {
      name: "synced an hour ago",
      watermark: new Date(Date.now() - 3_600_000),
      window: CHANGE_WINDOW,
    },
    {
      name: "synced five days ago",
      watermark: new Date(Date.now() - 5 * 86_400_000),
      window: CHANGE_WINDOW,
    },
    {
      name: "dormant for a year",
      watermark: new Date(Date.now() - 365 * 86_400_000),
      window: CHANGE_WINDOW,
    },
    { name: "git's undated 30d window", watermark: null, window: 30 },
    { name: "an absurd window", watermark: null, window: 900 },
  ].map((s) => ({
    ...s,
    watermark: s.watermark ? `${ago(s.watermark)}d ago` : "none",
    fetchSince: `${ago(syncSince(s.watermark, s.window))}d ago`,
  }));

  const fresh = ago(syncSince(new Date(Date.now() - 3_600_000), CHANGE_WINDOW));
  const stale = ago(syncSince(new Date(Date.now() - 365 * 86_400_000), CHANGE_WINDOW));

  const checks = [
    {
      name: "backfill covers the change window plus the retrieval lookback",
      ok: backfillDays(CHANGE_WINDOW) === CHANGE_WINDOW + look.transcript,
      why: "a conversation older than this can never be retrieved, and one newer must be there",
    },
    {
      name: "a fresh watermark still re-reads the overlap",
      ok: fresh === RESYNC_OVERLAP_DAYS,
      why: "threads gain replies after we read them, and the reply is usually the decision",
    },
    {
      name: "a stale watermark never reaches past the backfill",
      ok: stale === backfillDays(CHANGE_WINDOW),
      why: "a year of silence should not mean a year of fetching",
    },
    {
      name: "an absurd change window is capped",
      ok: backfillDays(900) <= 120,
      why: "history is unbounded; a first sync should still finish",
    },
    {
      name: "incremental sync is far cheaper than a first one",
      ok: fresh < backfillDays(CHANGE_WINDOW),
      why: "the whole point of the watermark",
    },
  ];

  return NextResponse.json({
    pass: checks.every((c) => c.ok),
    derivedFrom: {
      retrievalLookbackDays: look,
      resyncOverlapDays: RESYNC_OVERLAP_DAYS,
      backfillForA14DayChangeWindow: backfillDays(CHANGE_WINDOW),
    },
    scenarios,
    checks,
    note:
      "No date is ever asked for. Change one of the constants above and every " +
      "connector's fetch window follows it.",
  });
}
