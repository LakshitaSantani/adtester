/**
 * Finding something worth investigating.
 *
 * A symptom is a signature that started happening on a page when it wasn't
 * happening before. "Started" is the important word: a page that has always
 * had a 2% rage-click rate isn't news, and telling someone about it wastes
 * the one bit of attention they'll give this product.
 *
 * Comparing a recent window against a baseline window is deliberately the
 * simplest thing that can work. Something cleverer (seasonality, per-cohort
 * baselines, changepoint detection) is only worth building once real traffic
 * has shown this one to be wrong — and at prototype volumes it wouldn't have
 * the data to fit anyway.
 */

import { findConcentrations, qualifier, type Concentration } from "./cohorts";
import { getDb } from "./db";
import { isCriticalPath, loadProfile } from "./profile";

/** How far back "recently" reaches. */
const RECENT_HOURS = 24;

/** How much history counts as "normal", ending where the recent window starts. */
const BASELINE_HOURS = 7 * 24;

/** Below this many affected sessions it's an anecdote, not a pattern. */
const MIN_AFFECTED = 3;

/** The recent rate must be at least this multiple of the baseline rate. */
const MIN_RATE_RATIO = 3;

/**
 * A symptom confined to one page can be traced to the code that serves it.
 * One that shows up everywhere usually means something environmental, and
 * the investigator should decline rather than blame a commit.
 */
const DIFFUSE_PATH_COUNT = 4;

export type Symptom = {
  signature: string;
  /** The page it happens on, or null when it's spread across many. */
  path: string | null;
  /** How many distinct paths show it — the diffuseness measure. */
  pathCount: number;
  startedAt: string;
  affectedSessions: number;
  recentRate: number;
  baselineRate: number;
  /** Sessions showing the signature, newest first. Evidence, and the sample. */
  sessionIds: string[];
  /** What the team said is seasonal, when they told us. */
  seasonalNote?: string | null;
  /**
   * Cohorts the problem is concentrated in, strongest first.
   *
   * "Only on Safari" is frequently the whole explanation, and without it a
   * browser-specific rendering bug is indistinguishable from a universal
   * logic error.
   */
  concentrations: Concentration[];
};

type Row = {
  signature: string;
  path: string | null;
  affected: number;
  total: number;
  first_seen: string;
};

/**
 * (signature, page) pairs for a session, using where each signature actually
 * fired rather than where the session began.
 *
 * Falls back to the entry URL for sessions recorded before signals carried
 * their page, and for imported ones where the source didn't say. That is a
 * worse answer, not a wrong one — it is what we used to do for everything.
 */
const SIGNATURE_PAIRS = `
  SELECT s.id, s.project_id, s.started_at, sig.key AS signature,
         jsonb_array_elements_text(sig.value) AS path
    FROM sessions s, jsonb_each(s.signature_paths) AS sig
   WHERE s.signature_paths <> '{}'::jsonb
  UNION ALL
  SELECT s.id, s.project_id, s.started_at, sig AS signature,
         split_part(split_part(regexp_replace(s.entry_url, '^https?://[^/]+', ''), '?', 1), '#', 1) AS path
    FROM sessions s, unnest(s.signatures) AS sig
   WHERE s.signature_paths = '{}'::jsonb
`;

/**
 * Which pages each session actually visited.
 *
 * This is the denominator, and getting it wrong is the difference between a
 * rate and a coincidence. The obvious denominator — every session on the site
 * — silently mixes in traffic that never came near the page:
 *
 *   Marketing pauses a homepage campaign. Site traffic falls from 10,000 to
 *   2,000. Checkout traffic and checkout errors are both unchanged, but
 *   checkout's "rate" quintuples and we report a regression that never
 *   happened.
 *
 *   A blog post goes viral. Site traffic multiplies, a genuine checkout
 *   failure is divided by ten, and we say nothing.
 *
 * Both are traffic-mix changes wearing a rate's clothing. Dividing by the
 * sessions that reached the page removes the whole class.
 *
 * Same fallback as SIGNATURE_PAIRS: sessions recorded before paths were
 * tracked, and imports that didn't carry them, contribute their entry URL.
 */
