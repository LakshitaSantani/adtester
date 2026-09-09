/**
 * Turning a recording back into a description of what someone did.
 *
 * The investigator knows a session was labelled "field retry". It has never
 * known what the person actually experienced — which is the difference
 * between "something went wrong on this page" and "they typed a UK number,
 * tabbed away, got an error with no explanation, tried twice more and left".
 *
 * That description is what an analyst needs to explain a failure, and what a
 * reader needs to believe one. It is built here rather than by replaying the
 * session in a browser, because this has to run over hundreds of recordings.
 *
 * Nothing here can reveal what a user typed. Input values arrive already
 * masked by the recorder, and this deliberately reports only lengths and
 * field identities — so even a recording captured with masking misconfigured
 * cannot leak a value through the timeline.
 */

import { readEventStream } from "./storage";
import type { RrwebEvent } from "./rrweb-signals";
import { normalizeEvent } from "./rrweb-signals";

const enum EventType {
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
}

const enum Source {
  Mutation = 0,
  MouseInteraction = 2,
  Scroll = 3,
  Input = 5,
}

const enum Interaction {
  Click = 2,
  DblClick = 4,
  Focus = 5,
  Blur = 6,
}

export type TimelineEntry = {
  atMs: number;
  kind: "navigate" | "click" | "input" | "focus" | "blur" | "error" | "signal" | "scroll";
  text: string;
};

/** Keep a timeline readable, and small enough to hand to a model. */
const MAX_ENTRIES = 120;

/** Consecutive keystrokes in one field collapse into a single "typed" entry. */
const TYPING_GAP_MS = 2000;

type NodeInfo = { tag: string; id?: string; name?: string; type?: string; testId?: string };

/**
 * Build a map from rrweb node id to something a person would recognise.
 *
 * Without this a timeline reads "clicked node 88", which is useless. The full
 * snapshot carries the whole DOM with ids attached, so one walk gives every
 * element a name for the rest of the session.
 */
function buildNodeMap(events: RrwebEvent[]): Map<number, NodeInfo> {
  const map = new Map<number, NodeInfo>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      id?: number;
      tagName?: string;
      attributes?: Record<string, unknown>;
      childNodes?: unknown[];
    };

    if (typeof n.id === "number" && n.tagName) {
      const attrs = n.attributes ?? {};
      map.set(n.id, {
        tag: String(n.tagName).toLowerCase(),
        id: str(attrs.id),
        name: str(attrs.name),
        type: str(attrs.type),
        testId: str(attrs["data-testid"]) ?? str(attrs["data-test"]),
      });
    }
    for (const child of n.childNodes ?? []) walk(child);
  };

  for (const event of events) {
    if (event.type !== EventType.FullSnapshot) continue;
    walk((event.data as { node?: unknown } | undefined)?.node);
  }

  // Nodes added after load appear in mutations, not the snapshot.
  for (const event of events) {
    if (event.type !== EventType.IncrementalSnapshot) continue;
    if (event.data?.source !== Source.Mutation) continue;
    for (const added of (event.data as { adds?: Array<{ node?: unknown }> }).adds ?? []) {
      walk(added.node);
    }
  }

  return map;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** How a person would refer to an element. */
function describe(id: number, map: Map<number, NodeInfo>): string {
  const info = map.get(id);
  if (!info) return `element ${id}`;
  if (info.testId) return `${info.tag}[${info.testId}]`;
  if (info.id) return `${info.tag}#${info.id}`;
  if (info.name) return `${info.tag}[name=${info.name}]`;
  if (info.type) return `${info.tag}[type=${info.type}]`;
  return info.tag;
}

function path(href: string): string {
  try {
    return new URL(href).pathname || "/";
  } catch {
    return href;
  }
}

const SIGNAL_NAMES: Record<number, string> = {
  4: "rage click",
  5: "dead click",
  6: "field retried repeatedly",
  7: "javascript error",
  8: "failed request",
};

