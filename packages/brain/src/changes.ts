/**
 * What a "change" is, once you stop assuming it's a commit.
 *
 * The engine's question is always the same: something started going wrong,
 * what shipped near then, and can we tell those apart by comparing the users
 * who got each one. None of that needs the change to be a commit. It needs a
 * thing with a time, a name, and — if we're lucky — some way of connecting it
 * to the page that broke.
 *
 * A git commit brings all three: a deploy time, a message, and a file list
 * that the import graph turns into "this page reaches that code". A Linear
 * issue moving to Released brings the first two and nothing at all for the
 * third. That difference is real and the scoring already handles it honestly:
 * the code-path signal is worth 0.20, so a source that cannot supply it
 * simply cannot reach the same ceiling. Nothing needs to be capped by hand;
 * the missing evidence is missing, and the arithmetic says so.
 *
 * What this file does is name the seam, so that both products share every
 * line of the reasoning and differ only in where their changes come from.
 */

/** How confident we are that a given build contains a given change. */
export type Ancestry = "carries" | "does_not_carry" | "unknown";

/**
 * Something that shipped, and could explain a problem.
 *
 * `matchedFiles` and `nearestHop` describe the code-path evidence. A source
 * with no notion of files leaves the list empty and the hop at zero, and the
 * code-path signal scores nothing — which is the correct outcome, not a
 * degraded one. Claiming a connection you cannot demonstrate is the failure
 * mode this whole product exists to avoid.
 */
export type Change = {
  /** Stable identifier: a commit sha, an issue key. */
  id: string;
  /** How it should read in a report: "a3f91c2", "LIN-482". */
  ref: string;
  /** One line. A commit subject, an issue title. */
  title: string;
  author: string | null;
  /** When it reached users. The only timestamp the comparison can use. */
  landedAt: string | null;
  /** When it was written, which is a poor substitute and treated as one. */
  authoredAt: string | null;
  url: string | null;
  /** Files it touched that the affected page reaches. Empty when unknowable. */
  matchedFiles: string[];
  /** Everything it touched, so a sprawling change can be recognised as one. */
  filesTouchedCount: number;
  /** Import hops from the page to the nearest matched file. */
  nearestHop: number;
  /** Which chain connects this change to the symptom. */
  reachedVia: "route" | "api" | "both" | "unknown";
};

/**
 * The result of asking a source what could have caused a problem.
 *
 * `deployedInWindow` is the "before" number — everything that shipped,
 * regardless of what it touched. It is what lets a report say "eleven things
 * shipped and two of them could have done this" rather than presenting two
 * suspects out of nowhere. Zero means nothing is connected, which is a
 * different failure from "nothing matched" and is reported as one.
 */
export type NarrowedChanges = {
  path: string | null;
  changes: Change[];
  deployedInWindow: number;
  /** Route patterns the page matched. Empty for sources without code. */
  matchedRoutes: string[];
  matchedApiRoutes: string[];
  reachableFiles: string[];
  note: string | null;
};

/** What the analyst is given to explain a change, when a source can explain one. */
export type ExplainInput = {
  projectId: string;
  change: Change;
  /** The symptom in plain words, as it will appear in the report. */
  symptom: string;
  /** One affected recording, read back as what the person did. */
  timeline: string;
  /** Verbatim passages that bear on this change. */
  intent: Array<{ kind: string; quote: string; documentTitle: string; speaker: string | null }>;
  apiKey: string | null;
};

/** The prose and the fix, when there is enough to write them from. */
export type Analysis = {
  whatChanged: string;
  howItBroke: string;
  whatUsersHit: string;
  fix: {
    path: string;
    rationale: string;
    patch: string | null;
    caveat?: string | null;
  } | null;
};

/**
 * Where changes come from.
 *
 * Everything optional is optional because some source genuinely cannot do it,
 * and the engine has to behave correctly when it isn't there rather than
 * quietly inventing a substitute.
 */
export interface ChangeSource {
  /** A short name for logs and reports: "git", "linear". */
  readonly name: string;

  /**
   * Everything that could explain a problem this session hit.
   *
   * Returning null means the session itself couldn't be read. An empty
   * `changes` list with a non-zero `deployedInWindow` means things shipped
   * but none of them could be connected to this page — which is a real
   * finding, and different from nothing having shipped at all.
   */
  narrow(sessionId: string, path: string | null): Promise<NarrowedChanges | null>;

  /**
   * Does the build serving this session contain that change?
   *
   * Omitted by sources that cannot know. The counterfactual then falls back
   * to comparing when each build first appeared, and says in the report that
   * it did — because a rollback or a cherry-pick defeats timing, and a reader
   * weighing the number deserves to know which basis it rests on.
   */
  carries?(projectId: string, release: string, changeId: string): Promise<Ancestry>;

  /**
   * Explain the change and propose a fix.
   *
   * Omitted by sources with no code to read. A report without this section is
   * a smaller report, not a broken one — and it is a great deal better than a
   * plausible explanation written from a title alone.
   */
  explain?(input: ExplainInput): Promise<Analysis | null>;
}
