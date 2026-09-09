/**
 * Teaching the lexicon the names people actually use.
 *
 * The lexicon is built from the repository, so it knows a file is called
 * PhoneInput.tsx and that a reader might say "phone input". What it cannot
 * know is that this team calls the whole area "Project Falcon", or that the
 * quota service is "the meter" in every meeting. Those names exist nowhere in
 * the code — they are conventions, agreed in a room — and a keyword search
 * built from code vocabulary is blind to them by construction.
 *
 * Note what this is NOT for. Embeddings are the usual answer to a vocabulary
 * gap and they answer a different one: they connect "mobile number" to
 * "phone field" because those mean nearly the same thing. "Falcon" and
 * "org_quotas" do not mean nearly the same thing and no embedding will say
 * they do. A codename is linked to its subject by convention, and the only
 * place that link is written down is the documents themselves.
 *
 * So: read the documents, ask what this team calls things, and write the
 * answers into the lexicon where the existing search will pick them up.
 * Once per sync, not once per investigation.
 */

import { getDb } from "./db";

/** Documents sampled for the mapping. */
const MAX_DOCUMENTS = 40;

/** Characters taken from each, enough for a title and an opening. */
const MAX_DOC_CHARS = 600;

/** Code entities offered as things to be named. */
const MAX_ENTITIES = 150;

/** Aliases kept per entity. More than this and the search stops narrowing. */
const MAX_ALIASES_PER_ENTITY = 3;

/**
 * An alias appearing in more of the corpus than this is not a name for
 * anything, it is a word.
 *
 * "The platform" is a real phrase a team might use for one service, and if it
 * turns up in two thirds of the documents then matching on it retrieves two
 * thirds of the documents — which is the same as not searching. This is the
 * check that keeps a plausible-looking alias from quietly destroying
 * precision.
 */
const MAX_CORPUS_SHARE = 0.25;

const MIN_ALIAS_CHARS = 3;
const MAX_ALIAS_CHARS = 40;

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
 * part that must not quietly regress: an invented alias does not fail
 * loudly, it enters the lexicon as a search term and pulls unrelated
 * passages into every future investigation, where they arrive looking
 * exactly like evidence.
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
    // A name that is just the filename in other words is something the
    // existing lexicon already covers.
    const entity = known.get(path)!;
    if (alias.toLowerCase().replace(/\s+/g, "") === entity.name.toLowerCase()) {
      reject("restates the filename");
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

/**
 * Ask the model what this team calls the things in its codebase.
 *
 * Every answer is checked against the documents it supposedly came from
 * before it is believed. The model is being asked to notice a mapping, not to
 * invent one, and an invented alias is worse than a missing one: it enters
 * the lexicon as a search term and pulls unrelated passages into every future
 * investigation, where they look like evidence.
 */
export async function mineAliases(
  projectId: string,
  apiKey: string | null,
): Promise<MiningResult> {
  const empty: MiningResult = { proposed: 0, accepted: [], rejected: [] };
  if (!apiKey) return empty;

  const db = await getDb();

  // One passage per document: the title carries the codename surprisingly
  // often ("Project Falcon — PRD"), and the opening usually says what it is.
  const documents = await db.query<{ title: string | null; text: string }>(
    `SELECT DISTINCT ON (d.id) d.title, c.text
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE d.project_id = $1
      ORDER BY d.id, c.position ASC
      LIMIT ${MAX_DOCUMENTS}`,
    [projectId],
  );

  if (documents.length === 0) return empty;

  const entities = await db.query<{ path: string; name: string; kind: string }>(
    `SELECT path, name, kind FROM code_entities
      WHERE project_id = $1 AND kind IN ('route', 'api', 'component', 'module')
      ORDER BY kind, path
      LIMIT ${MAX_ENTITIES}`,
    [projectId],
  );

  if (entities.length === 0) return empty;

  const corpus = documents
    .map((d) => `### ${d.title ?? "Untitled"}\n${d.text.slice(0, MAX_DOC_CHARS)}`)
    .join("\n\n");

  const fileList = entities.map((e) => `${e.path} (${e.kind})`).join("\n");

  const prompt = `Below are passages from a team's planning documents, and a list of files in their codebase.

Teams give things names that appear nowhere in their code — a project codename, an internal nickname, the name of the feature as customers see it. Find those, and say which file each one refers to.

Only report a name that ACTUALLY APPEARS in the passages, copied exactly. Do not translate a filename into English: "PhoneInput.tsx" being called "phone input" is not a finding, because a reader could work that out from the filename alone. Report a name only when someone would need to have been in the room to connect the two.

Most files will have no such name. Returning very few, or none, is the expected outcome.

Return JSON only:
{"aliases":[{"path":"<exact path from the list>","alias":"<exact phrase from the passages>"}]}

FILES:
${fileList}

PASSAGES:

${corpus}`;

  let parsed: { aliases?: Array<Record<string, unknown>> };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.log(`mine_aliases: request failed (${response.status})`);
      return empty;
    }

    const body = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = body.content?.map((b) => b.text ?? "").join("") ?? "";
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch (error) {
    console.log("mine_aliases: could not read the model's answer", error);
    return empty;
  }

  const result = screen(parsed.aliases ?? [], entities, corpus);

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
