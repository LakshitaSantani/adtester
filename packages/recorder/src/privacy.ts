/**
 * Masking decisions and URL sanitization.
 *
 * The precedence order here is copied from Milana's SDK, and the order
 * matters more than any individual rule: it is what guarantees that
 * turning masking UP can never be undone by turning something else on.
 *
 *   1. blocked subtree      -> not recorded at all (handled by rrweb)
 *   2. always-masked type   -> masked, unreachable by any unmask setting
 *   3. explicit mask        -> masked
 *   4. maskingLevel         -> masked, UNLESS in an unmask subtree
 *   5. otherwise            -> recorded verbatim
 */

import type { MaskingLevel, PrivacyOptions } from "./types";

const MASK_CHAR = "*";

/** Never revealable, whatever the configuration says. */
const ALWAYS_MASKED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "password",
  "tel",
  "email",
]);

/**
 * rrweb only calls maskInputFn for tags/types listed here, so we list the
 * TAGS (which we can enumerate exhaustively) and make the real decision
 * ourselves inside the callback. Same workaround Milana uses.
 */
export const TAGS_TO_MASK: Record<string, boolean> = {
  input: true,
  select: true,
  textarea: true,
  option: true,
};

const DEFAULT_QUERY_DENYLIST: RegExp[] = [
  /^jwt$/i,
  /^code$/i,
  /token/i,
  /password/i,
  /secret/i,
  /key/i,
  /auth/i,
  /nonce/i,
  /csrf/i,
  /session/i,
  /email/i,
];

export const DEFAULT_PRIVACY: PrivacyOptions = {
  /**
   * "high" — every input value is masked unless explicitly revealed.
   *
   * Deliberately stricter than Milana's default of "normal". Milana ships to
   * customers with contracts, DPAs and a rollout plan; this gets pasted onto
   * a site by someone trying it out on a Tuesday. At "normal" a plain
   * <input type="text"> is recorded verbatim — which on a real site means
   * addresses, card numbers and phone numbers.
   *
   * Teams that want specific fields visible opt in per field with
   * `class="swy-unmask"`. Safe by default, readable by choice.
   */
  maskingLevel: "high",
  blockClass: "swy-block",
  blockSelector: null,
  ignoreClass: "swy-ignore",
  maskClass: "swy-mask",
  maskSelector: null,
  unmaskClass: "swy-unmask",
  unmaskSelector: null,
  maskInputTypes: {},
  trackQueryParams: true,
  queryParamDenyList: [],
};

/**
 * A global (/g) or sticky (/y) regex carries mutable lastIndex state across
 * .test() calls. Both we and rrweb test the same object against individual
 * class tokens, so a stateful flag makes matches intermittently skip — a
 * privacy rule that works four times out of five. Return an equivalent
 * matcher with no stateful flags.
 */
export function withoutStatefulFlags(matcher: RegExp): RegExp {
  const flags = matcher.flags.replace(/[gy]/g, "");
  const source = matcher.sticky ? `^(?:${matcher.source})` : matcher.source;
  return new RegExp(source, flags);
}

/**
 * Validate a selector without touching the live DOM. An invalid selector is
 * dropped with a warning rather than throwing — misconfiguration must fail
 * safe, and loudly enough that whoever wrote it finds out.
 */
export function normalizeSelector(
  selector: string | null | undefined,
  name: string,
): string | null {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  try {
    document.createDocumentFragment().querySelector(trimmed);
  } catch {
    console.warn(`swy: ignoring invalid privacy.${name} selector "${trimmed}"`);
    return null;
  }
  return trimmed;
}

export function resolvePrivacy(input?: Partial<PrivacyOptions>): PrivacyOptions {
  const level: MaskingLevel = input?.maskingLevel ?? DEFAULT_PRIVACY.maskingLevel;
  const unmaskSelector = normalizeSelector(input?.unmaskSelector, "unmaskSelector");

  if (level === "normal" && unmaskSelector) {
    console.warn(
      'swy: privacy.unmaskSelector does nothing at maskingLevel "normal" — ' +
        'it only reveals values masked by "high" or "xhigh".',
    );
  }

  return {
    maskingLevel: level,
    blockClass: input?.blockClass ?? DEFAULT_PRIVACY.blockClass,
    blockSelector: normalizeSelector(input?.blockSelector, "blockSelector"),
    ignoreClass: input?.ignoreClass ?? DEFAULT_PRIVACY.ignoreClass,
    maskClass: input?.maskClass ?? DEFAULT_PRIVACY.maskClass,
    maskSelector: normalizeSelector(input?.maskSelector, "maskSelector"),
    unmaskClass: input?.unmaskClass ?? DEFAULT_PRIVACY.unmaskClass,
    unmaskSelector,
    maskInputTypes: { ...(input?.maskInputTypes ?? {}) },
    trackQueryParams: input?.trackQueryParams ?? DEFAULT_PRIVACY.trackQueryParams,
    // Caller patterns EXTEND the defaults — never replace them.
    queryParamDenyList: [
      ...DEFAULT_QUERY_DENYLIST,
      ...(input?.queryParamDenyList ?? []),
    ],
  };
}

