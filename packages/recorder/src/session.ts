/**
 * The recording session.
 *
 * The lifecycle, the flush triggers and the retry schedule are modelled
 * closely on Milana's SDK, because its reasoning about the browser is sound
 * and hard-won. What's deliberately NOT copied: server-side sampling, the
 * session-restart protocol, multi-tenant credentials and the health-metrics
 * endpoint — all of which exist to serve thousands of customers at scale.
 *
 * The rule that governs every catch block here is Milana's: the host page
 * continues unaffected. We would rather lose our own recording than break
 * somebody else's website.
 */

import { record } from "rrweb";
import type { eventWithTime } from "@rrweb/types";
import {
  EventBuffer,
  MAX_KEEPALIVE_CHARS,
  maybeCompress,
  type BufferedEvent,
} from "./buffer";
import { debounce, onNavigation } from "./navigation";
import { PrivacyGate, TAGS_TO_MASK, resolvePrivacy } from "./privacy";
import { SIGNATURE_FOR_EVENT, startSignals } from "./signals";
import {
  CUSTOM_TAG,
  CustomEventType,
  type InitOptions,
  type PrivacyOptions,
  type SessionInfo,
  type SignatureName,
} from "./types";

const SESSION_STORAGE_KEY = "swy_session";
const DEBUG_KEY = "swy_debug";
const KILL_SWITCH_KEY = "swy_off";

const FLUSH_INTERVAL_MS = 10_000;
const URL_DEBOUNCE_MS = 100;
const RECORDING_IDLE_TIMEOUT_MS = 5_000;

/** Below this the document almost certainly has no real layout yet. */
const MIN_VIEWPORT_WIDTH = 200;

/** Give up waiting for a sane viewport and record anyway. */
const VIEWPORT_WAIT_TIMEOUT_MS = 20_000;

/** A fresh full snapshot every 10 minutes, so the player can seek cheaply. */
const CHECKOUT_EVERY_MS = 10 * 60 * 1000;

/** 5s, 15s, 30s, 60s, 5min — Milana's schedule. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000];

type State =
  | { type: "idle" }
  | { type: "starting" }
  | { type: "recording"; sessionId: string }
  | { type: "stopped" };

function debugEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === "true";
  } catch {
    return false;
  }
}

function killed(): boolean {
  try {
    return localStorage.getItem(KILL_SWITCH_KEY) === "1";
  } catch {
    return false;
  }
}

function readStoredSessionId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    // Sandboxed iframe, disabled storage, quota. Not fatal: we just can't
    // resume across a reload.
    return null;
  }
}

function writeStoredSessionId(id: string | null): void {
  try {
    if (id === null) sessionStorage.removeItem(SESSION_STORAGE_KEY);
    else sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — skip persistence */
  }
}

export class Session {
  static current: Session | null = null;

  private state: State = { type: "idle" };
  private readonly buffer = new EventBuffer();
  private readonly privacy: PrivacyGate;
  private readonly privacyOptions: PrivacyOptions;
  private readonly endpoint: string;
  private readonly debug: boolean;

  private stopRrweb: (() => void) | null = null;
  private stopSignals: (() => void) | null = null;
  private idleCallbackId: number | null = null;
  private viewportWaitCleanup: (() => void) | null = null;
  private flushTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryCount = 0;

  private sending = false;
  private inFlight: AbortController | null = null;
  private sentClose = false;

  private navigationCleanup: Array<() => void> = [];
  private lastUrl: string | null = null;
  private lastFocus: boolean | null = null;

  private onVisibility: (() => void) | null = null;
  private onFocusChange: (() => void) | null = null;
  private onPageHide: ((e: PageTransitionEvent) => void) | null = null;

  private readonly trackUrl: ReturnType<typeof debounce>;

