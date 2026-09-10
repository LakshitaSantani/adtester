/**
 * What the company is.
 *
 * Without this the investigator has no way to judge whether anything matters.
 * A rage click on /help and a broken checkout look identical to it — same
 * signature, same shape, and it will happily lead with whichever affected more
 * sessions. Knowing which pages make money is what turns a list of anomalies
 * into a ranked answer.
 *
 * Drafted from what's already connected, then confirmed by a person. Both
 * halves matter. Pure inference is confidently wrong in ways nobody notices,
 * because a guess about "what this company does" is never flagged as a guess.
 * A blank form is tedious enough to get skipped. Showing the draft and asking
 * someone to correct it is neither, and it makes a wrong guess visible instead
 * of load-bearing.
 */

import { getDb } from "./db";

export type Profile = {
  whatWeDo: string | null;
  customers: "b2b" | "b2c" | "both" | null;
  revenueModel: "subscription" | "transaction" | "ads" | "one_off" | "other" | null;
  criticalPaths: string[];
  rollout: "gradual" | "all_at_once" | "unsure" | null;
  competitors: string[];
  seasonality: string | null;
  confirmedAt: string | null;
};

export type Draft = {
  /** Routes we guessed are the ones that matter, with why. */
  suggestedPaths: Array<{ path: string; because: string }>;
  /** Every route we found, so someone can pick the ones we missed. */
  allPaths: string[];
  /** A first line about the product, from the documents. */
  suggestedDescription: string | null;
  documentTitles: string[];
};

/**
 * Route names that usually mean money or a make-or-break journey.
 *
 * Deliberately a suggestion rather than a decision — the point of showing the
 * draft is that "billing" might be an internal admin page nobody uses, and
 * only the person who works there knows.
 */
const IMPORTANT = [
  { pattern: /checkout|payment|pay\b|billing|purchase|order/, because: "money changes hands here" },
  { pattern: /signup|sign-up|register|onboard|get-?started/, because: "this is how new customers arrive" },
  { pattern: /pricing|plans?\b|upgrade|subscribe/, because: "people decide whether to pay here" },
  { pattern: /login|signin|sign-in|auth/, because: "everything else is behind this" },
  { pattern: /cart|basket/, because: "the step before money changes hands" },
];

export async function draftProfile(projectId: string): Promise<Draft> {
  const db = await getDb();

  const routes = await db.query<{ route: string }>(
    `SELECT DISTINCT route FROM code_entities
      WHERE project_id = $1 AND route IS NOT NULL
      ORDER BY route`,
    [projectId],
  );

  const suggestedPaths: Draft["suggestedPaths"] = [];
  for (const { route } of routes) {
    const hit = IMPORTANT.find((i) => i.pattern.test(route.toLowerCase()));
    if (hit) suggestedPaths.push({ path: route, because: hit.because });
  }

  const documents = await db.query<{ title: string | null; source: string }>(
    `SELECT title, source FROM documents WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 20`,
    [projectId],
  );

  // The opening of a PRD is usually the closest thing to a product summary
  // that already exists. Offered as a starting point, not an answer.
  const [firstChunk] = await db.query<{ text: string }>(
    `SELECT c.text FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.project_id = $1 AND d.source <> 'transcript'
      ORDER BY c.position LIMIT 1`,
    [projectId],
  );

  return {
    suggestedPaths,
    allPaths: routes.map((r) => r.route),
    suggestedDescription: firstChunk?.text.slice(0, 240) ?? null,
    documentTitles: documents.map((d) => d.title ?? "Untitled"),
  };
}

export async function loadProfile(projectId: string): Promise<Profile | null> {
  const db = await getDb();
  const row = await db.one<{
    what_we_do: string | null;
    customers: string | null;
    revenue_model: string | null;
    critical_paths: string[];
    rollout: string | null;
    competitors: string[];
    seasonality: string | null;
    confirmed_at: string | null;
  }>(
    `SELECT what_we_do, customers, revenue_model, critical_paths, rollout,
            competitors, seasonality, confirmed_at::text
       FROM company_profile WHERE project_id = $1`,
    [projectId],
  );
  if (!row) return null;

  return {
    whatWeDo: row.what_we_do,
    customers: row.customers as Profile["customers"],
    revenueModel: row.revenue_model as Profile["revenueModel"],
    criticalPaths: row.critical_paths ?? [],
    rollout: row.rollout as Profile["rollout"],
    competitors: row.competitors ?? [],
    seasonality: row.seasonality,
    confirmedAt: row.confirmed_at,
  };
}

export async function saveProfile(
  projectId: string,
  profile: Partial<Profile>,
  draft?: Draft,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO company_profile
       (project_id, what_we_do, customers, revenue_model, critical_paths,
        rollout, competitors, seasonality, drafted, confirmed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
     ON CONFLICT (project_id) DO UPDATE SET
       what_we_do = EXCLUDED.what_we_do,
       customers = EXCLUDED.customers,
       revenue_model = EXCLUDED.revenue_model,
       critical_paths = EXCLUDED.critical_paths,
       rollout = EXCLUDED.rollout,
       competitors = EXCLUDED.competitors,
       seasonality = EXCLUDED.seasonality,
       drafted = COALESCE(EXCLUDED.drafted, company_profile.drafted),
       confirmed_at = now(),
       updated_at = now()`,
    [
      projectId,
      profile.whatWeDo ?? null,
      profile.customers ?? null,
      profile.revenueModel ?? null,
      profile.criticalPaths ?? [],
      profile.rollout ?? null,
      profile.competitors ?? [],
      profile.seasonality ?? null,
      JSON.stringify(draft ?? {}),
    ],
  );
}

/**
 * Is this page one the business actually depends on?
 *
 * Deliberately a tier rather than a multiplier. A first attempt weighted
 * critical pages 3x and sorted by the product, which failed the obvious case:
 * eight people stuck in checkout still lost to thirty-four annoyed by the help
 * page. Raising the multiplier until the example came out right would have been
 * fitting a constant to one test, and the number would have been indefensible
 * for every other case.
 *
 * Sorting by tier and then by volume needs no constant at all, and states a
 * rule anyone can check: anything blocking money comes before anything that
 * doesn't, however many people it touched.
 */
export function isCriticalPath(path: string | null, profile: Profile | null): boolean {
  if (!profile || profile.criticalPaths.length === 0 || !path) return false;
  return profile.criticalPaths.some(
    (critical) => path === critical || path.startsWith(`${critical}/`),
  );
}

/**
 * Whether the strongest evidence will ever be available to this team.
 *
 * Worth saying during setup rather than after a week of capped answers: if
 * everyone gets a new build at once there is no control group, and no amount
 * of data will change that.
 */
export function rolloutWarning(profile: Profile | null): string | null {
  if (profile?.rollout !== "all_at_once") return null;
  return (
    "You deploy to everyone at once, so there is never a group still on the old " +
    "build to compare against. Findings will be capped at 0.85 and rely on " +
    "before-and-after comparisons, which can't rule out anything else that " +
    "changed the same day. Rolling out to a fraction of users first — even 10% " +
    "for an hour — is what makes a finding provable rather than circumstantial."
  );
}
