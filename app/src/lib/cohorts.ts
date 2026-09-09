/**
 * Who it's actually happening to.
 *
 * A human analyst asks this within about thirty seconds: is it everyone, or
 * only Safari, or only phones, or only people arriving from that new ad
 * campaign? Until now the system had no answer, so a browser-specific
 * rendering bug and a universal logic error looked identical — same signature,
 * same page, same shape.
 *
 * That is not a cosmetic gap. "Only on Safari" is often the entire
 * explanation, and it changes what a fix even looks like. It also changes how
 * much a finding should be believed: a commit that broke checkout for
 * everybody and one that broke it for 8% of traffic are different problems
 * with the same symptom.
 *
 * Everything here compares the affected group against everyone who was on the
 * same page. That comparison is what makes a concentration meaningful — if
 * Safari is 80% of the affected sessions and also 80% of your traffic, it is
 * telling you nothing at all.
 */

import { getDb } from "./db";

export type Dimension = "browser" | "device" | "source";

export type Concentration = {
  dimension: Dimension;
  value: string;
  /** Share of affected sessions in this cohort. */
  affectedShare: number;
  /** Share of everyone on the page in this cohort. */
  baselineShare: number;
  affectedCount: number;
  /** How much more common this cohort is among the affected. */
  lift: number;
};

/**
 * Thresholds for calling something concentrated.
 *
 * Three conditions together rather than one clever number. A cohort must be
 * most of the problem, meaningfully over-represented, and big enough not to be
 * noise — any one of those alone produces false alarms, and the combination is
 * easier to defend than a single tuned constant.
 */
const MIN_SHARE = 0.5;
const MIN_LIFT = 1.8;
const MIN_AFFECTED = 5;

/** Browser family from a user agent. Order matters — Edge and Chrome overlap. */
const BROWSER_SQL = `
  CASE
    WHEN s.user_agent ILIKE '%edg/%'                          THEN 'Edge'
    WHEN s.user_agent ILIKE '%chrome%' OR s.user_agent ILIKE '%crios%' THEN 'Chrome'
    WHEN s.user_agent ILIKE '%firefox%' OR s.user_agent ILIKE '%fxios%' THEN 'Firefox'
    WHEN s.user_agent ILIKE '%safari%'                        THEN 'Safari'
    ELSE 'Other'
  END`;

/**
 * Phone, tablet or desktop from the viewport.
 *
 * Viewport rather than the user agent string, because what breaks a layout is
 * how much room it had, not what the browser calls itself.
 */
const DEVICE_SQL = `
  CASE
    WHEN s.viewport_width IS NULL   THEN 'Unknown'
    WHEN s.viewport_width < 768     THEN 'Phone'
    WHEN s.viewport_width < 1024    THEN 'Tablet'
    ELSE 'Desktop'
  END`;

/** Where they came from, collapsed to a host. */
const SOURCE_SQL = `
  CASE
    WHEN s.referrer IS NULL OR s.referrer = '' THEN 'Direct'
    ELSE split_part(split_part(regexp_replace(s.referrer, '^https?://', ''), '/', 1), ':', 1)
  END`;

const DIMENSIONS: Array<{ name: Dimension; sql: string }> = [
  { name: "browser", sql: BROWSER_SQL },
  { name: "device", sql: DEVICE_SQL },
  { name: "source", sql: SOURCE_SQL },
];

/**
 * Find cohorts where a symptom is unusually concentrated.
 *
 * The baseline is everyone who was on the same page in the same window, not
 * everyone on the site — otherwise a checkout problem would look
 * "concentrated" among people who reached checkout at all, which is true and
 * useless.
 */
export async function findConcentrations(
  projectId: string,
  signature: string,
  path: string | null,
  sinceHours = 24,
): Promise<Concentration[]> {
  const db = await getDb();
  const out: Concentration[] = [];

  for (const dimension of DIMENSIONS) {
    const rows = await db.query<{
      value: string;
      affected: number;
      total: number;
    }>(
      `SELECT ${dimension.sql} AS value,
              COUNT(*) FILTER (
                WHERE CASE
                  WHEN s.signature_paths <> '{}'::jsonb
                  THEN COALESCE(s.signature_paths -> $2, '[]'::jsonb) ? COALESCE($3, '')
                    OR ($3::text IS NULL AND $2 = ANY(s.signatures))
                  ELSE $2 = ANY(s.signatures)
                END
              )::int AS affected,
              COUNT(*)::int AS total
         FROM sessions s
        WHERE s.project_id = $1
          AND s.started_at >= now() - ($4 || ' hours')::interval
          AND (
            $3::text IS NULL
            OR $3 = ANY(s.paths)
            OR (s.paths = '{}' AND split_part(split_part(
                 regexp_replace(s.entry_url, '^https?://[^/]+', ''), '?', 1), '#', 1) = $3)
          )
        GROUP BY 1`,
      [projectId, signature, path, String(sinceHours)],
    );

    const totalAffected = rows.reduce((sum, r) => sum + r.affected, 0);
    const totalSessions = rows.reduce((sum, r) => sum + r.total, 0);
    if (totalAffected < MIN_AFFECTED || totalSessions === 0) continue;

    // A single-valued dimension carries no information: if everyone is on
    // Chrome, "it only affects Chrome" is true and worthless.
    if (rows.length < 2) continue;

    for (const row of rows) {
      if (row.affected < MIN_AFFECTED) continue;
      const affectedShare = row.affected / totalAffected;
      const baselineShare = row.total / totalSessions;
      if (baselineShare === 0) continue;
      const lift = affectedShare / baselineShare;

      if (affectedShare >= MIN_SHARE && lift >= MIN_LIFT) {
        out.push({
          dimension: dimension.name,
          value: row.value,
          affectedShare,
          baselineShare,
          affectedCount: row.affected,
          lift,
        });
      }
    }
  }

  // Strongest skew first — that's the one worth leading with.
  return out.sort((a, b) => b.lift - a.lift);
}

export function describeConcentration(c: Concentration): string {
  const affected = Math.round(c.affectedShare * 100);
  const baseline = Math.round(c.baselineShare * 100);
  const noun =
    c.dimension === "browser" ? "" : c.dimension === "device" ? " users" : " traffic";

  return (
    `${affected}% of affected sessions are ${c.value}${noun}, against ${baseline}% of ` +
    `everyone on this page — ${c.lift.toFixed(1)}x over-represented.`
  );
}

/**
 * A one-line qualifier for a claim.
 *
 * "checkout is broken" and "checkout is broken on Safari" are different
 * findings, and the second is the one somebody can act on.
 */
export function qualifier(concentrations: Concentration[]): string | null {
  const strongest = concentrations[0];
  if (!strongest) return null;
  if (strongest.dimension === "browser") return `on ${strongest.value}`;
  if (strongest.dimension === "device") return `on ${strongest.value.toLowerCase()}`;
  return `for traffic from ${strongest.value}`;
}
