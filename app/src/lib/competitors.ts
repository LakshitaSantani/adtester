/**
 * Finding out who you are actually competing with.
 *
 * The profile used to ask for competitor names and do nothing if you left the
 * box empty, which wastes the one thing this layer already has: a description
 * of what the company does, who buys it, and how it makes money. Anyone who
 * can read that can go and look up who else does it.
 *
 * The more useful half is the competitor nobody typed in. A team knows the
 * two rivals it has been losing deals to for three years; it does not know
 * about the company that launched four months ago and is quietly taking the
 * bottom of its market. That one never gets typed into a settings box,
 * because nobody in the room has heard of it yet — which is exactly why it is
 * worth surfacing.
 *
 * Nothing found here is adopted on its own. Suggestions are proposed, with a
 * reason and a link, and a person decides. A wrong competitor does not fail
 * loudly — it silently spends the next month's research budget looking up a
 * company that has nothing to do with you, and files the results next to your
 * findings as though they were relevant.
 */

import { getDb } from "./db";

/** Names put forward in one run. Enough to be useful, few enough to read. */
const MAX_SUGGESTIONS = 8;

/** Searches per run. The ceiling on what discovery costs. */
const MAX_SEARCHES = 6;

const MIN_NAME_CHARS = 2;
const MAX_NAME_CHARS = 60;

export type CompetitorSuggestion = {
  name: string;
  /** Why this is a competitor, in the model's own words. */
  because: string;
  /** Where it was found. Required — a name with no source is a guess. */
  url: string;
  /** Recently launched, or long established. Shapes how it reads. */
  kind: "established" | "emerging";
};

export type DiscoveryResult = {
  proposed: number;
  suggestions: CompetitorSuggestion[];
  rejected: Array<{ name: string; reason: string }>;
};

/**
 * Everything already known about who this company competes with.
 *
 * Both the names a person typed and the ones previously suggested, so a run
 * doesn't propose the same company every week.
 */
async function alreadyKnown(projectId: string): Promise<Set<string>> {
  const db = await getDb();
  const known = new Set<string>();

  const profile = await db.one<{ competitors: string[] }>(
    `SELECT competitors FROM company_profile WHERE project_id = $1`,
    [projectId],
  );
  for (const c of profile?.competitors ?? []) known.add(c.trim().toLowerCase());

  const seen = await db.query<{ name: string }>(
    `SELECT name FROM competitor_suggestions WHERE project_id = $1`,
    [projectId],
  );
  for (const s of seen) known.add(s.name.trim().toLowerCase());

  return known;
}

/**
 * Check the model's answers before believing any of them.
 *
 * The rule is the same one the market research uses on its claims: a name
 * without a source is not a finding. What differs is what a bad one costs —
 * a fabricated market event is visible nonsense in a report, while a
 * fabricated competitor is a plausible-looking company name that quietly
 * redirects every future search.
 */
export function screenSuggestions(
  raw: Array<Record<string, unknown>>,
  known: Set<string>,
  ourName: string | null,
): DiscoveryResult {
  const result: DiscoveryResult = { proposed: 0, suggestions: [], rejected: [] };
  const taken = new Set<string>();

  for (const item of raw) {
    const name = String(item.name ?? "").trim();
    const because = String(item.because ?? "").trim();
    const url = String(item.url ?? "").trim();
    const kind = item.kind === "emerging" ? "emerging" : "established";
    result.proposed += 1;

    const reject = (reason: string) => result.rejected.push({ name, reason });

    if (name.length < MIN_NAME_CHARS || name.length > MAX_NAME_CHARS) {
      reject("implausible length for a company name");
      continue;
    }
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) {
      reject("no usable source link, so nobody can check it");
      continue;
    }
    if (because.length < 10) {
      reject("no reason given for why this competes");
      continue;
    }
    if (known.has(name.toLowerCase())) {
      reject("already known");
      continue;
    }
    if (taken.has(name.toLowerCase())) {
      reject("suggested twice in the same run");
      continue;
    }
    // Models reliably name the company being researched as its own rival.
    if (ourName && name.toLowerCase() === ourName.trim().toLowerCase()) {
      reject("that is this company");
      continue;
    }
    if (result.suggestions.length >= MAX_SUGGESTIONS) {
      reject("past the number worth reading in one go");
      continue;
    }

    taken.add(name.toLowerCase());
    result.suggestions.push({ name, because: because.slice(0, 300), url, kind });
  }

  return result;
}

/**
 * Search for companies doing what this company does.
 *
 * Asks for both halves deliberately: the established names a team would
 * recognise, which mostly confirm the profile is right, and recent entrants,
 * which are the ones worth the search.
 */
