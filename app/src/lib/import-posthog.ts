/**
 * Importing a PostHog account into the shape the investigator expects.
 *
 * Once a recording lands in `sessions` with its events on disk, nothing
 * downstream knows or cares where it came from — symptom detection, the code
 * path filter, the counterfactual and the confidence model all run unchanged.
 * That is the point of doing the translation here rather than teaching the
 * brain about PostHog.
 */

import { getDb } from "./db";
import { newSessionId } from "./ids";
import * as ph from "./posthog";
import {
  extractSignals,
  findRelease,
  normalizeEvent,
  pathFromHref,
  type RrwebEvent,
} from "./rrweb-signals";
import { appendEvents } from "./storage";

export type ImportSummary = {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  withRelease: number;
  releaseProperty: string | null;
  signatureCounts: Record<string, number>;
};

export async function importFromPostHog(
  projectId: string,
  config: ph.PostHogConfig,
  { limit = 100, afterDays = 30 }: { limit?: number; afterDays?: number } = {},
): Promise<ImportSummary> {
  const db = await getDb();

  const summary: ImportSummary = {
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    withRelease: 0,
    releaseProperty: null,
    signatureCounts: {},
  };

  // Find the build version first, because it decides whether any of this can
  // support a counterfactual — and therefore whether the investigator will be
  // able to do more than guess.
  let releases = new Map<string, string>();
  try {
    const detected = await ph.detectReleaseProperty(config);
    if (detected) {
      summary.releaseProperty = detected.property;
      releases = await ph.releasesBySession(config, detected.property, afterDays);
      console.log(
        `posthog: build version found in properties.${detected.property} ` +
          `(e.g. "${detected.sample}") for ${releases.size} sessions`,
      );
    } else {
      console.log(
        "posthog: no build-version property found. Sessions will import fine, " +
          "but with nothing to compare builds against the investigator will cap " +
          "its confidence at 0.70 and say so.",
      );
    }
  } catch (error) {
    // Version hunting is a bonus. Never let it stop the import.
    console.log("posthog: could not query for a build version", error);
  }

  const recordings = await ph.listRecordings(config, { limit, afterDays });
  summary.scanned = recordings.length;

  for (const recording of recordings) {
    // Already imported? Recordings are immutable once finished, so there is
    // nothing to update — skipping keeps a re-sync cheap.
    const existing = await db.one<{ id: string }>(
      `SELECT id FROM sessions
        WHERE project_id = $1 AND source = 'posthog' AND external_id = $2`,
      [projectId, recording.id],
    );
    if (existing) {
      summary.skipped += 1;
      continue;
    }

    try {
      const raw = await ph.fetchSnapshots(config, recording.id);
      const events = raw
        .map(normalizeEvent)
        .filter((e): e is RrwebEvent => e !== null);

      if (events.length < 2) {
        // Too little to replay and nothing to analyse.
        summary.skipped += 1;
        continue;
      }

      const signals = extractSignals(events);
      const release =
        releases.get(recording.id) ??
        findRelease(recording as unknown as Record<string, unknown>);

      if (release) summary.withRelease += 1;
      for (const signature of signals.signatures) {
        summary.signatureCounts[signature] = (summary.signatureCounts[signature] ?? 0) + 1;
      }

      const sessionId = newSessionId();
      await appendEvents(sessionId, events);

      const entryUrl = recording.startUrl ?? signals.urls[0] ?? null;
      const endedAt =
        recording.endTime ??
        (signals.endedAt ? new Date(signals.endedAt).toISOString() : recording.startTime);

      // An imported session with no paths is indistinguishable from a
      // single-page one that never navigated, so fall back to the entry URL
      // rather than leaving the array empty — an empty array reads as "we
      // know it visited nothing", which is never true.
      const entryPath = entryUrl ? (pathFromHref(entryUrl) ?? null) : null;
      const visitedPaths =
        signals.paths.length > 0 ? signals.paths : entryPath ? [entryPath] : [];

      await db.query(
        `INSERT INTO sessions
           (id, project_id, source, external_id, release, started_at, last_event_at,
            closed_at, close_reason, entry_url, event_count, signatures, error_count,
            signature_paths, paths, api_paths)
         VALUES ($1,$2,'posthog',$3,$4,$5,$6,$6,'imported',$7,$8,$9,$10,
                 $11::jsonb,$12::text[],$13::text[])`,
        [
          sessionId,
          projectId,
          recording.id,
          release,
          recording.startTime,
          endedAt,
          entryUrl,
          signals.eventCount,
          signals.signatures,
          // PostHog counts console errors itself; prefer its number when we
          // found none, since it sees logs the snapshot stream may not carry.
          signals.errorCount || recording.consoleErrorCount,
          JSON.stringify(signals.signaturePaths),
          visitedPaths,
          signals.apiPaths,
        ],
      );

      // A console error PostHog saw but our extraction missed still means the
      // session is worth looking at.
      if (signals.errorCount === 0 && recording.consoleErrorCount > 0) {
        await db.query(
          `UPDATE sessions
              SET signatures = ARRAY(SELECT DISTINCT unnest(signatures || ARRAY['js_error']))
            WHERE id = $1`,
          [sessionId],
        );
        summary.signatureCounts.js_error = (summary.signatureCounts.js_error ?? 0) + 1;
      }

      summary.imported += 1;
    } catch (error) {
      summary.failed += 1;
      console.log(`posthog: could not import recording ${recording.id}`, error);
    }
  }

  return summary;
}