  constructor(
    private readonly key: string,
    private readonly options: InitOptions,
  ) {
    this.privacyOptions = resolvePrivacy(options.privacy);
    this.privacy = new PrivacyGate(this.privacyOptions);
    this.endpoint = (options.endpoint ?? defaultEndpoint()).replace(/\/$/, "");
    this.debug = debugEnabled();

    this.trackUrl = debounce((...args: unknown[]) => {
      try {
        this.emitUrlChange(String(args[0]));
      } catch (error) {
        this.log("url tracking failed", error);
      }
    }, URL_DEBOUNCE_MS);
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.debug("swy:", ...args);
  }

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<{ started: boolean }> {
    if (this.state.type !== "idle") {
      this.log("already started");
      return { started: false };
    }
    if (killed()) {
      console.info("swy: disabled by kill switch (localStorage swy_off)");
      return { started: false };
    }

    this.state = { type: "starting" };

    const info: SessionInfo = {
      key: this.key,
      // The single most important field in the system. Without it a session
      // can never be attributed to a code change.
      release: this.options.release ?? null,
      url: this.privacy.sanitizeUrl(location.href),
      referrer: document.referrer ? this.privacy.sanitizeUrl(document.referrer) : null,
      userAgent: navigator.userAgent,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screenWidth: screen.width,
      screenHeight: screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      metadata: this.options.metadata ?? {},
    };

    let sessionId: string;
    try {
      const response = await fetch(`${this.endpoint}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...info,
          // Resume the same session across a reload, so a refresh doesn't
          // fragment one visit into three recordings.
          previousSessionId: readStoredSessionId(),
        }),
      });
      if (!response.ok) {
        console.info(`swy: could not start session (${response.status})`);
        this.state = { type: "idle" };
        return { started: false };
      }
      const data = (await response.json()) as { sessionId?: string };
      if (!data.sessionId) {
        this.state = { type: "idle" };
        return { started: false };
      }
      sessionId = data.sessionId;
    } catch (error) {
      console.info("swy: could not reach the server, page continues unaffected");
      this.log(error);
      this.state = { type: "idle" };
      return { started: false };
    }

    // stop() may have run while the request was in flight.
    if (Session.current !== this) {
      this.log("session was stopped during start");
      return { started: false };
    }

    writeStoredSessionId(sessionId);
    this.state = { type: "recording", sessionId };
    this.scheduleRecordingStart();
    return { started: true };
  }

  /**
   * Start rrweb in an idle moment, but only once the page actually has a
   * layout.
   *
   * Two separate concerns, both learned the hard way:
   *
   * 1. Idle scheduling. rrweb's first act is to snapshot the whole DOM,
   *    which is by far the most expensive work we ever do. Running it during
   *    a busy page load is exactly how a recorder earns a reputation for
   *    making sites slow.
   *
   * 2. A real viewport. rrweb stamps the document's dimensions into its
   *    first event, and the player sizes the entire replay from it. If we
   *    snapshot while the document is hidden or not yet laid out, we record
   *    a viewport of a few pixels and every replay of that session is
   *    unwatchable — a corruption you cannot repair afterwards.
   *
   *    This happens more than you'd guess: background-tab preloads,
   *    prerendered pages, hidden iframes, and any tab restored on browser
   *    startup. So we wait for the page to be visible and measurable, and
   *    only then take the snapshot.
   */
  private scheduleRecordingStart(): void {
    const begin = () => {
      this.idleCallbackId = null;
      try {
        this.beginRecording();
      } catch (error) {
        console.info("swy: failed to start recording, page continues unaffected");
        this.log(error);
      }
    };

    const whenIdle = () => {
      if (typeof requestIdleCallback === "function") {
        this.idleCallbackId = requestIdleCallback(begin, {
          timeout: RECORDING_IDLE_TIMEOUT_MS,
        });
      } else {
        setTimeout(begin, 0);
      }
    };

    if (this.hasUsableViewport()) {
      whenIdle();
      return;
    }

    this.log("waiting for a real viewport before snapshotting");

    let settled = false;
    const tryStart = () => {
      if (settled || !this.hasUsableViewport()) return;
      settled = true;
      cleanup();
      whenIdle();
    };

    const poll = window.setInterval(tryStart, 250);
    // A hard ceiling, so a page that never reports a sane viewport still
    // gets recorded rather than silently recording nothing at all.
    const ceiling = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      this.log("viewport never settled, recording anyway");
      whenIdle();
    }, VIEWPORT_WAIT_TIMEOUT_MS);

    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(ceiling);
      document.removeEventListener("visibilitychange", tryStart);
      window.removeEventListener("resize", tryStart);
      this.viewportWaitCleanup = null;
    };

    document.addEventListener("visibilitychange", tryStart);
    window.addEventListener("resize", tryStart);
    this.viewportWaitCleanup = cleanup;
  }

  /**
   * "Usable" means visible and wide enough that the snapshot's dimensions
   * describe a real layout. The threshold is deliberately low — narrower
   * than the narrowest phone — so we only reject genuinely degenerate
   * measurements, never a small but real screen.
   */
  private hasUsableViewport(): boolean {
    if (document.visibilityState === "hidden") return false;
    const width = document.documentElement?.clientWidth ?? 0;
    const height = document.documentElement?.clientHeight ?? 0;
    return width >= MIN_VIEWPORT_WIDTH && height > 0;
  }

  private beginRecording(): void {
    if (this.state.type !== "recording") return;

    const stop = record({
      emit: (event: eventWithTime) => this.pushEvent(event),

      maskAllInputs: true,
      maskInputOptions: TAGS_TO_MASK,
      maskInputFn: this.privacy.maskInput,
      maskTextFn: this.privacy.maskText,
      // rrweb has no "mask all text" flag, so "*" is how xhigh selects
      // everything; otherwise only explicitly marked subtrees route here.
      maskTextSelector:
        this.privacyOptions.maskingLevel === "xhigh"
          ? "*"
          : (this.privacyOptions.maskSelector ?? undefined),
      maskTextClass: this.privacyOptions.maskClass,

      blockClass: this.privacyOptions.blockClass,
      blockSelector: this.privacyOptions.blockSelector ?? undefined,
      ignoreClass: this.privacyOptions.ignoreClass,

      recordCanvas: this.options.recordCanvas ?? false,
      recordCrossOriginIframes: this.options.recordCrossOriginIframes ?? false,

      // Distinguishes a real user typing from a scripted value change.
      userTriggeredOnInput: true,
      checkoutEveryNms: CHECKOUT_EVERY_MS,
    });

    this.stopRrweb = stop ?? null;
    if (!this.stopRrweb) {
      console.info("swy: recorder did not start, page continues unaffected");
      return;
    }

    this.stopSignals = startSignals(
      (type, payload) => this.emitCustom(type, payload),
      this.privacy.sanitizeUrl,
    );

    // Report the viewport we actually snapshotted at, not the one we saw
    // when start() ran — they differ exactly in the cases above, and the
    // session list would otherwise show 0 x 0.
    void this.reportViewport();

    this.installNavigationTracking();
    this.installLifecycleHandlers();

    this.flushTimer = window.setInterval(() => {
      void this.flush(false);
    }, FLUSH_INTERVAL_MS);

    this.log("recording", this.state.type === "recording" && this.state.sessionId);
  }

  /** Correct the session row once we know the real snapshot dimensions. */
  private async reportViewport(): Promise<void> {
    if (this.state.type !== "recording") return;
    try {
      await fetch(`${this.endpoint}/api/session`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.state.sessionId,
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: document.documentElement.clientHeight,
        }),
      });
    } catch (error) {
      this.log("viewport report failed", error);
    }
  }

  stop(): void {
    if (this.state.type !== "recording") {
      this.teardown();
      this.state = { type: "stopped" };
      return;
    }

    // Send whatever is buffered plus a close marker, so the server can
    // finalize the session immediately instead of waiting out its idle
    // timeout. Not on the unload path, so no keepalive size limit applies.
    try {
      const events = this.sending ? [] : this.buffer.snapshot();
      const payload = EventBuffer.buildPayload(events, this.state.sessionId, {
        closed: true,
        closeReason: "client_stopped",
      });
      this.sentClose = true;
      void fetch(`${this.endpoint}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(() => {});
    } catch (error) {
      this.log("close send failed", error);
    }

    this.teardown();
    this.buffer.clear();
    writeStoredSessionId(null);
    this.state = { type: "stopped" };
  }

  private teardown(): void {
    this.viewportWaitCleanup?.();
    this.viewportWaitCleanup = null;

    if (this.idleCallbackId !== null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(this.idleCallbackId);
    }
    this.idleCallbackId = null;

    this.stopRrweb?.();
    this.stopRrweb = null;

    this.stopSignals?.();
    this.stopSignals = null;

    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;

    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;

    if (this.onVisibility) {
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.onVisibility = null;
    }
    if (this.onFocusChange) {
      window.removeEventListener("focus", this.onFocusChange);
      window.removeEventListener("blur", this.onFocusChange);
      this.onFocusChange = null;
    }
    if (this.onPageHide) {
      window.removeEventListener("pagehide", this.onPageHide);
      this.onPageHide = null;
    }

    for (const cleanup of this.navigationCleanup) cleanup();
    this.navigationCleanup = [];
    this.trackUrl.cancel();
  }

  // --- events ---------------------------------------------------------------

  private pushEvent(event: eventWithTime): void {
    if (this.state.type !== "recording") return;

    const result = this.buffer.push(event);

    if (result === "abort-event-too-large" || result === "abort-buffer-full") {
      // Protecting the host page's memory matters more than this recording.
      // Fail loudly rather than dropping events invisibly.
      console.warn(
        `swy: buffer limit reached (${result}), stopping recording. Page continues unaffected.`,
      );
      this.teardown();
      this.buffer.clear();
      this.state = { type: "stopped" };
      return;
    }

    if (result === "flush") void this.flush(false);
  }

  private emitCustom(type: CustomEventType, payload: Record<string, unknown>): void {
    if (this.state.type !== "recording") return;
    try {
      record.addCustomEvent(CUSTOM_TAG, { type, ...payload });
    } catch (error) {
      this.log("custom event failed", error);
    }
  }

  /** Called by the public `track` API. */
  trackEvent(name: string, attributes: Record<string, unknown> = {}): void {
    if (typeof name !== "string" || !name.trim()) {
      console.warn("swy: track() needs a non-empty name");
      return;
    }
    this.emitCustom(CustomEventType.UrlChange, {}); // no-op guard for state
    try {
      record.addCustomEvent(CUSTOM_TAG, {
        type: "custom",
        name: name.slice(0, 255),
        attributes,
      });
    } catch (error) {
      this.log("track failed", error);
    }
  }

  private installNavigationTracking(): void {
    this.lastUrl = this.privacy.sanitizeUrl(location.href);
    this.navigationCleanup.push(
      onNavigation(() => this.trackUrl(location.href)),
    );
  }

  private emitUrlChange(raw: string): void {
    const url = this.privacy.sanitizeUrl(raw);
    if (url === this.lastUrl) return;
    const from = this.lastUrl;
    this.lastUrl = url;
    this.emitCustom(CustomEventType.UrlChange, {
      url,
      from,
      title: document.title?.trim()?.slice(0, 200) ?? null,
    });
  }

  private installLifecycleHandlers(): void {
    // Visibility-hidden owns end-of-session delivery. It is the only handler
    // that reliably fires on tab close, backgrounding and mobile app switch.
    this.onVisibility = () => {
      if (this.state.type !== "recording") return;

      this.emitCustom(CustomEventType.VisibilityChange, {
        visible: document.visibilityState === "visible",
      });

      if (document.visibilityState !== "hidden") return;
      void this.flush(true);
    };
    document.addEventListener("visibilitychange", this.onVisibility);

    // Focus/blur is separate from visibility: switching windows keeps the tab
    // visible. Deduped, because browsers fire these in rapid pairs.
    this.onFocusChange = () => {
      if (this.state.type !== "recording") return;
      const focused = document.hasFocus();
      if (focused === this.lastFocus) return;
      this.lastFocus = focused;
      this.emitCustom(CustomEventType.FocusChange, { focused });
    };
    window.addEventListener("focus", this.onFocusChange);
    window.addEventListener("blur", this.onFocusChange);

    // pagehide only signals "this session is over". Event delivery already
    // happened in the visibility handler, which always fires first.
    //
    // `persisted` means the page is going into the back/forward cache rather
    // than being destroyed — pressing Back will bring it right back, so
    // closing the session here would end a recording that's about to resume.
    this.onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      if (this.state.type !== "recording") return;
      if (this.sentClose) return;
      this.sentClose = true;
      try {
        void fetch(`${this.endpoint}/api/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: `{"v":1,"sessionId":${JSON.stringify(this.state.sessionId)},"batchStartedAt":${Date.now()},"closed":true,"closeReason":"page_hidden","events":[]}`,
          keepalive: true,
        }).catch(() => {});
      } catch {
        /* best effort on the unload path */
      }
    };
    window.addEventListener("pagehide", this.onPageHide);
  }

  // --- sending --------------------------------------------------------------

  private async flush(unloading: boolean): Promise<void> {
    if (this.state.type !== "recording") return;
    if (this.buffer.length === 0) return;

    if (unloading) {
      this.flushKeepalive();
      return;
    }

    if (this.sending) return;
    this.sending = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const events = this.buffer.snapshot();
    const ok = await this.send(events);

    if (ok) {
      this.buffer.commit(events.length);
      this.retryCount = 0;
      this.sending = false;
      // More arrived while we were sending.
      if (this.buffer.length > 0) void this.flush(false);
      return;
    }

    this.sending = false;

    // Two different failures share "not ok": the keepalive flush aborted us
    // and took the events, or the network genuinely failed. Tell them apart
    // by whether the buffer still holds anything.
    if (this.buffer.length === 0) return;
    this.scheduleRetry();
  }

  /**
   * The unload path. Order matters: build the payload BEFORE aborting the
   * in-flight request, because the envelope can push a just-under-budget
   * buffer over the keepalive limit — and aborting a batch whose replacement
   * can't be sent would lose the events outright.
   */
  private flushKeepalive(): void {
    if (this.state.type !== "recording") return;
    if (this.buffer.size > MAX_KEEPALIVE_CHARS) {
      this.log("buffer too large for keepalive, skipping");
      return;
    }

    const events = this.buffer.snapshot();
    const payload = EventBuffer.buildPayload(events, this.state.sessionId);
    if (payload.length > MAX_KEEPALIVE_CHARS) return;

    // Now it's safe to take over.
    this.inFlight?.abort();

    try {
      void fetch(`${this.endpoint}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
      this.buffer.clear();
    } catch (error) {
      this.log("keepalive flush failed", error);
    }
  }

  private async send(events: BufferedEvent[]): Promise<boolean> {
    if (this.state.type !== "recording") return false;
    if (events.length === 0) return true;

    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const payload = EventBuffer.buildPayload(events, this.state.sessionId);
      const { body, encoding } = await maybeCompress(payload);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (encoding) headers["Content-Encoding"] = encoding;

      const response = await fetch(`${this.endpoint}/api/events`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      return response.ok;
    } catch (error) {
      if (controller.signal.aborted) {
        // The keepalive flush took over. Not a failure, and not retryable.
        return false;
      }
      this.log("send failed, will retry", error);
      return false;
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private scheduleRetry(): void {
    if (this.retryCount >= RETRY_DELAYS_MS.length) {
      console.info("swy: giving up after repeated send failures, stopping recording");
      this.teardown();
      this.buffer.clear();
      this.state = { type: "stopped" };
      return;
    }

    const delay = RETRY_DELAYS_MS[this.retryCount];
    this.retryCount += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.flush(false);
    }, delay);
  }
}

function defaultEndpoint(): string {
  try {
    const tag =
      (document.currentScript as HTMLScriptElement | null) ??
      document.querySelector<HTMLScriptElement>("script[data-swy-key]");
    if (tag?.src) return new URL(tag.src).origin;
  } catch {
    /* fall through */
  }
  return location.origin;
}

export { SIGNATURE_FOR_EVENT };
export type { SignatureName };
