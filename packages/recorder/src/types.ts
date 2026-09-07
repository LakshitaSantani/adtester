/**
 * Public types for the recorder.
 *
 * Design notes are lifted from Milana's SDK where its reasoning applies —
 * the masking precedence, the URL denylist and the buffer accounting are
 * all patterns worth copying rather than re-deriving.
 */

export type MaskingLevel = "normal" | "high" | "xhigh";

export type PrivacyOptions = {
  /**
   * "normal" masks only what's explicitly marked plus the always-masked
   * input types. "high" masks every input value. "xhigh" masks every input
   * value AND all DOM text.
   */
  maskingLevel: MaskingLevel;

  /** Elements in these subtrees are not recorded at all. */
  blockClass: string;
  blockSelector: string | null;

  /** Interactions inside these are not recorded (but the DOM still is). */
  ignoreClass: string;

  /** Text and input values in these subtrees are always masked. */
  maskClass: string;
  maskSelector: string | null;

  /**
   * Reveals values that `maskingLevel` masked. Has no effect at "normal",
   * and can never reveal an always-masked input type or an explicit mask —
   * see the precedence order in privacy.ts.
   */
  unmaskClass: string;
  unmaskSelector: string | null;

  /**
   * Extra input types to always mask, on top of the built-in
   * password / tel / email. Keys are lowercase `type` values.
   */
  maskInputTypes: Record<string, boolean>;

  /** Keep query strings on recorded URLs at all. */
  trackQueryParams: boolean;

  /**
   * Patterns whose matching query params are replaced with "--redacted--".
   * Anything supplied here EXTENDS the defaults; it never replaces them,
   * so a caller can only make this stricter.
   */
  queryParamDenyList: RegExp[];
};

export type InitOptions = {
  /** Where to send batches. Defaults to the script's own origin. */
  endpoint?: string;

  /**
   * The build this page is running. THE most important field in the whole
   * system — it is the join key between a session and a commit, and it
   * cannot be backfilled. Set it from your CI (e.g. the git SHA).
   */
  release?: string;

  /** Free-form labels attached to the session. */
  metadata?: Record<string, unknown>;

  recordCanvas?: boolean;
  recordCrossOriginIframes?: boolean;

  privacy?: Partial<PrivacyOptions>;
};

export type SessionInfo = {
  key: string;
  release: string | null;
  url: string;
  referrer: string | null;
  userAgent: string;
  language: string;
  timeZone: string;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  metadata: Record<string, unknown>;
};

/** Custom events we emit alongside rrweb's own, under one tag. */
export const CUSTOM_TAG = "swy";

export const enum CustomEventType {
  UrlChange = 1,
  VisibilityChange = 2,
  FocusChange = 3,
  RageClick = 4,
  DeadClick = 5,
  FieldRetry = 6,
  JsError = 7,
  NetworkError = 8,
  ScrollDepth = 9,
}

/**
 * Signature names mirror CustomEventType but travel to the server as
 * strings, because the server stores them on the session row and they end
 * up in URLs and UI labels.
 */
export type SignatureName =
  | "rage_click"
  | "dead_click"
  | "field_retry"
  | "js_error"
  | "network_error";

export type WindowApi = {
  (command: "init", key: string, options?: InitOptions): void;
  (command: "identify", user: { userId: string; email?: string; name?: string }): void;
  (command: "track", name: string, attributes?: Record<string, unknown>): void;
  (command: "stop"): void;
};

declare global {
  interface Window {
    swy?: WindowApi;
    _swyQueue?: Array<[string, ...unknown[]]>;
  }
}
