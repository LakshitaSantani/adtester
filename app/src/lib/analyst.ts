/**
 * The analyst.
 *
 * Everything before this decided WHICH change caused a problem, using queries
 * and arithmetic that a person can check line by line. This step explains
 * WHAT the change did and HOW to fix it — and that is a different kind of
 * question, one where reading code and judging relevance genuinely beats a
 * rule.
 *
 * The division is deliberate and it is the whole safety argument. An agent
 * handed all the data and asked "what caused this" will produce a confident
 * answer every single time; that is what it is for. So it is never asked. It
 * arrives after the verdict, is told which commit is responsible, and is
 * asked only to explain a conclusion it did not reach.
 *
 * Three hard limits, enforced in code rather than requested in a prompt:
 *
 *   - It cannot change the confidence number. It never sees one.
 *   - It cannot name a different commit. The subject is fixed by the caller.
 *   - A fix must be a small edit to a file the change actually touched, or
 *     no fix is offered at all.
 */

import { getFile, type RepoRef } from "./github";
import type { IntentMatch } from "./intent";

/** A patch bigger than this stops being checkable at a glance. */
const MAX_FIX_LINES = 40;

/** How much of a changed file to show. Enough for context, not a whole app. */
const MAX_FILE_CHARS = 12_000;

export type Analysis = {
  /** What the change actually did, in plain terms. */
  whatChanged: string;
  /** How that produced the behaviour users hit. */
  howItBroke: string;
  /** The user's experience, drawn from the recording. */
  whatUsersHit: string;
  fix: {
    path: string;
    rationale: string;
    /** Unified diff, or null when no small safe edit exists. */
    patch: string | null;
    /** Said out loud when a fix would be too large to trust. */
    caveat: string | null;
  } | null;
};

type AnalystInput = {
  /** Resolved per project, falling back to the server's own. */
  apiKey: string | null;
  commit: { sha: string; message: string; files: string[] };
  diff: string | null;
  fileContents: Array<{ path: string; content: string }>;
  timeline: string;
  symptom: string;
  intent: IntentMatch[];
};

/**
 * Fetch the source of the files a commit touched.
 *
 * The current contents rather than the historical version: a fix has to apply
 * to the code as it stands now, and proposing a patch against a week-old
 * revision produces something that will not apply.
 */
export async function fetchFileContents(
  repo: RepoRef,
  branch: string,
  files: string[],
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  for (const path of files.slice(0, 4)) {
    const content = await getFile(repo, branch, path);
    if (content && content.length <= MAX_FILE_CHARS) {
      out.push({ path, content });
    }
  }
  return out;
}

export async function analyse(input: AnalystInput): Promise<Analysis | null> {
  const apiKey = input.apiKey;
  if (!apiKey) return null;

  const intentBlock =
    input.intent.length > 0
      ? input.intent
          .map(
            (m) =>
              `- ${m.kind}${m.speaker ? ` (${m.speaker})` : ""} in "${m.documentTitle}": "${m.quote}"`,
          )
          .join("\n")
      : "None found.";

  const filesBlock =
    input.fileContents.length > 0
      ? input.fileContents
          .map((f) => `--- ${f.path} ---\n${f.content}`)
          .join("\n\n")
      : "Source unavailable.";

  const prompt = `You are explaining a defect that has ALREADY been traced to a
specific commit by separate evidence. Do not re-litigate which commit is
responsible, and do not comment on how likely it is. That is settled.

Your job is to explain what this change did, how it produced the behaviour
users hit, and whether there is a small safe fix.

THE PROBLEM: ${input.symptom}

THE COMMIT: ${input.commit.sha} — ${input.commit.message}
FILES: ${input.commit.files.join(", ")}

${input.diff ? `THE DIFF:\n${input.diff}\n` : ""}
CURRENT SOURCE:
${filesBlock}

WHAT A USER ACTUALLY DID (from a recording of an affected session):
${input.timeline}

WHAT THE TEAM SAID THEY WERE BUILDING:
${intentBlock}

Rules for the fix:
- It must be a small edit to one of the files listed above.
- If a correct fix would be large, a refactor, or needs a decision only the
  team can make, return patch: null and say why in "caveat". A wrong small
  patch costs more trust than no patch.
- The patch must be a unified diff that applies to the current source shown.
- Keep it under ${MAX_FIX_LINES} changed lines.

Return JSON only:
{"whatChanged":"<1-2 sentences on what the code now does differently>",
 "howItBroke":"<1-2 sentences connecting that to the user-visible failure>",
 "whatUsersHit":"<1-2 sentences describing the experience from the recording>",
 "fix":{"path":"<file>","rationale":"<1 sentence>","patch":"<unified diff or null>","caveat":"<why no patch, or null>"}}

If you cannot explain the connection from the evidence given, set
"howItBroke" to an honest statement of what is missing rather than guessing.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-3-opus-20240229",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.log(`analyst: model call failed (${response.status})`);
      return null;
    }

    const data = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.map((c) => c.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

    return sanitise(parsed, input);
  } catch (error) {
    // The finding stands on its own evidence. An explanation that fails to
    // generate must never take it down with it.
    console.log("analyst: could not produce an analysis", error);
    return null;
  }
}

/**
 * Enforce in code what the prompt asked for.
 *
 * A patch touching a file the commit never went near, or one long enough to
 * hide a mistake, is dropped rather than shown. Prompt instructions are a
 * request; this is the actual constraint.
 */
function sanitise(raw: Record<string, unknown>, input: AnalystInput): Analysis {
  const allowed = new Set(input.fileContents.map((f) => f.path));

  let fix: Analysis["fix"] = null;
  const rawFix = raw.fix as Record<string, unknown> | null | undefined;

  if (rawFix && typeof rawFix.path === "string") {
    const patch = typeof rawFix.patch === "string" ? rawFix.patch.trim() : null;
    const changedLines = patch
      ? patch.split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).length
      : 0;

    const pathAllowed = allowed.has(rawFix.path);
    const sizeOk = !patch || changedLines <= MAX_FIX_LINES;

    fix = {
      path: rawFix.path,
      rationale: String(rawFix.rationale ?? "").slice(0, 300),
      patch: pathAllowed && sizeOk && patch ? patch : null,
      caveat: !pathAllowed
        ? "A patch was proposed for a file this change didn't touch, so it was dropped."
        : !sizeOk
          ? `The proposed edit ran to ${changedLines} lines, past the point where it can be checked at a glance.`
          : typeof rawFix.caveat === "string" && rawFix.caveat.trim()
            ? rawFix.caveat.slice(0, 300)
            : null,
    };
  }

  return {
    whatChanged: String(raw.whatChanged ?? "").slice(0, 600),
    howItBroke: String(raw.howItBroke ?? "").slice(0, 600),
    whatUsersHit: String(raw.whatUsersHit ?? "").slice(0, 600),
    fix,
  };
}
