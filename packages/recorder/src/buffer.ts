/**
 * The event buffer and its size accounting.
 *
 * Straight from Milana's design: events are serialized to a string ON
 * ARRIVAL (not at send time) so the buffer can be measured cheaply, and the
 * caps exist to protect the host page rather than to save us money. Going
 * over a cap ends the recording rather than silently dropping events, and
 * reports the fact — a visible failure beats an invisible one.
 */

export type BufferedEvent = {
  serialized: string;
  timestamp: number;
};

/** Don't wait for the timer if the buffer is already this big. */
export const FLUSH_AT_CHARS = 512 * 1024;

/** Never let the buffer exceed this. */
export const MAX_BUFFER_CHARS = 8 * 1024 * 1024;

/** A single event bigger than this is pathological — usually a data: URI. */
export const MAX_EVENT_CHARS = 2 * 1024 * 1024;

/**
 * Browsers cap the combined body size of in-flight keepalive requests at
 * 64KB across the whole document. The visibility flush owns that budget.
 */
export const MAX_KEEPALIVE_CHARS = 60 * 1024;

export type PushResult = "ok" | "flush" | "abort-event-too-large" | "abort-buffer-full";

export class EventBuffer {
  private events: BufferedEvent[] = [];
  private chars = 0;

  get length(): number {
    return this.events.length;
  }

  get size(): number {
    return this.chars;
  }

  push(event: { timestamp?: number }): PushResult {
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch {
      return "ok"; // unserializable event — drop it, keep recording
    }

    if (serialized.length > MAX_EVENT_CHARS) {
      return "abort-event-too-large";
    }

    this.events.push({
      serialized,
      timestamp: event.timestamp ?? Date.now(),
    });
    this.chars += serialized.length;

    if (this.chars > MAX_BUFFER_CHARS) return "abort-buffer-full";
    if (this.chars >= FLUSH_AT_CHARS) return "flush";
    return "ok";
  }

  /** A snapshot for sending. Events stay in the buffer until confirmed. */
  snapshot(): BufferedEvent[] {
    return this.events.slice();
  }

  /**
   * Remove the first `count` events. Only called after a successful send —
   * losing data is preferable to duplicating it, so we never remove
   * optimistically.
   */
  commit(count: number): void {
    const removed = this.events.splice(0, count);
    let freed = 0;
    for (const e of removed) freed += e.serialized.length;
    this.chars = Math.max(0, this.chars - freed);
  }

  clear(): void {
    this.events = [];
    this.chars = 0;
  }

  /**
   * Build the wire payload without re-serializing anything — the events are
   * already strings, so this is a join rather than a full JSON.stringify of
   * the whole batch.
   */
  static buildPayload(
    events: BufferedEvent[],
    sessionId: string,
    extra?: Record<string, unknown>,
  ): string {
    const startedAt = events[0]?.timestamp ?? Date.now();
    const body = events.map((e) => e.serialized).join(",");
    const extraJson = extra
      ? Object.entries(extra)
          .map(([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`)
          .join("")
      : "";
    return `{"v":1,"sessionId":${JSON.stringify(sessionId)},"batchStartedAt":${startedAt}${extraJson},"events":[${body}]}`;
  }
}

/**
 * gzip the payload where the browser supports it. Only on https, because
 * CompressionStream isn't available in insecure contexts. Falls back to the
 * raw string on any failure — compression is an optimisation, never a
 * requirement.
 */
export async function maybeCompress(
  payload: string,
): Promise<{ body: string | Blob; encoding: string | null }> {
  const supported =
    typeof window !== "undefined" &&
    location.protocol === "https:" &&
    typeof CompressionStream !== "undefined" &&
    typeof ReadableStream !== "undefined";

  if (!supported) return { body: payload, encoding: null };

  try {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    });
    const compressed = input.pipeThrough(
      new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array>,
    );
    const blob = await new Response(compressed).blob();
    return { body: blob, encoding: "gzip" };
  } catch {
    return { body: payload, encoding: null };
  }
}