export async function buildTimeline(sessionId: string): Promise<TimelineEntry[]> {
  const events: RrwebEvent[] = [];

  const stream = readEventStream(sessionId);
  let buffer = "";
  for await (const piece of stream) {
    buffer += piece;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = normalizeEvent(JSON.parse(line));
        if (event) events.push(event);
      } catch {
        // A corrupt line costs one moment, not the timeline.
      }
    }
  }
  if (buffer.trim()) {
    try {
      const event = normalizeEvent(JSON.parse(buffer));
      if (event) events.push(event);
    } catch {
      /* ignore a truncated last line */
    }
  }

  if (events.length === 0) return [];

  events.sort((a, b) => a.timestamp - b.timestamp);
  const nodes = buildNodeMap(events);
  const start = events[0].timestamp;

  const entries: TimelineEntry[] = [];
  // Typing is one intention, not forty events. Collapse a run of keystrokes
  // in the same field into a single line.
  let typing: { id: number; from: number; to: number; count: number } | null = null;

  const flushTyping = () => {
    if (!typing) return;
    entries.push({
      atMs: typing.from - start,
      kind: "input",
      // Length only. Never the value, whatever the recorder captured.
      text: `typed into ${describe(typing.id, nodes)} (${typing.count} edits)`,
    });
    typing = null;
  };

  for (const event of events) {
    const at = event.timestamp - start;

    if (event.type === EventType.Meta && typeof event.data?.href === "string") {
      flushTyping();
      entries.push({ atMs: at, kind: "navigate", text: `on ${path(event.data.href)}` });
      continue;
    }

    if (event.type === EventType.Custom) {
      const payload = event.data?.payload as Record<string, unknown> | undefined;
      const kind = Number(payload?.type);

      if (kind === 1 && typeof payload?.url === "string") {
        flushTyping();
        entries.push({ atMs: at, kind: "navigate", text: `moved to ${path(payload.url)}` });
        continue;
      }

      const signal = SIGNAL_NAMES[kind];
      if (signal) {
        flushTyping();
        const detail =
          kind === 7 && payload?.message
            ? `: ${String(payload.message).slice(0, 160)}`
            : kind === 8 && payload?.status
              ? `: ${String(payload.status)} on ${path(String(payload.url ?? ""))}`
              : payload?.field
                ? ` (${String(payload.field)})`
                : "";
        entries.push({
          atMs: at,
          kind: kind === 7 || kind === 8 ? "error" : "signal",
          text: `${signal}${detail}`,
        });
      }
      continue;
    }

    if (event.type !== EventType.IncrementalSnapshot || !event.data) continue;
    const data = event.data;

    if (data.source === Source.Input && typeof data.id === "number") {
      if (typing && typing.id === data.id && event.timestamp - typing.to <= TYPING_GAP_MS) {
        typing.to = event.timestamp;
        typing.count += 1;
      } else {
        flushTyping();
        typing = { id: data.id, from: event.timestamp, to: event.timestamp, count: 1 };
      }
      continue;
    }

    if (data.source === Source.MouseInteraction && typeof data.id === "number") {
      if (data.type === Interaction.Click || data.type === Interaction.DblClick) {
        flushTyping();
        entries.push({
          atMs: at,
          kind: "click",
          text: `clicked ${describe(data.id, nodes)}`,
        });
      } else if (data.type === Interaction.Blur) {
        // Leaving a field is where validation usually fires, so it's the
        // moment worth keeping out of all the focus churn.
        flushTyping();
        entries.push({
          atMs: at,
          kind: "blur",
          text: `left ${describe(data.id, nodes)}`,
        });
      }
    }
  }

  flushTyping();

  return trim(entries);
}

/**
 * Keep the head and the tail.
 *
 * The beginning shows how they got there and the end is where it went wrong;
 * the scrolling in between is rarely what explains anything.
 */
function trim(entries: TimelineEntry[]): TimelineEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries;
  const head = Math.floor(MAX_ENTRIES / 3);
  const tail = MAX_ENTRIES - head;
  return [
    ...entries.slice(0, head),
    {
      atMs: entries[head].atMs,
      kind: "signal" as const,
      text: `… ${entries.length - MAX_ENTRIES} further actions omitted …`,
    },
    ...entries.slice(-tail),
  ];
}

/** Render for a model or a person. */
export function formatTimeline(entries: TimelineEntry[]): string {
  return entries
    .map((e) => {
      const seconds = Math.floor(e.atMs / 1000);
      const stamp = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      return `${stamp}  ${e.text}`;
    })
    .join("\n");
}
