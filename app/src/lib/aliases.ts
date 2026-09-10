/**
 * Teaching the lexicon the words people actually use.
 *
 * The lexicon is built from the repository, so it knows a file is called
 * PhoneInput.tsx and that a reader might say "phone input". Two kinds of name
 * it cannot know, and both make a document invisible to the intent search no
 * matter how directly it bears on the change:
 *
 *   A codename. This team calls the area "Project Falcon", or the quota
 *   service is "the meter" in every meeting. Those names appear nowhere in
 *   the code — they were agreed in a room.
 *
 *   A paraphrase. The meeting says "mobile number" and the file is
 *   PhoneInput.tsx. Nobody agreed anything; they are simply ordinary English
 *   for the same thing, and no amount of splitting a filename produces them.
 *
 * Embeddings are the usual answer and they only cover the second. "Falcon"
 * and "org_quotas" do not nearly mean the same thing, so no vector will put
 * them together; a codename is linked to its subject by convention, and the
 * only place that link is written down is the documents. Reading the
 * documents covers both, and has a property a general-purpose embedding does
 * not: it learns the vocabulary this team actually uses, rather than every
 * synonym in the language, so the search grows by the handful of phrases that
 * appear in their own corpus.
 *
 * Runs once per sync. Every result is written into the lexicon, where the
 * existing keyword search picks it up with no changes.
 */

import { getDb } from "./db";

/** Documents sampled for the mapping. */
const MAX_DOCUMENTS = 40;

/**
 * Passages taken from each document.
 *
 * One was enough while this only looked for codenames, which live in titles
 * and openings ("Project Falcon — PRD", "Falcon is our quota system"). A
 * paraphrase has no such habit: "mobile number" turns up wherever someone
 * happened to say it, most often in the middle of a call, so the sample has
 * to reach past the opening or the whole class stays invisible.
 */
const CHUNKS_PER_DOCUMENT = 8;

/** Total passages read, across all documents. */
const MAX_CHUNKS = 240;

/** Characters of each passage. */
const MAX_CHUNK_CHARS = 700;

/** Roughly how much text goes into one request. */
const BATCH_CHARS = 14_000;

/** Requests per sync. The ceiling on what this costs to run. */
const MAX_BATCHES = 4;

/** Code entities offered as things to be named. */
const MAX_ENTITIES = 150;

/**
 * Names kept per entity.
 *
 * Higher than it was for codenames alone, because one thing has exactly one
 * codename and several ordinary ways of being referred to — "mobile number",
 * "phone field", "the number box" can all be the same input. The guards
 * below, not this number, are what keep the search narrow.
 */
const MAX_ALIASES_PER_ENTITY = 5;

/**
 * A name appearing in more of the corpus than this is not a name, it is a
 * word.
 *
 * "The platform" is a real phrase a team might use for one service, and if it
 * turns up in two thirds of the documents then matching on it retrieves two
 * thirds of the documents — the same as not searching. This matters more for
 * paraphrases than it did for codenames: a codename is rare by nature, and
 * ordinary English is exactly the thing that can turn out to be everywhere.
 */
const MAX_CORPUS_SHARE = 0.25;

const MIN_ALIAS_CHARS = 3;
const MAX_ALIAS_CHARS = 40;

/**
 * Words that name a category of software rather than a particular thing.
 *
 * The corpus-share rule catches a phrase that is *demonstrably* everywhere,
 * and it needs a corpus to demonstrate it in. "The service", said once in a
 * short document, survives that rule and then matches every future document
 * that says "the service" — which, given long enough, is all of them. The
 * damage arrives later than the evidence for it.
 *
 * This is the same judgement made structurally instead of statistically: a
 * phrase built entirely from these words cannot identify one file, however
 * rare it happens to be today. Domain words are deliberately absent —
 * "checkout", "phone", "quota" and "meter" all name something.
 */
const GENERIC_WORDS = new Set([
  "api", "app", "application", "backend", "box", "button", "client", "code",
  "component", "database", "endpoint", "feature", "field", "file", "flow",
  "form", "frontend", "function", "handler", "input", "library", "module",
  "page", "platform", "product", "project", "repo", "repository", "screen",
  "script", "server", "service", "site", "stuff", "system", "thing", "tool",
  "view", "website",
]);

/** Words carrying no identity of their own, stripped before judging. */
const DETERMINERS = new Set([
  "a", "an", "the", "our", "their", "this", "that", "these", "those", "new", "old",
]);

/**
 * Could this phrase pick out one file, or does it only name a kind of thing?
 *
 * Plural forms are folded in, so "the services" fails for the same reason
 * "the service" does.
 */
function identifiesSomething(alias: string): boolean {
  const words = alias
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !DETERMINERS.has(w));

  if (words.length === 0) return false;
  return words.some((w) => !GENERIC_WORDS.has(w) && !GENERIC_WORDS.has(w.replace(/s$/, "")));
}

export type MinedAlias = { path: string; alias: string };

export type MiningResult = {
  proposed: number;
  accepted: MinedAlias[];
  /** Rejected, with the rule that rejected them — the audit trail. */
  rejected: Array<{ path: string; alias: string; reason: string }>;
};

