/**
 * Signature detection — the things that make a session worth watching.
 *
 * rrweb records everything faithfully but has no opinion about what matters.
 * These detectors run in the page and emit custom events, so the server can
 * label a session without replaying it.
 *
 * Structured as Milana structures its plugins: each detector is a function
 * that takes an emit callback and returns its own teardown, so the session
 * can start and stop them as a group without knowing what any of them do.
 */

import { CustomEventType, type SignatureName } from "./types";

type Emit = (type: CustomEventType, payload: Record<string, unknown>) => void;
type Teardown = () => void;

/** How close together clicks must be to count as rage. */
const RAGE_WINDOW_MS = 1000;
const RAGE_CLICK_COUNT = 3;
const RAGE_RADIUS_PX = 30;

/** How long we wait to see whether a click changed anything. */
const DEAD_CLICK_WAIT_MS = 1500;

/** Re-editing the same field this many times suggests it's rejecting them. */
const FIELD_RETRY_COUNT = 3;
const FIELD_RETRY_WINDOW_MS = 30_000;

function describe(el: Element | null): string {
  if (!el) return "unknown";
  const parts: string[] = [el.tagName.toLowerCase()];
  const id = el.getAttribute("id");
  if (id) parts.push(`#${id}`);
  const testId = el.getAttribute("data-testid") || el.getAttribute("data-test");
  if (testId) parts.push(`[${testId}]`);
  // Deliberately no text content — it may be masked, and a selector is
  // enough for the server to point at the right node.
  return parts.join("");
}

/**
 * Three or more clicks in the same small area within a second. The classic
 * "this button isn't working" signal.
 */
function rageClicks(emit: Emit): Teardown {
  let recent: Array<{ x: number; y: number; t: number }> = [];

  const onClick = (e: MouseEvent) => {
    if (!e.isTrusted) return;
    const now = Date.now();
    recent = recent.filter((c) => now - c.t < RAGE_WINDOW_MS);
    recent.push({ x: e.clientX, y: e.clientY, t: now });

    if (recent.length < RAGE_CLICK_COUNT) return;

    const first = recent[0];
    const clustered = recent.every(
      (c) =>
        Math.abs(c.x - first.x) < RAGE_RADIUS_PX &&
        Math.abs(c.y - first.y) < RAGE_RADIUS_PX,
    );

    if (clustered) {
      emit(CustomEventType.RageClick, {
        count: recent.length,
        target: describe(e.target as Element),
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
      });
      recent = [];
    }
  };

  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}

/**
 * A click on something that looks interactive, after which nothing at all
 * changed — no DOM mutation, no navigation, no new request. Usually a
 * broken handler or a disabled control that doesn't look disabled.
 */
function deadClicks(emit: Emit): Teardown {
  let pending: { target: Element; url: string; timer: number } | null = null;
  let mutated = false;

  const observer = new MutationObserver(() => {
    mutated = true;
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  const looksInteractive = (el: Element | null): boolean => {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (["button", "a", "input", "select", "textarea", "label"].includes(tag)) return true;
    if (el.getAttribute("role") === "button") return true;
    if (el.hasAttribute("onclick")) return true;
    const cursor = getComputedStyle(el).cursor;
    return cursor === "pointer";
  };

  const onClick = (e: MouseEvent) => {
    if (!e.isTrusted) return;
    const target = e.target as Element | null;
    if (!looksInteractive(target)) return;
    if (pending) clearTimeout(pending.timer);

    mutated = false;
    const url = location.href;
    const timer = window.setTimeout(() => {
      if (!mutated && location.href === url) {
        emit(CustomEventType.DeadClick, { target: describe(target) });
      }
      pending = null;
    }, DEAD_CLICK_WAIT_MS);

    pending = { target: target as Element, url, timer };
  };

  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    observer.disconnect();
    if (pending) clearTimeout(pending.timer);
  };
}

/**
 * The same field edited, left, and come back to several times. Strong signal
 * that validation is rejecting something the user believes is correct — the
 * exact symptom in the worked example from the design doc.
 *
 * We record only the field's identity, never its value.
 */
function fieldRetries(emit: Emit): Teardown {
  const visits = new Map<string, number[]>();
  const reported = new Set<string>();

  const onBlur = (e: FocusEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el) return;
    const tag = el.tagName?.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;

    const id = describe(el);
    if (reported.has(id)) return;

    const now = Date.now();
    const times = (visits.get(id) ?? []).filter(
      (t) => now - t < FIELD_RETRY_WINDOW_MS,
    );
    times.push(now);
    visits.set(id, times);

    if (times.length >= FIELD_RETRY_COUNT) {
      reported.add(id);
      emit(CustomEventType.FieldRetry, {
        field: id,
        attempts: times.length,
        // The type tells the server which validation to look at, without
        // revealing anything the user typed.
        inputType: (el as HTMLInputElement).type ?? null,
      });
    }
  };

  document.addEventListener("blur", onBlur, true);
  return () => document.removeEventListener("blur", onBlur, true);
}