// --- element predicates -----------------------------------------------------

function hasClassUpTree(el: HTMLElement | null, className: string): boolean {
  if (!className) return false;
  let current: HTMLElement | null = el;
  while (current) {
    if (current.classList && current.classList.contains(className)) return true;
    current = current.parentElement;
  }
  return false;
}

function matchesUpTree(el: HTMLElement | null, selector: string | null): boolean {
  if (!selector || !el) return false;
  try {
    return el.closest(selector) !== null;
  } catch {
    return false;
  }
}

export class PrivacyGate {
  constructor(private readonly opts: PrivacyOptions) {}

  private isBlocked(el: HTMLElement): boolean {
    return (
      hasClassUpTree(el, this.opts.blockClass) ||
      matchesUpTree(el, this.opts.blockSelector)
    );
  }

  private isExplicitlyMasked(el: HTMLElement): boolean {
    return (
      hasClassUpTree(el, this.opts.maskClass) ||
      matchesUpTree(el, this.opts.maskSelector)
    );
  }

  /** A blocked ancestor always wins over an unmask marker. */
  private canBeUnmasked(el: HTMLElement): boolean {
    if (this.isBlocked(el)) return false;
    return (
      hasClassUpTree(el, this.opts.unmaskClass) ||
      matchesUpTree(el, this.opts.unmaskSelector)
    );
  }

  private inputType(el: HTMLInputElement): string | null {
    // rrweb sets this attribute on fields it has already decided are
    // password-like; mirror its behaviour so we agree with it.
    if (el.hasAttribute("data-rr-is-password")) return "password";
    return el.type ? el.type.toLowerCase() : null;
  }

  private isAlwaysMaskedType(type: string): boolean {
    return (
      ALWAYS_MASKED_INPUT_TYPES.has(type) ||
      this.opts.maskInputTypes[type] === true
    );
  }

  /** rrweb's maskInputFn. Runs for every input-ish value. */
  maskInput = (value: string, el: HTMLElement): string => {
    try {
      const type = this.inputType(el as HTMLInputElement);

      // 2. Sensitive types are masked before any unmask check can run.
      if (type && this.isAlwaysMaskedType(type)) return mask(value);

      // 3. Explicit marks.
      if (this.isExplicitlyMasked(el)) return mask(value);

      // 4. Level, with unmask as the only escape.
      const level = this.opts.maskingLevel;
      if (level === "high" || level === "xhigh") {
        return this.canBeUnmasked(el) ? value : mask(value);
      }

      return value;
    } catch {
      // Any failure here masks. Never fail open.
      return mask(value);
    }
  };

  /** rrweb's maskTextFn. Only invoked for text rrweb decided to route here. */
  maskText = (value: string, el: HTMLElement | null): string => {
    try {
      if (!el) return mask(value);
      const reveal = this.canBeUnmasked(el) && !this.isExplicitlyMasked(el);
      return reveal ? value : mask(value);
    } catch {
      return mask(value);
    }
  };

  /**
   * Strip the fragment always, and redact query params that look sensitive.
   * Storing secrets in a hash is bad practice and there's no upside to
   * recording it, so it goes unconditionally.
   */
  sanitizeUrl = (raw: string): string => {
    try {
      const url = new URL(raw, location.href);
      url.hash = "";

      if (!this.opts.trackQueryParams) {
        url.search = "";
        return url.toString();
      }

      const params = new URLSearchParams(url.search);
      let changed = false;
      for (const name of Array.from(params.keys())) {
        if (this.opts.queryParamDenyList.some((re) => re.test(name))) {
          params.set(name, "--redacted--");
          changed = true;
        }
      }
      if (changed) url.search = params.toString();
      return url.toString();
    } catch {
      return "";
    }
  };
}

function mask(value: string): string {
  // Non-whitespace becomes an asterisk. Milana goes further and width-matches
  // the placeholder so replays keep their layout; that's a genuinely clever
  // optimisation and entirely deferrable — see the design doc.
  return value.replace(/\S/g, MASK_CHAR);
}
