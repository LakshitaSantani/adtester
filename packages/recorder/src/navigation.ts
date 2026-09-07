/**
 * SPA navigation detection.
 *
 * Ported from Milana: history.pushState / replaceState are patched once,
 * permanently, and popstate is listened for separately because back/forward
 * navigations don't pass through either method.
 */

export type NavigationSource = "pushstate" | "replacestate" | "popstate";

const subscribers = new Set<(source: NavigationSource) => void>();
let instrumented = false;

function ensureInstrumented(): void {
  if (instrumented) return;
  instrumented = true;

  const emit = (source: NavigationSource) => {
    // Snapshot, so a handler that subscribes or unsubscribes during dispatch
    // can't change who gets notified for the in-flight navigation.
    for (const handler of [...subscribers]) {
      try {
        handler(source);
      } catch {
        /* never let a subscriber break navigation */
      }
    }
  };

  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<typeof original>) {
      // The native call runs first, always — so location is already updated
      // when subscribers read it, and a throwing subscriber can't prevent
      // the navigation itself.
      const result = original.apply(this, args);
      emit(name === "pushState" ? "pushstate" : "replacestate");
      return result;
    };
  }

  window.addEventListener("popstate", () => emit("popstate"));
}

export function onNavigation(
  handler: (source: NavigationSource) => void,
): () => void {
  ensureInstrumented();
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): { (...args: A): void; cancel(): void } {
  let timer: number | null = null;
  let lastArgs: A | null = null;

  const wrapped = (...args: A) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      if (lastArgs) fn(...lastArgs);
      lastArgs = null;
    }, waitMs);
  };

  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  return wrapped;
}