const PATH_VISITS = `
  SELECT s.id, s.project_id, s.started_at, p AS path
    FROM sessions s, unnest(s.paths) AS p
   WHERE cardinality(s.paths) > 0
  UNION ALL
  SELECT s.id, s.project_id, s.started_at,
         split_part(split_part(regexp_replace(s.entry_url, '^https?://[^/]+', ''), '?', 1), '#', 1) AS path
    FROM sessions s
   WHERE cardinality(s.paths) = 0
`;

/**
 * Look for signatures that are newly common.
 *
 * Rates are per-session rather than absolute counts, so a quiet Sunday
 * doesn't read as an improvement and a traffic spike doesn't read as a
 * regression.
 */
export async function detectSymptoms(projectId: string): Promise<Symptom[]> {
  const db = await getDb();

  const recent = await db.query<Row>(
    `WITH pairs AS (${SIGNATURE_PAIRS})
     SELECT signature, path,
            COUNT(*)::int AS affected,
            MIN(started_at)::text AS first_seen,
            0::int AS total
       FROM pairs
      WHERE project_id = $1
        AND started_at >= now() - ($2 || ' hours')::interval
      GROUP BY signature, path`,
    [projectId, String(RECENT_HOURS)],
  );

  if (recent.length === 0) return [];

  // Traffic to each page, in both windows, so every rate below is measured
  // against the people who could have seen the problem.
  const visits = await db.query<{
    path: string | null;
    recent_total: number;
    baseline_total: number;
  }>(
    `WITH visits AS (${PATH_VISITS})
     SELECT path,
            COUNT(*) FILTER (
              WHERE started_at >= now() - ($2 || ' hours')::interval
            )::int AS recent_total,
            COUNT(*) FILTER (
              WHERE started_at <  now() - ($2 || ' hours')::interval
                AND started_at >= now() - ($3 || ' hours')::interval
            )::int AS baseline_total
       FROM visits
      WHERE project_id = $1
        AND started_at >= now() - ($3 || ' hours')::interval
      GROUP BY path`,
    [projectId, String(RECENT_HOURS), String(RECENT_HOURS + BASELINE_HOURS)],
  );

  const recentVisits = new Map<string, number>();
  const baselineVisits = new Map<string, number>();
  for (const row of visits) {
    recentVisits.set(row.path ?? "", row.recent_total);
    baselineVisits.set(row.path ?? "", row.baseline_total);
  }

  const baseline = await db.query<{ signature: string; path: string | null; affected: number }>(
    `WITH pairs AS (${SIGNATURE_PAIRS})
     SELECT signature, path, COUNT(*)::int AS affected
       FROM pairs
      WHERE project_id = $1
        AND started_at <  now() - ($2 || ' hours')::interval
        AND started_at >= now() - ($3 || ' hours')::interval
      GROUP BY signature, path`,
    [projectId, String(RECENT_HOURS), String(RECENT_HOURS + BASELINE_HOURS)],
  );

  const baselineBy = new Map<string, number>();
  for (const row of baseline) {
    baselineBy.set(`${row.signature} ${row.path ?? ""}`, row.affected);
  }


  // How many distinct paths each signature touches, for the diffuse check.
  const pathsBySignature = new Map<string, Set<string>>();
  for (const row of recent) {
    const set = pathsBySignature.get(row.signature) ?? new Set<string>();
    set.add(row.path ?? "");
    pathsBySignature.set(row.signature, set);
  }

  const symptoms: Symptom[] = [];

  for (const row of recent) {
    if (row.affected < MIN_AFFECTED) continue;

    const key = `${row.signature} ${row.path ?? ""}`;
    const wasAffected = baselineBy.get(key) ?? 0;

    // Never fewer than the sessions we already know hit this page: the
    // fallback branches of the two CTEs can disagree on an old session, and a
    // rate above 1 would be nonsense rather than an alarming finding.
    const pathKey = row.path ?? "";
    const recentTotal = Math.max(1, recentVisits.get(pathKey) ?? 0, row.affected);
    const baselineTotal = Math.max(baselineVisits.get(pathKey) ?? 0, wasAffected);

    const recentRate = row.affected / recentTotal;
    // With no baseline traffic to this page at all we can't say anything
    // started — treat the baseline rate as zero and let the ratio rule below
    // decide.
    const baselineRate = baselineTotal > 0 ? wasAffected / baselineTotal : 0;

    const isNew = baselineRate === 0;
    const jumped = baselineRate > 0 && recentRate / baselineRate >= MIN_RATE_RATIO;
    if (!isNew && !jumped) continue;

    const sessions = await db.query<{ id: string }>(
      `WITH pairs AS (${SIGNATURE_PAIRS})
       SELECT DISTINCT id, started_at FROM pairs
        WHERE project_id = $1 AND signature = $2 AND path = $3
          AND started_at >= now() - ($4 || ' hours')::interval
        ORDER BY started_at DESC
        LIMIT 200`,
      [projectId, row.signature, row.path ?? "", String(RECENT_HOURS)],
    );

    symptoms.push({
      signature: row.signature,
      path: row.path,
      pathCount: pathsBySignature.get(row.signature)?.size ?? 1,
      startedAt: row.first_seen,
      affectedSessions: row.affected,
      recentRate,
      baselineRate,
      sessionIds: sessions.map((s) => s.id),
      concentrations: await findConcentrations(
        projectId,
        row.signature,
        row.path,
        RECENT_HOURS,
      ),
    });
  }

  // Ranked by what it costs the business, not by how many sessions it touched.
  // Eight people stuck in checkout matters more than forty annoyed by the help
  // page, and without a confirmed profile there is no way to tell those apart —
  // which is how a product ends up leading with the least important thing it
  // found.
  const profile = await loadProfile(projectId);

  // Seasonality was collected during setup and then ignored, which is worse
  // than not asking: the setup page promises it "stops an annual dip being
  // reported as broken code". It cannot suppress a finding on its own — a real
  // regression during a quiet month is still a regression — so it travels with
  // the symptom and is stated in the report for a person to weigh.
  const seasonal = profile?.seasonality?.trim() || null;
  for (const symptom of symptoms) symptom.seasonalNote = seasonal;

  return collapseDiffuse(symptoms).sort((a, b) => {
    const aCritical = isCriticalPath(a.path, profile);
    const bCritical = isCriticalPath(b.path, profile);
    // Tier first: anything blocking money comes before anything that doesn't,
    // however many people the other one touched. Volume only decides between
    // problems of the same kind.
    if (aCritical !== bCritical) return aCritical ? -1 : 1;
    return b.affectedSessions - a.affectedSessions;
  });
}

