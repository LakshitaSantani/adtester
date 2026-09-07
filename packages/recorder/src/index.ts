/**
 * Public entry point.
 *
 * Two ways to use it, both landing on the same code:
 *
 *   1. A script tag with data attributes — auto-starts, nothing else to write.
 *   2. `window.swy("init", key, options)` — for anything more involved.
 *
 * The queue pattern is Milana's, including the detail that matters most:
 * after draining the backlog we replace the array with an object whose
 * `push` dispatches immediately, so a straggler snippet elsewhere on the
 * page still works instead of silently piling up into an array nobody reads.
 */

import { Session } from "./session";
import type { InitOptions } from "./types";

type QueuedCall = [string, ...unknown[]];

function init(key: string, options: InitOptions = {}): void {
  if (Session.current) {
    console.info("swy: already initialised");
    return;
  }
  if (!key || typeof key !== "string") {
    console.warn("swy: init() needs a project key");
    return;
  }

  const session = new Session(key, options);
  Session.current = session;

  void session.start().then(({ started }) => {
    if (!started && Session.current === session) Session.current = null;
  });
}

function stop(): void {
  const session = Session.current;
  if (!session) return;
  session.stop();
  Session.current = null;
}

function track(name: string, attributes?: Record<string, unknown>): void {
  Session.current?.trackEvent(name, attributes ?? {});
}

function dispatch(args: unknown[]): void {
  try {
    const [command, ...rest] = args;
    switch (command) {
      case "init":
        init(rest[0] as string, rest[1] as InitOptions | undefined);
        break;
      case "track":
        track(rest[0] as string, rest[1] as Record<string, unknown> | undefined);
        break;
      case "stop":
        stop();
        break;
      default:
        console.warn(`swy: unknown command "${String(command)}"`);
    }
  } catch (error) {
    // A bad call from the host page must never throw into the host page.
    console.warn("swy: command failed, page continues unaffected", error);
  }
}

if (typeof window !== "undefined") {
  const api = function swy(...args: unknown[]) {
    dispatch(args);
  } as typeof window.swy;

  const backlog = Array.isArray(window._swyQueue) ? [...window._swyQueue] : [];

  window.swy = api;
  window._swyQueue = {
    push(args: QueuedCall) {
      dispatch(args);
      return 0;
    },
  } as unknown as QueuedCall[];

  for (const call of backlog) dispatch(call as QueuedCall);

  // Auto-start from script tag attributes:
  //   <script src=".../rec.js" data-swy-key="..." data-swy-release="abc123">
  try {
    const tag =
      (document.currentScript as HTMLScriptElement | null) ??
      document.querySelector<HTMLScriptElement>("script[data-swy-key]");

    const key = tag?.dataset.swyKey;
    if (key && !Session.current) {
      init(key, {
        release: tag?.dataset.swyRelease,
        endpoint: tag?.dataset.swyEndpoint,
        privacy: tag?.dataset.swyMasking
          ? { maskingLevel: tag.dataset.swyMasking as "normal" | "high" | "xhigh" }
          : undefined,
      });
    }
  } catch (error) {
    console.warn("swy: auto-init failed, page continues unaffected", error);
  }
}

export { init, stop, track };
export type { InitOptions } from "./types";
