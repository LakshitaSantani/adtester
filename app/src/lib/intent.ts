/**
 * Linking a change in the code to what people said they were building.
 *
 * This is the part no other tool can do, and the part most likely to produce
 * confident nonsense. A language model handed a pile of transcripts and a
 * diff will ALWAYS find a connection — that is what it is for. Fluent,
 * specific, and wrong.
 *
 * Three structural defences, none of them prompt wording:
 *
 *   1. Retrieval runs against a candidate set already narrowed to two or
 *      three commits by exact evidence. The model is asked a small question,
 *      not an open one.
 *   2. It must quote an exact span from the source or return nothing. A
 *      summary can be invented; a quote can be checked, and the reader can
 *      click through to the moment it was said.
 *   3. Whatever it finds explains but never scores. Intent is not allowed to
 *      move the confidence number by a single point.
 *
 * That third rule is the load-bearing one. A PRD saying "must accept
 * international format" next to code that doesn't is enormously persuasive to
 * a human reader, and proves nothing whatever about why a metric moved.
 */

import { getDb } from "./db";

/** How far back before a commit to look for the conversation about it. */
const LOOKBACK_DAYS = 28;

/** Chunks scoring below this aren't worth a model call. */
const MIN_SCORE = 2;

/** Never send more than this to be verified, per commit. */
const MAX_CANDIDATES = 12;

export type IntentMatch = {
  chunkId: string;
  documentTitle: string;
  documentUrl: string | null;
  source: string;
  speaker: string | null;
  occurredAt: string | null;
  offsetMs: number | null;
  /** The exact span, verbatim from the source. Never paraphrased. */
  quote: string;
  /** What this passage is: a requirement, a decision, or a concern raised. */
  kind: "requirement" | "decision" | "concern";
  /** One line on how it bears on the change. */
  relevance: string;
};

type ChunkRow = {
  id: string;
  document_id: string;
  position: number;
  text: string;
  speaker: string | null;
  occurred_at: string | null;
  offset_ms: number | null;
  title: string | null;
  url: string | null;
  source: string;
};

/** Turns either side of a match to pull in for context. */
const CONTEXT_TURNS = 2;

/**
 * Find passages worth asking about.
 *
 * Scored by how many of the change's own words appear in the passage, using
 * the lexicon built from the repo — which exists precisely for this. Nobody
 * says "src/checkout/validation.ts" in a meeting; they say "the phone thing",
 * and the lexicon is what connects the two.
 *
 * Deliberately keyword matching rather than embeddings. The candidate set is
 * already tiny and the vocabulary comes from the customer's own code, so the
 * cleverer approach would add an API dependency and a vector index to solve a
 * problem this doesn't have yet. Worth revisiting if recall proves poor.
 */
export async function retrieveCandidates(
  projectId: string,
  changedFiles: string[],
  commitMessage: string,
  deployedAt: string | null,
): Promise<Array<{ row: ChunkRow; score: number; terms: string[] }>> {
  const db = await getDb();

  const entities = await db.query<{ aliases: string[]; name: string }>(
    `SELECT aliases, name FROM code_entities
      WHERE project_id = $1 AND path = ANY($2::text[])`,
    [projectId, changedFiles],
  );

  // The words a person might use for what this commit touched, plus the
  // words the author themselves used in the commit message.
  const terms = new Set<string>();
  for (const entity of entities) {
    for (const alias of entity.aliases) if (alias.length > 2) terms.add(alias.toLowerCase());
    if (entity.name.length > 2) terms.add(entity.name.toLowerCase());
  }
  for (const word of commitMessage.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (!COMMON_WORDS.has(word)) terms.add(word);
  }

  if (terms.size === 0) return [];

  const before = deployedAt ? new Date(deployedAt) : new Date();
  const after = new Date(before.getTime() - LOOKBACK_DAYS * 86_400_000);

  const rows = await db.query<ChunkRow>(
    `SELECT c.id, c.document_id, c.position, c.text, c.speaker,
            c.occurred_at::text, c.offset_ms, d.title, d.url, d.source
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.project_id = $1
        AND (c.occurred_at IS NULL
             OR (c.occurred_at >= $2::timestamptz AND c.occurred_at <= $3::timestamptz))
      LIMIT 4000`,
    [projectId, after.toISOString(), before.toISOString()],
  );

  const scored = rows
    .map((row) => {
      const haystack = row.text.toLowerCase();
      const hits = [...terms].filter((term) => haystack.includes(term));
      // Multi-word phrases are far stronger evidence than a single word:
      // "phone input" matching is meaningful, "input" alone is not.
      const score = hits.reduce((sum, t) => sum + (t.includes(" ") ? 3 : 1), 0);
      return { row, score, terms: hits };
    })
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  return withConversationalContext(rows, scored);
}

/**
 * Pull in the turns around a transcript match.
 *
 * Keyword matching finds where a subject was RAISED, because that is where
 * the code's own vocabulary appears. It systematically misses the reply —
 * and the reply is usually the decision. Somebody says "the phone validation
 * needs to handle international numbers" and is answered with "US-only is
 * fine for now", which shares not one word with the code it produced.
 *
 * Neighbours join at score 0 so they can never outrank a real match; they
 * are there to be read alongside one.
 */
