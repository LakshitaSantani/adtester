/**
 * How far back anything needs to look, worked out rather than chosen.
 *
 * Every connector has to answer "fetch history since when", and the tempting
 * answers are all bad. Asking the user is asking them to do arithmetic on our
 * behalf, using constants they cannot see — the honest version of that
 * question is "how far back does your intent retrieval reach, plus how old
 * can a candidate change be", and nobody should have to know that to connect
 * Slack. Picking a round number instead means the day somebody widens the
 * retrieval window, the ingest quietly stops covering it and evidence goes
 * missing with nothing failing.
 *
 * So the window is computed from the constants the engine already uses. Move
 * one of those and the fetching follows.
 *
 * The shape of the requirement: an investigation looks at a change, then
 * searches for what people said in the run-up to it. The oldest change worth
 * investigating is the change window; the earliest conversation that could
 * explain it is the retrieval lookback before *that*. Add them, and that is
 * the earliest moment any part of this system can still use.
 */

import { retrievalLookbackDays } from "./intent";

/**
 * Re-read this much on every sync, however recent the watermark.
 *
 * A conversation is not finished when we first read it. Someone replies an
 * hour later, and that reply is often the decision — "fine, ship it US-only"
 * arrives after the thread has been sitting quietly. Resuming from exactly
 * where we stopped would miss every one of those, so each sync reaches back
 * over the recent past and re-reads it.
 */
export const RESYNC_OVERLAP_DAYS = 2;

/**
 * A ceiling, because history is unbounded and attention is not.
 *
 * A workspace can hold ten years of messages. Nothing in the engine can use
 * a conversation from 2019 to explain something that broke this morning, and
 * fetching it would cost a long first sync for evidence that can never be
 * retrieved.
 */
const MAX_BACKFILL_DAYS = 120;

/**
 * How far back a first sync should reach.
 *
 * `changeWindowDays` is how old a change can be and still be investigated —
 * seven days for something with a deploy time, thirty when the date is a
 * guess. Pass the largest window the source can produce.
 */
export function backfillDays(changeWindowDays: number): number {
  const { transcript } = retrievalLookbackDays();
  return Math.min(MAX_BACKFILL_DAYS, changeWindowDays + transcript);
}

/**
 * The moment a sync should fetch from.
 *
 * With no watermark this is a first run and reaches back the full backfill.
 * With one, it resumes from there minus the overlap — never from the
 * watermark itself, for the reason above.
 */
export function syncSince(
  lastSyncedAt: Date | string | null,
  changeWindowDays: number,
): Date {
  const backfill = new Date(Date.now() - backfillDays(changeWindowDays) * 86_400_000);
  if (!lastSyncedAt) return backfill;

  const resume = new Date(
    new Date(lastSyncedAt).getTime() - RESYNC_OVERLAP_DAYS * 86_400_000,
  );

  // A watermark older than the backfill means this project has been quiet
  // longer than anything can be used for, so there is no point reaching
  // further back than the backfill would anyway.
  return resume > backfill ? resume : backfill;
}