/**
 * Check every proposal against the documents it supposedly came from.
 *
 * Separated from the request so it can be tested without one. This is the
 * part that must not quietly regress: an invented name does not fail loudly,
 * it enters the lexicon as a search term and pulls unrelated passages into
 * every future investigation, where they arrive looking exactly like
 * evidence.
 *
 * What limits the damage of a wrong one is that retrieval is not the last
 * word. Everything a search turns up goes to verifyMatches, which re-reads it
 * against the change and throws out anything that doesn't genuinely bear on
 * it. A bad alias costs precision here; it cannot on its own produce a
 * finding.
 */
function screen(
  proposals: Array<Record<string, unknown>>,
  entities: Array<{ path: string; name: string }>,
  corpus: string,
): MiningResult {
  const known = new Map(entities.map((e) => [e.path, e]));
  const haystack = corpus.toLowerCase();
  const result: MiningResult = { proposed: 0, accepted: [], rejected: [] };
  const perEntity = new Map<string, number>();

  // A phrase offered for two different files refers to neither reliably.
  //
  // This bites on paraphrases and did not on codenames: a codename belongs to
  // one thing by construction, while "the validator" is a fair description of
  // three files in any codebase. Attaching it to one of them at random would
  // point every future investigation at the wrong code with no way to tell.
  const claimedBy = new Map<string, Set<string>>();
  for (const raw of proposals) {
    const alias = String(raw.alias ?? "").trim().toLowerCase();
    const paths = claimedBy.get(alias) ?? new Set<string>();
    paths.add(String(raw.path ?? ""));
    claimedBy.set(alias, paths);
  }

  for (const raw of proposals) {
    const path = String(raw.path ?? "");
    const alias = String(raw.alias ?? "").trim();
    result.proposed += 1;

    const reject = (reason: string) => result.rejected.push({ path, alias, reason });

    if (!known.has(path)) {
      reject("names a file that wasn't in the list");
      continue;
    }
    if (alias.length < MIN_ALIAS_CHARS || alias.length > MAX_ALIAS_CHARS) {
      reject("implausible length for a name");
      continue;
    }
    // The same rule the intent layer uses on quotes: if it isn't in the
    // source, it didn't come from the source.
    if (!haystack.includes(alias.toLowerCase())) {
      reject("does not appear in the documents");
      continue;
    }
    // A name that is just the filename with the spaces put back is something
    // the lexicon already generates for itself.
    const entity = known.get(path)!;
    if (alias.toLowerCase().replace(/\s+/g, "") === entity.name.toLowerCase()) {
      reject("restates the filename");
      continue;
    }
    if (!identifiesSomething(alias)) {
      reject("names a kind of thing rather than one file");
      continue;
    }
    if ((claimedBy.get(alias.toLowerCase())?.size ?? 1) > 1) {
      reject("offered for more than one file, so it identifies neither");
      continue;
    }
    if ((perEntity.get(path) ?? 0) >= MAX_ALIASES_PER_ENTITY) {
      reject("this file already has enough names");
      continue;
    }

    perEntity.set(path, (perEntity.get(path) ?? 0) + 1);
    result.accepted.push({ path, alias: alias.toLowerCase() });
  }

  return result;
}

/**
 * Exposed so the screening can be checked directly.
 *
 * A live call is slow, costs money and answers differently every time, so a
 * regression here would not show up in any run anyone would think to do.
 */
export function screenForTesting(
  proposals: Array<Record<string, unknown>>,
  entities: Array<{ path: string; name: string }>,
  corpus: string,
): MiningResult {
  return screen(proposals, entities, corpus);
}

function buildPrompt(fileList: string, corpus: string): string {
  return `Below are passages from a team's planning documents and meeting transcripts, and a list of files in their codebase.

Find the words this team uses for the things in that list, so a search of their documents can find the right discussion later. Two kinds are worth reporting:

1. Names that exist only by agreement — a project codename, an internal nickname, the name customers see. Nobody could guess these from the code.
2. Ordinary ways of referring to the same thing that don't share words with the filename. A file called PhoneInput.tsx discussed as "mobile number" is exactly this, and is worth reporting.

Do not report a phrase that is just the filename with the spaces put back: "PhoneInput.tsx" called "phone input" is already handled and is not a finding.

Do not report a phrase so general it could describe most of the codebase — "the service", "the backend", "the form". A phrase is only useful here if reading it would tell someone which file is being discussed.

Only report a phrase that ACTUALLY APPEARS in the passages, copied exactly. If you are unsure which file a phrase refers to, leave it out — a phrase attached to the wrong file is worse than one left behind.

Most files will have nothing. Returning very few, or none, is the expected outcome.

Return JSON only:
{"aliases":[{"path":"<exact path from the list>","alias":"<exact phrase from the passages>"}]}

FILES:
${fileList}

PASSAGES:

${corpus}`;
}

