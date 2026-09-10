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

/**
 * How far back before a commit to look for the conversation about it.
 *
 * Transcripts and documents get different windows on purpose. A meeting that
 * shaped a change usually happened recently; a PRD is written once and governs
 * work for a quarter, so a fixed month made approved specs invisible to the
 * releases they were written for.
 */
const LOOKBACK_DAYS_TRANSCRIPT = 28;
const LOOKBACK_DAYS_DOCUMENT = 120;

/**
 * A single matching word is worth considering. Two was too strict: it threw
 * away "the phone field is rejecting people", which scores 1 and is exactly
 * the sort of thing we are looking for. The model does the judging; this
 * threshold only decides what it is allowed to see.
 */
const MIN_SCORE = 1;

/** Keyword matches sent for verification. */
const MAX_MATCHES = 8;

/**
 * Slots reserved for documents that matched NOTHING.
 *
 * Keyword matching's real failure isn't ranking, it's blindness: a document
 * that shares no vocabulary with the code is invisible, and we never find out.
 * A team saying "mobile number" while the code says PhoneInput, or a project
 * with an internal name, produces zero overlap and vanishes silently.
 *
 * So every document written in the run-up to the change gets at least one
 * passage in front of the model, whether it matched or not.
 */
const MAX_COVERAGE = 6;

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
export type Candidate = { row: ChunkRow; score: number; terms: string[] };

export type RetrievalStats = {
  /** Passages that existed in the window at all. */
  searched: number;
  documents: number;
  /** Passages that shared vocabulary with the change. */
  matched: number;
  /** Documents that matched nothing and were included anyway. */
  coveredBlind: number;
  /** Documents in the window that never reached the model. */
  unseenDocuments: string[];
  terms: string[];
};

export async function retrieveCandidates(
  projectId: string,
  changedFiles: string[],
  commitMessage: string,
  deployedAt: string | null,
): Promise<{ candidates: Candidate[]; stats: RetrievalStats }> {
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

  const termList = [...terms];
  if (termList.length === 0) {
    return {
      candidates: [],
      stats: {
        searched: 0, documents: 0, matched: 0, coveredBlind: 0,
        unseenDocuments: [], terms: [],
      },
    };
  }

  const before = deployedAt ? new Date(deployedAt) : new Date();
  const transcriptsAfter = new Date(before.getTime() - LOOKBACK_DAYS_TRANSCRIPT * 86_400_000);
  const documentsAfter = new Date(before.getTime() - LOOKBACK_DAYS_DOCUMENT * 86_400_000);

  const rows = await db.query<ChunkRow>(
    `SELECT c.id, c.document_id, c.position, c.text, c.speaker,
            c.occurred_at::text, c.offset_ms, d.title, d.url, d.source
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.project_id = $1
        AND (c.occurred_at IS NULL
             OR (c.occurred_at <= $3::timestamptz
                 AND c.occurred_at >= CASE WHEN d.source = 'transcript'
                                           THEN $2::timestamptz
                                           ELSE $4::timestamptz END))
      LIMIT 4000`,
    [
      projectId,
      transcriptsAfter.toISOString(),
      before.toISOString(),
      documentsAfter.toISOString(),
    ],
  );

  const allScored: Candidate[] = rows.map((row) => {
    const haystack = row.text.toLowerCase();
    const hits = termList.filter((term) => haystack.includes(term));
    // Multi-word phrases are far stronger evidence than a single word:
    // "phone input" matching is meaningful, "input" alone is not.
    const score = hits.reduce((sum, t) => sum + (t.includes(" ") ? 3 : 1), 0);
    return { row, score, terms: hits };
  });

  const matches = allScored
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES);

  // Give every unmatched document one passage anyway — its best-scoring
  // chunk, or its opening if nothing scored at all. This is what stops a
  // document being lost entirely just because it uses different words.
  const representedDocs = new Set(matches.map((m) => m.row.document_id));
  const byDocument = new Map<string, Candidate[]>();
  for (const candidate of allScored) {
    const group = byDocument.get(candidate.row.document_id) ?? [];
    group.push(candidate);
    byDocument.set(candidate.row.document_id, group);
  }

  const blind: Candidate[] = [];
  for (const [documentId, group] of byDocument) {
    if (representedDocs.has(documentId)) continue;
    // Ties break toward the middle of a document, not the start.
    //
    // The opening of a 45-minute call is "can you hear me" and "thanks for
    // joining"; the decision that mattered is somewhere in the middle. Taking
    // position 0 on a tie meant a document with no keyword overlap always
    // offered up its greetings, which is the least useful passage it contains.
    const midpoint = (group.length - 1) / 2;
    const best = [...group].sort(
      (a, b) =>
        b.score - a.score ||
        Math.abs(a.row.position - midpoint) - Math.abs(b.row.position - midpoint),
    )[0];
    if (best) blind.push(best);
  }
  blind.sort((a, b) => b.score - a.score);
  const covered = blind.slice(0, MAX_COVERAGE);

  const unseen = blind.slice(MAX_COVERAGE).map((c) => c.row.title ?? "Untitled");

  const stats: RetrievalStats = {
    searched: rows.length,
    documents: byDocument.size,
    matched: matches.length,
    coveredBlind: covered.length,
    unseenDocuments: [...new Set(unseen)],
    terms: termList,
  };

  return {
    candidates: withConversationalContext(rows, [...matches, ...covered]),
    stats,
  };
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
  matches: Candidate[],
): Candidate[] {
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
  candidates: Candidate[],
  commitMessage: string,
  changedFiles: string[],
  symptom: string,
  apiKey: string | null,
): Promise<IntentMatch[]> {
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
        model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
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
  apiKey: string | null,
): Promise<IntentMatch[]> {
  const { candidates, stats } = await retrieveCandidates(
    projectId,
    commit.files,
    commit.message,
    commit.deployedAt,
  );

  // Say what was and wasn't looked at. Silent recall failure is the worst
  // outcome here — a missing explanation looks identical to "there wasn't
  // one", and nobody would ever know to go and check.
  console.log(
    `intent: ${stats.searched} passages across ${stats.documents} documents, ` +
      `${stats.matched} matched on wording, ${stats.coveredBlind} unmatched documents ` +
      `included anyway` +
      (stats.unseenDocuments.length > 0
        ? ` | NOT looked at: ${stats.unseenDocuments.join(", ")}`
        : ""),
  );

  if (candidates.length === 0) return [];
  return verifyMatches(candidates, commit.message, commit.files, symptom, apiKey);
}
