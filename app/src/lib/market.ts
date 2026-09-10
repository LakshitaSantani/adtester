/**
 * What changed outside the repository.
 *
 * The rest of this system can prove things. It compares people who got a
 * change against people who didn't, and when that comparison isn't available
 * it says so and caps itself. That rigour is the whole reason anyone should
 * believe a finding.
 *
 * None of it applies here. You cannot A/B test the market: there is no group
 * of your users who didn't experience a competitor's price cut. Every claim in
 * this file is therefore an OBSERVATION with a date and a source, offered so a
 * person can judge it — never a cause, and never a number on the same scale as
 * a code finding.
 *
 * Two guardrails, both enforced in code rather than asked for in a prompt:
 *
 *   - No date or no working URL, no event. A reader who can't check it should
 *     not be shown it, and a hedge is not a substitute for a citation.
 *   - Dates outside the window asked for are dropped. Search results drift
 *     toward whatever is popular, and an undated blog post from last year
 *     lining up with this week's dip is exactly the false pattern this whole
 *     product exists to avoid.
 *
 * Deliberately not attempted: traffic estimates. The free ones are unreliable
 * enough that quoting them would be worse than saying nothing, and the
 * trustworthy ones are paid APIs the customer would have to bring.
 */

import { getDb } from "./db";
import { newId } from "./ids";

export type MarketEvent = {
  competitor: string;
  kind: "pricing" | "launch" | "feature" | "funding" | "other";
  occurredOn: string;
  headline: string;
  detail: string | null;
  url: string;
  dateExact: boolean;
};

const KINDS = new Set(["pricing", "launch", "feature", "funding", "other"]);

/** How far back a research pass looks. */
const WINDOW_DAYS = 45;

/**
 * Ask Claude to research a competitor, with search, and return only things it
 * can cite.
 *
 * The prompt asks for facts with sources; the parsing below is what actually
 * enforces it. Anything the model returns without a date and a URL is
 * discarded, which makes a plausible-sounding but uncheckable claim
 * structurally impossible to surface rather than merely discouraged.
 */