async function propose(
  apiKey: string,
  fileList: string,
  corpus: string,
): Promise<Array<Record<string, unknown>>> {
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
        max_tokens: 2000,
        messages: [{ role: "user", content: buildPrompt(fileList, corpus) }],
      }),
    });

    if (!response.ok) {
      console.log(`mine_aliases: request failed (${response.status})`);
      return [];
    }

    const body = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = body.content?.map((b) => b.text ?? "").join("") ?? "";
    const parsed = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as { aliases?: Array<Record<string, unknown>> };
    return parsed.aliases ?? [];
  } catch (error) {
    console.log("mine_aliases: could not read the model's answer", error);
    return [];
  }
}

/**
 * Ask the model what this team calls the things in its codebase.
 *
 * Every answer is checked against the documents it supposedly came from
 * before it is believed. The model is being asked to notice a mapping, not to
 * invent one.
 */
export async function mineAliases(
  projectId: string,
  apiKey: string | null,
): Promise<MiningResult> {
  const empty: MiningResult = { proposed: 0, accepted: [], rejected: [] };
  if (!apiKey) return empty;

  const db = await getDb();

  // Spread the sample across documents rather than taking whichever ones come
  // first: a single long transcript would otherwise fill the whole budget and
  // every PRD would go unread.
  const passages = await db.query<{ title: string | null; text: string }>(
    `WITH ranked AS (
       SELECT c.document_id, c.position, c.text, d.title,
              row_number() OVER (PARTITION BY c.document_id ORDER BY c.position) AS rn,
              dense_rank() OVER (ORDER BY d.id) AS doc_rank
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.project_id = $1
     )
     SELECT title, text FROM ranked
      WHERE rn <= $2 AND doc_rank <= $3
      ORDER BY document_id, position
      LIMIT $4`,
    [projectId, CHUNKS_PER_DOCUMENT, MAX_DOCUMENTS, MAX_CHUNKS],
  );

  if (passages.length === 0) return empty;

  const entities = await db.query<{ path: string; name: string; kind: string }>(
    `SELECT path, name, kind FROM code_entities
      WHERE project_id = $1 AND kind IN ('route', 'api', 'component', 'module')
      ORDER BY kind, path
      LIMIT ${MAX_ENTITIES}`,
    [projectId],
  );

  if (entities.length === 0) return empty;

  const fileList = entities.map((e) => `${e.path} (${e.kind})`).join("\n");

  // Batched because the whole corpus does not fit in one request, and reading
  // only the openings is what made paraphrases invisible in the first place.
  const batches: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of passages) {
    const block = `### ${p.title ?? "Untitled"}\n${p.text.slice(0, MAX_CHUNK_CHARS)}`;
    if (size + block.length > BATCH_CHARS && current.length > 0) {
      batches.push(current.join("\n\n"));
      current = [];
      size = 0;
    }
    current.push(block);
    size += block.length;
  }
  if (current.length > 0) batches.push(current.join("\n\n"));

  const result: MiningResult = { proposed: 0, accepted: [], rejected: [] };
  const perEntity = new Map<string, number>();
  const takenAliases = new Set<string>();

  for (const corpus of batches.slice(0, MAX_BATCHES)) {
    const proposals = await propose(apiKey, fileList, corpus);
    // Each batch is screened against its own passages, because a phrase is
    // only verifiable against the text it was supposedly read from.
    const screened = screen(proposals, entities, corpus);

    result.proposed += screened.proposed;
    result.rejected.push(...screened.rejected);

    for (const candidate of screened.accepted) {
      // The per-file cap and the one-file rule are per batch inside screen();
      // they have to hold across all of them too.
      if (takenAliases.has(candidate.alias)) {
        result.rejected.push({ ...candidate, reason: "already claimed by another file" });
        continue;
      }
      if ((perEntity.get(candidate.path) ?? 0) >= MAX_ALIASES_PER_ENTITY) {
        result.rejected.push({ ...candidate, reason: "this file already has enough names" });
        continue;
      }
      perEntity.set(candidate.path, (perEntity.get(candidate.path) ?? 0) + 1);
      takenAliases.add(candidate.alias);
      result.accepted.push(candidate);
    }
  }

  // Anything matching a large share of the corpus is a word, not a name.
  const [{ total }] = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM chunks WHERE project_id = $1`,
    [projectId],
  );

  const survivors: MinedAlias[] = [];
  for (const candidate of result.accepted) {
    const [{ hits }] = await db.query<{ hits: number }>(
      `SELECT COUNT(*)::int AS hits FROM chunks
        WHERE project_id = $1 AND position(lower($2) in lower(text)) > 0`,
      [projectId, candidate.alias],
    );
    if (total > 0 && hits / total > MAX_CORPUS_SHARE) {
      result.rejected.push({
        ...candidate,
        reason: `appears in ${Math.round((hits / total) * 100)}% of passages — too common to narrow anything`,
      });
      continue;
    }
    survivors.push(candidate);
  }
  result.accepted = survivors;

  for (const { path, alias } of result.accepted) {
    await db.query(
      `UPDATE code_entities
          SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[$3::text]))
        WHERE project_id = $1 AND path = $2`,
      [projectId, path, alias],
    );
  }

  return result;
}
