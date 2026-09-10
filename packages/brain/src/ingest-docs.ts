/**
 * Getting PRDs and transcripts into the chunk table.
 *
 * Upload, plus any markdown already sitting in the connected repo. No Notion
 * or Granola connector yet — those are two more OAuth flows, and the brain
 * can be built and judged without them. What matters now is whether the
 * linking works at all.
 */

import { chunkDocument, chunkTranscript, isTranscript, type Chunk } from "./chunk";
import { getDb } from "./db";
import { newId } from "./ids";

export type IngestResult = {
  documentId: string;
  title: string;
  kind: "prd" | "transcript";
  chunks: number;
};

export async function ingestDocument(
  projectId: string,
  {
    filename,
    text,
    occurredAt,
    url,
    source,
    kind,
  }: {
    filename: string;
    text: string;
    occurredAt?: string | null;
    url?: string | null;
    source?: string;
    /**
     * What this is, when the caller already knows.
     *
     * isTranscript sniffs, because an uploaded file arrives with nothing but
     * a name. A connector is not guessing: a Slack thread is a conversation
     * by construction. Letting it say so matters because the sniff needs five
     * attributed lines before it believes anything, and a four-line thread
     * where somebody said "US-only is fine for now, ship the simple version"
     * would be filed as a document and lose every speaker — which is half of
     * what makes a quote evidence.
     */
    kind?: "prd" | "transcript";
  },
): Promise<IngestResult> {
  const db = await getDb();

  const transcript = kind ? kind === "transcript" : isTranscript(filename, text);
  const chunks: Chunk[] = transcript ? chunkTranscript(text) : chunkDocument(text);

  const title = firstHeading(text) ?? filename.replace(/\.[^.]+$/, "");
  const resolvedKind = transcript ? "transcript" : "prd";

  // Re-ingesting the same thing replaces it. Documents get revised, and two
  // copies of a PRD would both match and double-count as evidence.
  //
  // Identity is the URL when there is one, and the title otherwise. An upload
  // has only its name to be known by; anything a connector fetched has a
  // canonical address, and that is a far better key. Two Slack threads in the
  // same channel on the same day can easily produce the same title, and
  // matching on it would have one silently replace the other — losing a
  // conversation with nothing to show that it happened. Equally, a thread
  // re-read tomorrow to pick up its new replies must land on the same row
  // rather than becoming a second copy that double-counts as evidence.
  const existing = url
    ? await db.one<{ id: string }>(
        `SELECT id FROM documents WHERE project_id = $1 AND url = $2`,
        [projectId, url],
      )
    : await db.one<{ id: string }>(
        `SELECT id FROM documents WHERE project_id = $1 AND title = $2 AND source = $3`,
        [projectId, title, source ?? resolvedKind],
      );
  if (existing) {
    await db.query(`DELETE FROM chunks WHERE document_id = $1`, [existing.id]);
    await db.query(`DELETE FROM documents WHERE id = $1`, [existing.id]);
  }

  const documentId = newId("doc");
  const when = occurredAt ?? guessDate(text, filename);

  await db.query(
    `INSERT INTO documents (id, project_id, source, title, url, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [documentId, projectId, source ?? resolvedKind, title, url ?? null, when],
  );

  for (const [position, chunk] of chunks.entries()) {
    await db.query(
      `INSERT INTO chunks (id, project_id, document_id, text, speaker, occurred_at, offset_ms, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId("chk"),
        projectId,
        documentId,
        chunk.text,
        chunk.speaker,
        // A chunk inherits the document's date. For a meeting that is when it
        // happened, which is what time-proximity scoring needs.
        when,
        chunk.offsetMs,
        position,
      ],
    );
  }

  return { documentId, title, kind: resolvedKind, chunks: chunks.length };
}

function firstHeading(text: string): string | null {
  const match = text.match(/^#{1,3}\s+(.+)$/m);
  return match ? match[1].trim().slice(0, 120) : null;
}

/**
 * A date from the filename or the first lines.
 *
 * Meeting notes are usually named or headed with their date, and knowing when
 * something was said is most of what makes it relevant to a change that
 * shipped afterwards.
 */
function guessDate(text: string, filename: string): string | null {
  const haystack = `${filename}\n${text.slice(0, 500)}`;
  const iso = haystack.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`;

  const written = haystack.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(20\d{2})/i,
  );
  if (written) {
    const parsed = new Date(`${written[1]} ${written[2]}, ${written[3]} 12:00:00 UTC`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}
