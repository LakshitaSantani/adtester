/**
 * Reading signatures out of a recorded event stream, server-side.
 *
 * Our own recorder detects rage clicks and the rest in the browser, where it
 * has a live DOM to watch. Imported recordings don't come with that — a
 * PostHog session is just a pile of rrweb events after the fact.
 *
 * So the same heuristics are implemented a second time here, over the raw
 * stream. That decouples the brain from our recorder entirely: anything that
 * can produce rrweb events becomes a valid input, and the investigator can be
 * tested today against months of somebody's real traffic instead of after a
 * fortnight of collecting our own.
 *
 * Deliberately no DOM and no replay. Replaying into a headless browser would
 * be more faithful and far too slow to run over thousands of sessions.
 */

/** rrweb event types. */
const enum EventType {
  DomContentLoaded = 0,
  Load = 1,
  FullSnapshot = 2,
  IncrementalSnapshot = 3,
  Meta = 4,
  Custom = 5,
  Plugin = 6,
}

/** rrweb incremental sources. */
const enum Source {
  Mutation = 0,
  MouseMove = 1,
  MouseInteraction = 2,
  Scroll = 3,
  ViewportResize = 4,
  Input = 5,
}

/** rrweb MouseInteraction sub-types. */
const enum Interaction {
  MouseUp = 0,
  MouseDown = 1,
  Click = 2,
  ContextMenu = 3,
  DblClick = 4,
  Focus = 5,
  Blur = 6,
}

export type RrwebEvent = {
  type: number;
  timestamp: number;
  data?: {
    source?: number;
    type?: number;
    id?: number;
    x?: number;
    y?: number;
    href?: string;
    text?: string;
    tag?: string;
    payload?: unknown;
    [key: string]: unknown;
  };
};

export type ExtractedSignals = {
  signatures: string[];
  errorCount: number;
  /** Every URL the session visited, in order, from Meta events. */
  urls: string[];
  /**
   * Where each signature actually fired.
   *
   * Without this an imported session could only say "something went wrong
   * somewhere in here", and detection fell back to the entry URL. In a
   * single-page app that is nearly always the wrong page: someone lands on
   * "/", clicks through to "/checkout/step-3" and hits the bug there, and the
   * whole finding gets filed against the homepage — where the investigator
   * then looks for a cause among code that had nothing to do with it.
   */
  signaturePaths: Record<string, string[]>;
  /** Every distinct page the session was on. The denominator for rates. */
  paths: string[];
  /**
   * Endpoints whose requests failed.
   *
   * The only thread from a session back to server-side code: a page reaches
   * its own files through imports, but a backend handler is only ever reached
   * over the network. Empty here meant backend candidate matching was dead on
   * imported data.
   */
  apiPaths: string[];
  startedAt: number | null;
  endedAt: number | null;
  eventCount: number;
};

/** Origin, query and hash stripped — what the lexicon's routes are matched against. */
export function pathFromHref(href: string): string | null {
  try {
    const url = new URL(href, "http://x");
    return url.pathname || "/";
  } catch {
    return null;
  }
}

// Thresholds kept in step with the browser-side detectors in
// packages/recorder/src/signals.ts. If one moves, move both — otherwise an
// imported session and a recorded one describe the same behaviour differently
// and the baseline comparison silently breaks.
const RAGE_WINDOW_MS = 1000;
const RAGE_CLICK_COUNT = 3;
const RAGE_RADIUS_PX = 30;
const DEAD_CLICK_WAIT_MS = 1500;
const FIELD_RETRY_COUNT = 3;
const FIELD_RETRY_WINDOW_MS = 30_000;

/**
 * PostHog wraps each rrweb event as `{ window_id, data: event }` in its blob
 * format, and sometimes hands back bare events. Accept either.
 */
export function normalizeEvent(raw: unknown): RrwebEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.type === "number" && typeof obj.timestamp === "number") {
    return obj as RrwebEvent;
  }
  if (obj.data && typeof obj.data === "object") {
    const inner = obj.data as Record<string, unknown>;
    if (typeof inner.type === "number" && typeof inner.timestamp === "number") {
      return inner as unknown as RrwebEvent;
    }
  }
  return null;
}