function withConversationalContext(
  all: ChunkRow[],
  matches: Array<{ row: ChunkRow; score: number; terms: string[] }>,
): Array<{ row: ChunkRow; score: number; terms: string[] }> {
  const chosen = new Map(matches.map((m) => [m.row.id, m]));

  for (const match of matches) {
    if (match.row.source !== "transcript") continue;
    for (const other of all) {
      if (other.document_id !== match.row.document_id) continue;
      if (chosen.has(other.id)) continue;
      const distance = Math.abs(other.position - match.row.position);
      if (distance > 0 && distance <= CONTEXT_TURNS) {
        chosen.set(other.id, { row: other, score: 0, terms: [] });
      }
    }
  }

  // Document order within a conversation, so the exchange reads as one.
  return [...chosen.values()].sort((a, b) => {
    if (a.row.document_id !== b.row.document_id) return b.score - a.score;
    return a.row.position - b.row.position;
  });
}

const COMMON_WORDS = new Set([
  "this", "that", "with", "from", "into", "when", "then", "have", "been",
  "make", "made", "code", "test", "tests", "update", "updates", "updated",
  "change", "changes", "changed", "small", "minor", "revert", "merge",
  "branch", "master", "main", "pull", "request", "release", "version",
]);

/**
 * Ask a model whether a passage genuinely bears on a change.
 *
 * Narrow question, narrow answer, and the quote must be verbatim from the
 * passage — anything that isn't a substring of the source is dropped, which
 * makes a fabricated citation structurally impossible rather than merely
 * discouraged.
 */
export async function verifyMatches(
  candidates: Array<{ row: ChunkRow; score: number; terms: string[] }>,
  commitMessage: string,
  changedFiles: string[],
  symptom: string,
): Promise<IntentMatch[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || candidates.length === 0) return [];

  const numbered = candidates
    .map(
      (c, i) =>
        `[${i}] source=${c.row.source}` +
        (c.row.speaker ? ` speaker=${c.row.speaker}` : "") +
        (c.row.occurred_at ? ` when=${c.row.occurred_at.slice(0, 10)}` : "") +
        `\n${c.row.text}`,
    )
    .join("\n\n---\n\n");

  const prompt = `A code change is suspected of causing a problem.

CHANGE: ${commitMessage}
FILES: ${changedFiles.slice(0, 10).join(", ")}
PROBLEM: ${symptom}

Below are passages from the team's planning documents and meeting transcripts.
For each one, decide whether it states something that genuinely bears on THIS
change — a requirement it should have met, a decision that shaped it, or a
concern someone raised about it.

Most passages will be irrelevant. Say so. Only return a passage if a reader
would agree it is clearly about this change.

Return JSON only:
{"matches":[{"index":<number>,"kind":"requirement"|"decision"|"concern",
"quote":"<exact substring copied verbatim from the passage>",
"relevance":"<one sentence on how it bears on this change>"}]}

If none are relevant return {"matches":[]}.

PASSAGES:

${numbered}`;

  let parsed: { matches?: Array<Record<string, unknown>> };
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
      console.log(`intent: model call failed (${response.status})`);
      return [];
    }

    const data = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.map((c) => c.text ?? "").join("") ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    parsed = JSON.parse(json);
  } catch (error) {
    // Intent is an enrichment. Never let it fail an investigation.
    console.log("intent: could not verify matches", error);
    return [];
  }

  const out: IntentMatch[] = [];

  for (const match of parsed.matches ?? []) {
    const index = Number(match.index);
    const candidate = candidates[index];
    if (!candidate) continue;

    const quote = String(match.quote ?? "").trim();
    if (!quote) continue;

    // The whole defence: a quote that isn't actually in the source is a
    // fabrication, and gets dropped rather than shown.
    if (!candidate.row.text.includes(quote)) {
      console.log("intent: dropped a quote that wasn't in the source");
      continue;
    }

    const kind = String(match.kind);
    if (kind !== "requirement" && kind !== "decision" && kind !== "concern") continue;

    out.push({
      chunkId: candidate.row.id,
      documentTitle: candidate.row.title ?? "Untitled",
      documentUrl: candidate.row.url,
      source: candidate.row.source,
      speaker: candidate.row.speaker,
      occurredAt: candidate.row.occurred_at,
      offsetMs: candidate.row.offset_ms,
      quote,
      kind,
      relevance: String(match.relevance ?? "").slice(0, 300),
    });
  }

  return out;
}

/** Retrieve then verify, for one commit. */
export async function findIntent(
  projectId: string,
  commit: { sha: string; message: string; files: string[]; deployedAt: string | null },
  symptom: string,
): Promise<IntentMatch[]> {
  const candidates = await retrieveCandidates(
    projectId,
    commit.files,
    commit.message,
    commit.deployedAt,
  );
  if (candidates.length === 0) return [];
  return verifyMatches(candidates, commit.message, commit.files, symptom);
}