/**
 * Uncaught errors and rejected promises. The single highest-value signal,
 * because a stack trace names files — which is what lets the investigator
 * narrow forty commits down to three without a model.
 */
function jsErrors(emit: Emit): Teardown {
  const onError = (e: ErrorEvent) => {
    emit(CustomEventType.JsError, {
      message: String(e.message ?? "").slice(0, 500),
      source: e.filename ?? null,
      line: e.lineno ?? null,
      column: e.colno ?? null,
      stack: e.error?.stack ? String(e.error.stack).slice(0, 2000) : null,
    });
  };

  const onRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    emit(CustomEventType.JsError, {
      message: String(reason?.message ?? reason ?? "").slice(0, 500),
      source: null,
      line: null,
      column: null,
      stack: reason?.stack ? String(reason.stack).slice(0, 2000) : null,
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * Failed network calls. We patch fetch and XHR to record status codes and
 * URLs — never request or response bodies, which would be a data-exfil
 * hazard on a customer's page.
 */
function networkErrors(emit: Emit, sanitizeUrl: (u: string) => string): Teardown {
  const originalFetch = window.fetch;

  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const started = Date.now();
    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok) {
        emit(CustomEventType.NetworkError, {
          url: sanitizeUrl(String(args[0])),
          status: response.status,
          durationMs: Date.now() - started,
        });
      }
      return response;
    } catch (error) {
      emit(CustomEventType.NetworkError, {
        url: sanitizeUrl(String(args[0])),
        status: 0,
        durationMs: Date.now() - started,
        message: String((error as Error)?.message ?? "").slice(0, 200),
      });
      throw error; // must not swallow the host page's error
    }
  };

  const OriginalXhr = window.XMLHttpRequest;
  const originalOpen = OriginalXhr.prototype.open;
  const originalSend = OriginalXhr.prototype.send;

  originalOpen &&
    (OriginalXhr.prototype.open = function (
      this: XMLHttpRequest & { __swyUrl?: string },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__swyUrl = String(url);
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as never);
    } as typeof originalOpen);

  originalSend &&
    (OriginalXhr.prototype.send = function (
      this: XMLHttpRequest & { __swyUrl?: string },
      ...rest: unknown[]
    ) {
      const started = Date.now();
      this.addEventListener("loadend", () => {
        if (this.status === 0 || this.status >= 400) {
          emit(CustomEventType.NetworkError, {
            url: sanitizeUrl(this.__swyUrl ?? ""),
            status: this.status,
            durationMs: Date.now() - started,
          });
        }
      });
      // eslint-disable-next-line prefer-rest-params
      return originalSend.apply(this, arguments as never);
    } as typeof originalSend);

  return () => {
    window.fetch = originalFetch;
    if (originalOpen) OriginalXhr.prototype.open = originalOpen;
    if (originalSend) OriginalXhr.prototype.send = originalSend;
  };
}

/** How far down each page the user got. Reset on navigation. */
function scrollDepth(emit: Emit): Teardown {
  let path = location.pathname;
  let emitted = 0;
  let timer: number | null = null;

  const check = () => {
    if (location.pathname !== path) {
      path = location.pathname;
      emitted = 0;
    }
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return;
    const pct = Math.min(100, Math.round(((window.scrollY || 0) / scrollable) * 100));
    const bucket = Math.floor(pct / 25) * 25;
    if (bucket > emitted) {
      emitted = bucket;
      emit(CustomEventType.ScrollDepth, { depth: bucket, path });
    }
  };

  const onScroll = () => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      check();
    }, 250);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    window.removeEventListener("scroll", onScroll);
    if (timer !== null) clearTimeout(timer);
  };
}

export const SIGNATURE_FOR_EVENT: Partial<Record<CustomEventType, SignatureName>> = {
  [CustomEventType.RageClick]: "rage_click",
  [CustomEventType.DeadClick]: "dead_click",
  [CustomEventType.FieldRetry]: "field_retry",
  [CustomEventType.JsError]: "js_error",
  [CustomEventType.NetworkError]: "network_error",
};

/** Start every detector. Returns one teardown for all of them. */
export function startSignals(
  emit: Emit,
  sanitizeUrl: (u: string) => string,
): Teardown {
  const teardowns: Teardown[] = [];
  const safely = (name: string, start: () => Teardown) => {
    try {
      teardowns.push(start());
    } catch (error) {
      // One broken detector must not stop the others, and must never
      // surface in the host page.
      console.debug(`swy: signal "${name}" failed to start`, error);
    }
  };

  safely("rage", () => rageClicks(emit));
  safely("dead", () => deadClicks(emit));
  safely("retry", () => fieldRetries(emit));
  safely("error", () => jsErrors(emit));
  safely("network", () => networkErrors(emit, sanitizeUrl));
  safely("scroll", () => scrollDepth(emit));

  return () => {
    for (const teardown of teardowns) {
      try {
        teardown();
      } catch {
        /* best effort */
      }
    }
  };
}