export async function discoverCompetitors(
  projectId: string,
  apiKey: string | null,
): Promise<DiscoveryResult> {
  const empty: DiscoveryResult = { proposed: 0, suggestions: [], rejected: [] };
  if (!apiKey) return empty;

  const db = await getDb();
  const profile = await db.one<{
    what_we_do: string | null;
    customers: string | null;
    revenue_model: string | null;
  }>(
    `SELECT what_we_do, customers, revenue_model
       FROM company_profile WHERE project_id = $1`,
    [projectId],
  );

  // Without a description there is nothing to search on, and guessing from a
  // repository name would produce exactly the confident nonsense this is
  // meant to avoid.
  if (!profile?.what_we_do) return empty;

  const project = await db.one<{ name: string }>(
    `SELECT name FROM projects WHERE id = $1`,
    [projectId],
  );

  const known = await alreadyKnown(projectId);
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Find the companies that compete with this one.

WHAT THEY DO: ${profile.what_we_do}
${profile.customers ? `WHO BUYS IT: ${profile.customers}` : ""}
${profile.revenue_model ? `HOW THEY CHARGE: ${profile.revenue_model}` : ""}
${known.size > 0 ? `ALREADY KNOWN, do not repeat: ${[...known].join(", ")}` : ""}

Search for two kinds, and the second matters more:

1. Established competitors — the names someone in this market would already list.
2. Recent entrants — companies founded or launched in roughly the last two years
   doing something close to this. These are the ones a team is least likely to
   know about, and the reason this search is worth running.

Rules, and they matter more than completeness:
- Only include a company you found a real page for, with a URL. A company you
  are recalling rather than reading about does not count.
- Say specifically what makes it a competitor. "Similar company" is not a reason.
- Do not include this company itself${project?.name ? ` (${project.name})` : ""}.
- Do not include a company that merely sells to the same customers while doing
  something different — a competitor takes the same budget for the same job.
- If you find nothing that qualifies, return an empty list. Today is ${today}.

Return JSON only, no other text:
{"competitors":[{"name":"<company>","kind":"established"|"emerging",
"because":"<what makes this a competitor, one sentence>","url":"<source URL>"}]}`;

  let raw: Array<Record<string, unknown>> = [];
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.log(`discover_competitors: request failed (${response.status})`);
      return empty;
    }

    const body = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = body.content?.map((b) => b.text ?? "").join("") ?? "";
    const parsed = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as { competitors?: Array<Record<string, unknown>> };
    raw = parsed.competitors ?? [];
  } catch (error) {
    console.log("discover_competitors: could not read the model's answer", error);
    return empty;
  }

  const result = screenSuggestions(raw, known, project?.name ?? null);

  for (const s of result.suggestions) {
    await db.query(
      `INSERT INTO competitor_suggestions
         (id, project_id, name, kind, because, url, status)
       VALUES ($1,$2,$3,$4,$5,$6,'proposed')
       ON CONFLICT (project_id, name) DO NOTHING`,
      [`cs_${Math.random().toString(36).slice(2, 12)}`, projectId, s.name, s.kind, s.because, s.url],
    );
  }

  return result;
}

/**
 * Accept or dismiss a suggestion.
 *
 * Accepting copies the name into the profile, which is what the market
 * research actually reads. Dismissing keeps the row so the same company is
 * not proposed again next month.
 */
export async function decideSuggestion(
  projectId: string,
  name: string,
  accept: boolean,
): Promise<void> {
  const db = await getDb();

  await db.query(
    `UPDATE competitor_suggestions SET status = $3, decided_at = now()
      WHERE project_id = $1 AND name = $2`,
    [projectId, name, accept ? "accepted" : "dismissed"],
  );

  if (accept) {
    await db.query(
      `UPDATE company_profile
          SET competitors = ARRAY(SELECT DISTINCT unnest(competitors || ARRAY[$2::text])),
              updated_at = now()
        WHERE project_id = $1`,
      [projectId, name],
    );
  }
}

export async function pendingSuggestions(
  projectId: string,
): Promise<Array<CompetitorSuggestion & { foundAt: string }>> {
  const db = await getDb();
  const rows = await db.query<{
    name: string;
    kind: string;
    because: string;
    url: string;
    found_at: string;
  }>(
    `SELECT name, kind, because, url, found_at::text
       FROM competitor_suggestions
      WHERE project_id = $1 AND status = 'proposed'
      ORDER BY kind DESC, found_at DESC`,
    [projectId],
  );

  return rows.map((r) => ({
    name: r.name,
    kind: r.kind === "emerging" ? "emerging" : "established",
    because: r.because,
    url: r.url,
    foundAt: r.found_at,
  }));
}