export function extractSignals(events: RrwebEvent[]): ExtractedSignals {
  const signatures = new Set<string>();
  let errorCount = 0;
  const urls: string[] = [];

  // Where the session was, over time. Meta events mark every navigation,
  // including the client-side ones a single-page app makes without a reload.
  const navigations: Array<{ t: number; path: string }> = [];
  const signaturePaths = new Map<string, Set<string>>();
  const apiPaths = new Set<string>();

  /** The page the session was on at a given moment. */
  const pathAt = (t: number): string | null => {
    let current: string | null = navigations[0]?.path ?? null;
    for (const nav of navigations) {
      if (nav.t > t) break;
      current = nav.path;
    }
    return current;
  };

  /** Record a signature, and the page it happened on. */
  const note = (signature: string, t: number) => {
    signatures.add(signature);
    const path = pathAt(t);
    if (!path) return;
    const set = signaturePaths.get(signature) ?? new Set<string>();
    set.add(path);
    signaturePaths.set(signature, set);
  };

  // Sorting matters: the dead-click and field-retry rules both reason about
  // what happened *after* something, and PostHog blobs arrive per window and
  // can interleave out of order.
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);

  const clicks: Array<{ x: number; y: number; t: number; id: number }> = [];
  const mutationTimes: number[] = [];
  const inputsByNode = new Map<number, number[]>();

  for (const event of ordered) {
    if (event.type === EventType.Meta && typeof event.data?.href === "string") {
      const href = event.data.href;
      if (urls[urls.length - 1] !== href) urls.push(href);
      const path = pathFromHref(href);
      if (path && navigations[navigations.length - 1]?.path !== path) {
        navigations.push({ t: event.timestamp, path });
      }
      continue;
    }

    // Custom events carry errors, from our recorder or PostHog's plugins.
    if (event.type === EventType.Custom || event.type === EventType.Plugin) {
      const tag = String(event.data?.tag ?? "");
      const payload = event.data?.payload as Record<string, unknown> | undefined;
      const kind = String(payload?.type ?? payload?.level ?? tag);

      if (/error|exception/i.test(kind) || /error|exception/i.test(tag)) {
        note("js_error", event.timestamp);
        errorCount += 1;
      }
      if (/network|fetch|xhr/i.test(tag)) {
        const status = Number(payload?.status ?? 200);
        if (status === 0 || status >= 400) {
          note("network_error", event.timestamp);
          // Only failed requests are recorded. A backend change that made
          // responses slower or subtly wrong leaves no trace this way, and
          // that limitation is real.
          if (typeof payload?.url === "string") {
            const endpoint = pathFromHref(payload.url);
            if (endpoint && endpoint !== "/") apiPaths.add(endpoint);
          }
        }
      }
      continue;
    }

    if (event.type !== EventType.IncrementalSnapshot) continue;
    const data = event.data;
    if (!data) continue;

    if (data.source === Source.Mutation) {
      mutationTimes.push(event.timestamp);
      continue;
    }

    if (data.source === Source.MouseInteraction && data.type === Interaction.Click) {
      clicks.push({
        x: Number(data.x ?? 0),
        y: Number(data.y ?? 0),
        t: event.timestamp,
        id: Number(data.id ?? -1),
      });
      continue;
    }

    if (data.source === Source.Input && typeof data.id === "number") {
      const times = inputsByNode.get(data.id) ?? [];
      times.push(event.timestamp);
      inputsByNode.set(data.id, times);
    }
  }

  // Rage: three or more clicks close together in space and time.
  for (let i = 0; i + RAGE_CLICK_COUNT - 1 < clicks.length; i++) {
    const window = clicks.slice(i, i + RAGE_CLICK_COUNT);
    const span = window[window.length - 1].t - window[0].t;
    if (span > RAGE_WINDOW_MS) continue;
    const first = window[0];
    const clustered = window.every(
      (c) =>
        Math.abs(c.x - first.x) < RAGE_RADIUS_PX &&
        Math.abs(c.y - first.y) < RAGE_RADIUS_PX,
    );
    if (clustered) note("rage_click", first.t);
  }

  // Dead: a click with no DOM change in the following moment. Only counted
  // when there are mutations elsewhere in the session — a stream with none at
  // all usually means mutation recording was off, and every click would look
  // dead.
  if (mutationTimes.length > 0) {
    for (const click of clicks) {
      const changed = mutationTimes.some(
        (t) => t > click.t && t - click.t <= DEAD_CLICK_WAIT_MS,
      );
      if (!changed) note("dead_click", click.t);
    }
  }

  // Retry: the same field edited in several separate bursts. Consecutive
  // keystrokes are one burst; coming back to a field after leaving it is
  // another, and that is what suggests it keeps rejecting them.
  for (const times of inputsByNode.values()) {
    let bursts = 1;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] > 2000) bursts += 1;
    }
    const span = times[times.length - 1] - times[0];
    if (bursts >= FIELD_RETRY_COUNT && span <= FIELD_RETRY_WINDOW_MS) {
      note("field_retry", times[0]);
    }
  }

  return {
    signatures: [...signatures],
    errorCount,
    urls,
    signaturePaths: Object.fromEntries(
      [...signaturePaths].map(([signature, paths]) => [signature, [...paths]]),
    ),
    paths: [...new Set(navigations.map((n) => n.path))],
    apiPaths: [...apiPaths],
    startedAt: ordered[0]?.timestamp ?? null,
    endedAt: ordered[ordered.length - 1]?.timestamp ?? null,
    eventCount: ordered.length,
  };
}

/**
 * Look for the customer's build version among event properties.
 *
 * This is the field the counterfactual depends on, and no analytics tool
 * captures it by default — PostHog's `$lib_version` is posthog-js's own
 * version, not the app's. Some teams set one of these by hand, so it is
 * worth looking; when nothing turns up the investigator caps its confidence
 * and says why, which is the honest outcome rather than a broken one.
 */
const RELEASE_KEYS = [
  "release",
  "version",
  "app_version",
  "$app_version",
  "build",
  "build_id",
  "commit",
  "commit_sha",
  "git_sha",
  "$git_sha",
  "sha",
];

export function findRelease(
  properties: Record<string, unknown> | null | undefined,
): string | null {
  if (!properties) return null;
  for (const key of RELEASE_KEYS) {
    const value = properties[key];
    if (typeof value === "string" && value.trim() && value.length <= 100) {
      return value.trim();
    }
  }
  return null;
}