/**
 * A signature on many pages at once is ONE finding about the whole site, not
 * one finding per page.
 *
 * Without this, a site-wide problem produces an identical report for every
 * page it touches — five copies of "this is too widespread to pin down",
 * which is both useless and the fastest way to teach someone to ignore the
 * product. Collapsing at detection rather than filtering at display keeps the
 * data honest too: what happened really was one thing.
 */
function collapseDiffuse(symptoms: Symptom[]): Symptom[] {
  const bySignature = new Map<string, Symptom[]>();
  for (const symptom of symptoms) {
    const group = bySignature.get(symptom.signature) ?? [];
    group.push(symptom);
    bySignature.set(symptom.signature, group);
  }

  const out: Symptom[] = [];

  for (const [signature, group] of bySignature) {
    const paths = new Set(group.map((s) => s.path ?? ""));
    if (paths.size < DIFFUSE_PATH_COUNT) {
      out.push(...group);
      continue;
    }

    const sessionIds = [...new Set(group.flatMap((s) => s.sessionIds))];
    out.push({
      signature,
      path: null,
      pathCount: paths.size,
      startedAt: group
        .map((s) => s.startedAt)
        .sort()[0],
      affectedSessions: group.reduce((sum, s) => sum + s.affectedSessions, 0),
      recentRate: group.reduce((sum, s) => sum + s.recentRate, 0),
      baselineRate: group.reduce((sum, s) => sum + s.baselineRate, 0),
      sessionIds: sessionIds.slice(0, 200),
      // A site-wide problem is described by where it is, not who it hits.
      concentrations: [],
      seasonalNote: group[0]?.seasonalNote ?? null,
    });
  }

  return out;
}

export function isDiffuse(symptom: Symptom): boolean {
  return symptom.pathCount >= DIFFUSE_PATH_COUNT || symptom.path === null;
}

export function describeSymptom(symptom: Symptom): string {
  const what = symptom.signature.replace(/_/g, " ");
  const who = qualifier(symptom.concentrations);
  // "field retry on /checkout on Safari" is a different finding from "field
  // retry on /checkout", and it is the one somebody can act on.
  const where = symptom.path
    ? `${what} on ${symptom.path}`
    : `${what} across ${symptom.pathCount} pages`;
  return who ? `${where}, ${who}` : where;
}