export async function researchCompetitor(
  competitor: string,
  context: { whatWeDo: string | null; since: Date },
  apiKey: string,
): Promise<MarketEvent[]> {
  const sinceIso = context.since.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Research recent, verifiable changes at ${competitor}${
    context.whatWeDo ? `, a competitor to a company that does: ${context.whatWeDo}` : ""
  }.

Find things that happened between ${sinceIso} and ${today} which could plausibly
affect a competitor's customers:

- price changes, new or removed plans, free tier changes
- product launches and significant new features
- funding, acquisition, or shutdown announcements

Rules, and they matter more than completeness:
- Only include something you found a real source for, with a URL.
- Only include something you can date. If the source has no date, leave it out.
- Do not include anything outside ${sinceIso} to ${today}.
- Do not speculate, infer, or include "they may have". Facts with sources only.
- If you find nothing that qualifies, return an empty list. That is a perfectly
  good answer and much better than a vague one.

Return JSON only, no other text:
{"events":[{"kind":"pricing"|"launch"|"feature"|"funding"|"other",
"occurredOn":"YYYY-MM-DD","headline":"<short factual statement>",
"detail":"<one or two sentences>","url":"<source URL>",
"dateExact":true|false}]}

Set dateExact to false when you inferred the date rather than reading it from
the source.`;

  let text: string;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-3-opus-20240229",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.log(`market: research failed for ${competitor} (${response.status})`);
      return [];
    }

    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  } catch (error) {
    console.log(`market: could not research ${competitor}`, error);
    return [];
  }

  return parseEvents(text, competitor, context.since);
}

/**
 * Keep only what a reader could check.
 *
 * This is where the honesty actually lives. The model is asked for sourced
 * facts, but asking is not enforcing — an event without a date, without a URL,
 * or dated outside the window is dropped here regardless of how convincing it
 * reads.
 */
function parseEvents(text: string, competitor: string, since: Date): MarketEvent[] {
  let parsed: { events?: Array<Record<string, unknown>> };
  try {
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    parsed = JSON.parse(json);
  } catch {
    console.log(`market: unparseable research result for ${competitor}`);
    return [];
  }

  const out: MarketEvent[] = [];
  const now = Date.now();

  for (const raw of parsed.events ?? []) {
    const url = String(raw.url ?? "").trim();
    const occurredOn = String(raw.occurredOn ?? "").trim();
    const headline = String(raw.headline ?? "").trim();

    // A source you can open is the entire basis for showing this at all.
    if (!/^https?:\/\/\S+$/.test(url)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) continue;
    if (!headline) continue;

    const when = new Date(`${occurredOn}T12:00:00Z`).getTime();
    if (Number.isNaN(when)) continue;
    // Search drifts toward whatever is popular rather than whatever is recent.
    // An old post lining up with this week's dip is the exact false pattern
    // this product exists to avoid.
    if (when < since.getTime() || when > now + 86_400_000) continue;

    const kind = String(raw.kind ?? "other");

    out.push({
      competitor,
      kind: (KINDS.has(kind) ? kind : "other") as MarketEvent["kind"],
      occurredOn,
      headline: headline.slice(0, 300),
      detail: raw.detail ? String(raw.detail).slice(0, 800) : null,
      url,
      dateExact: raw.dateExact !== false,
    });
  }

  return out;
}

/**
 * Exposed so the filtering can be checked directly.
 *
 * This is the difference between honest context and confident noise, and it is
 * the one part that must not silently regress — a live search is far too slow
 * and non-deterministic to notice if it did.
 */
export function parseEventsForTesting(
  text: string,
  competitor: string,
  since: Date,
): MarketEvent[] {
  return parseEvents(text, competitor, since);
}

export async function saveEvents(projectId: string, events: MarketEvent[]): Promise<number> {
  const db = await getDb();
  let saved = 0;
  for (const e of events) {
    const result = await db.query(
      `INSERT INTO market_events
         (id, project_id, competitor, kind, occurred_on, headline, detail, url, date_exact)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9)
       ON CONFLICT (project_id, competitor, occurred_on, headline) DO NOTHING
       RETURNING id`,
      [
        newId("mkt"),
        projectId,
        e.competitor,
        e.kind,
        e.occurredOn,
        e.headline,
        e.detail,
        e.url,
        e.dateExact,
      ],
    );
    if (result.length > 0) saved += 1;
  }
  return saved;
}

/**
 * What was happening outside the code when something started going wrong.
 *
 * Returned as context for a person to weigh, never as a ranked cause. A
 * fortnight either side, because a price change takes time to reach anyone and
 * a launch can be noticed before it is announced.
 */
export async function eventsAround(
  projectId: string,
  when: string,
  days = 14,
): Promise<Array<MarketEvent & { daysBefore: number }>> {
  const db = await getDb();
  const rows = await db.query<{
    competitor: string;
    kind: string;
    occurred_on: string;
    headline: string;
    detail: string | null;
    url: string;
    date_exact: boolean;
  }>(
    `SELECT competitor, kind, occurred_on::text, headline, detail, url, date_exact
       FROM market_events
      WHERE project_id = $1
        AND occurred_on BETWEEN ($2::timestamptz - ($3 || ' days')::interval)::date
                            AND ($2::timestamptz + interval '2 days')::date
      ORDER BY occurred_on DESC`,
    [projectId, when, String(days)],
  );

  const anchor = new Date(when).getTime();
  return rows.map((r) => ({
    competitor: r.competitor,
    kind: r.kind as MarketEvent["kind"],
    occurredOn: r.occurred_on,
    headline: r.headline,
    detail: r.detail,
    url: r.url,
    dateExact: r.date_exact,
    daysBefore: Math.round(
      (anchor - new Date(`${r.occurred_on}T12:00:00Z`).getTime()) / 86_400_000,
    ),
  }));
}

export const RESEARCH_WINDOW_DAYS = WINDOW_DAYS;
