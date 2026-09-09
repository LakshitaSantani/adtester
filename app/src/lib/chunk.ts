/**
 * Turning documents and transcripts into retrievable pieces.
 *
 * Two shapes, chunked differently because they carry meaning differently:
 *
 *   A PRD argues in sections. Split on headings, and keep the heading with
 *   the body — "must accept international format" is only meaningful under
 *   "Phone number validation".
 *
 *   A transcript argues in turns. Split on speaker changes and keep the
 *   speaker, because "who said this" is half of what makes it evidence.
 *   A concern raised by the tech lead and overruled reads very differently
 *   from the same words in a throwaway aside.
 */

export type Chunk = {
  text: string;
  speaker: string | null;
  /** Milliseconds into the recording, for deep-linking a transcript. */
  offsetMs: number | null;
};

/** Below this a chunk carries no argument, only a fragment. */
const MIN_CHARS = 40;

/** Above this it stops being a quotable span. */
const MAX_CHARS = 1500;

export function isTranscript(filename: string, text: string): boolean {
  if (/\.(vtt|srt)$/i.test(filename)) return true;
  if (/^WEBVTT/m.test(text)) return true;
  // Several lines shaped "Name: something they said".
  const speakerLines = text.split("\n").filter((l) => /^[A-Z][\w .'-]{1,30}:\s+\S/.test(l));
  return speakerLines.length >= 5;
}

export function chunkDocument(text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];

  let heading = "";
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (!body) return;
    // Prefix the heading so a retrieved span reads as a complete claim
    // rather than an orphaned sentence.
    const full = heading ? `${heading}\n${body}` : body;
    for (const piece of split(full)) {
      if (piece.length >= MIN_CHARS) {
        chunks.push({ text: piece, speaker: null, offsetMs: null });
      }
    }
  };

  for (const line of lines) {
    const isHeading = /^#{1,6}\s+\S/.test(line) || /^\s*\d+(\.\d+)*\s+[A-Z]/.test(line);
    if (isHeading) {
      flush();
      heading = line.replace(/^#+\s*/, "").trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return chunks;
}

export function chunkTranscript(text: string): Chunk[] {
  if (/^WEBVTT/m.test(text) || /^\d+\s*$/m.test(text)) {
    const cues = chunkCues(text);
    if (cues.length > 0) return cues;
  }
  return chunkSpeakerLines(text);
}

/** WebVTT and SRT: a timestamp line, then the words. */
function chunkCues(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const blocks = text.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const timeLine = lines.find((l) => /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(l));
    if (!timeLine) continue;

    const body = lines
      .filter((l) => l !== timeLine && !/^\d+$/.test(l.trim()) && !/^WEBVTT/.test(l))
      .join(" ")
      .trim();
    if (body.length < MIN_CHARS) continue;

    const speakerMatch = body.match(/^([A-Z][\w .'-]{1,30}):\s*(.+)$/s);

    chunks.push({
      text: speakerMatch ? speakerMatch[2].trim() : body,
      speaker: speakerMatch ? speakerMatch[1].trim() : null,
      offsetMs: parseTimestamp(timeLine),
    });
  }

  return mergeShortTurns(chunks);
}

/** Plain "Name: what they said" transcripts, as most AI notetakers export. */
function chunkSpeakerLines(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let speaker: string | null = null;
  let buffer: string[] = [];
  let offsetMs: number | null = null;

  const flush = () => {
    const body = buffer.join(" ").trim();
    buffer = [];
    if (body.length >= MIN_CHARS) {
      for (const piece of split(body)) {
        chunks.push({ text: piece, speaker, offsetMs });
      }
    }
  };

  for (const line of text.split(/\r?\n/)) {
    // Leading timestamps like "[00:14:22]" or "00:14:22" are common.
    const stamped = line.match(/^\s*\[?(\d{1,2}:\d{2}(:\d{2})?)\]?\s*(.*)$/);
    const rest = stamped ? stamped[3] : line;
    const at = stamped ? parseClock(stamped[1]) : null;

    const speakerMatch = rest.match(/^([A-Z][\w .'-]{1,30}):\s*(.*)$/);
    if (speakerMatch) {
      flush();
      speaker = speakerMatch[1].trim();
      offsetMs = at;
      if (speakerMatch[2].trim()) buffer.push(speakerMatch[2].trim());
      continue;
    }

    if (at !== null && offsetMs === null) offsetMs = at;
    if (rest.trim()) buffer.push(rest.trim());
  }
  flush();

  return mergeShortTurns(chunks);
}

/**
 * Glue consecutive turns from the same speaker together.
 *
 * A transcript full of "Yeah." and "Right." produces useless chunks on its
 * own; merged, they become the paragraph the person actually said.
 */
function mergeShortTurns(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const last = out[out.length - 1];
    if (
      last &&
      last.speaker === chunk.speaker &&
      last.text.length + chunk.text.length < MAX_CHARS
    ) {
      last.text = `${last.text} ${chunk.text}`;
      continue;
    }
    out.push({ ...chunk });
  }
  return out.filter((c) => c.text.length >= MIN_CHARS);
}

/** Break anything over the cap on paragraph, then sentence boundaries. */
function split(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text.trim()];

  const pieces: string[] = [];
  let current = "";

  for (const para of text.split(/\n\s*\n/)) {
    if (current.length + para.length <= MAX_CHARS) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    if (current) pieces.push(current.trim());

    if (para.length <= MAX_CHARS) {
      current = para;
      continue;
    }
    // Still too long: fall back to sentences.
    current = "";
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      if (current.length + sentence.length > MAX_CHARS) {
        if (current) pieces.push(current.trim());
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function parseTimestamp(line: string): number | null {
  const match = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!match) return null;
  return (
    Number(match[1]) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(match[4])
  );
}

function parseClock(clock: string): number | null {
  const parts = clock.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return null;
}
