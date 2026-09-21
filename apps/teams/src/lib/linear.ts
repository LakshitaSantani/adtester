/**
 * Reading Linear: what shipped, and when it actually shipped.
 *
 * A commit brings a deploy timestamp for free. An issue brings several
 * candidate timestamps that all sound like the right one and mostly aren't:
 *
 *   issue.completedAt        when the issue was LAST marked complete
 *   issue.updatedAt          the last edit of any kind — title, a label, a comment
 *   the history entry itself the moment of ONE specific transition
 *
 * completedAt is the property of an issue, not of a transition. Reopen an
 * issue and complete it again and completedAt moves to the second time,
 * silently — there is no way to tell from the issue alone that this
 * happened, or which completion the counterfactual should split users on. So
 * this reads history() and keeps the createdAt of the transition into a
 * "completed"-type state, which is the one fact that is actually true of the
 * moment being investigated.
 *
 * Checked directly against the installed @linear/sdk (v95) rather than
 * assumed: IssueHistory has no generic type/from/to — a single row can carry
 * a state change, a reassignment, an estimate change and several others at
 * once, as separate optional from-X/to-X pairs. Only fromStateId/toStateId
 * is read here; the reference implementation found during research cast the
 * whole object to `any` and reached for fields the type does not have.
 */

import { LinearClient, LinearError, LinearErrorType } from "@linear/sdk";

/** Issues read per request. Linear's page complexity budget makes 250 safe here. */
const PAGE_SIZE = 100;

/** Pages per sync, so one very active workspace can't spend an unbounded run. */
const MAX_PAGES = 20;

/** Comments fetched per issue, when building the intent corpus. */
const MAX_COMMENTS_PER_ISSUE = 100;

export type LinearChange = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  stateType: string;
  /** The transition into a completed state, if one happened. */
  movedToCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  teamKey: string | null;
  labels: string[];
  assignee: string | null;
  url: string;
};

export type LinearCommentThread = {
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  /** Rendered as attributed lines, verbatim, oldest first. */
  transcript: string;
  messageCount: number;
  occurredAt: Date;
  url: string;
};

function client(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

/**
 * Turn a thrown SDK error into something that says what to fix.
 *
 * An invalid key and a key with too few scopes both surface as GraphQL
 * errors with different codes, and "authentication failed" alone sends
 * someone back to the same wrong field they just filled in.
 */
function explain(error: unknown): Error {
  if (error instanceof LinearError) {
    if (error.type === LinearErrorType.AuthenticationError) {
      return new Error(
        "Linear rejected this key. Personal API keys are created under " +
          "Settings → Account → Security & access → New API key.",
      );
    }
    if (error.type === LinearErrorType.Ratelimited) {
      return new Error("Linear rate-limited this request. Worth retrying shortly.");
    }
    return new Error(`Linear API error: ${error.errors?.[0]?.message ?? error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The moment an issue most recently moved into a completed state.
 *
 * Deliberately independent of what order the API returns history in. I could
 * not confirm from the shipped type declarations (the query variable types
 * are aliased through a minified re-export and don't state a default sort)
 * whether history arrives newest-first, and guessing wrong would silently
 * pick the FIRST time an issue was ever completed rather than the most
 * recent — the exact bug this exists to avoid, on an issue reopened once and
 * finished again. Taking the max over every matching transition costs
 * nothing and is correct under either ordering, or no ordering at all.
 */
function latestCompletionTransition(
  history: Array<{ toStateId: string | null; createdAt: Date }>,
  stateType: Map<string, string>,
): Date | null {
  let latest: Date | null = null;
  for (const entry of history) {
    if (!entry.toStateId || stateType.get(entry.toStateId) !== "completed") continue;
    if (!latest || entry.createdAt > latest) latest = entry.createdAt;
  }
  return latest;
}

/**
 * Exposed so the transition logic can be checked without a workspace.
 *
 * This is the timestamp the counterfactual splits users on. Get it wrong and
 * every comparison downstream is comparing the wrong two groups while
 * reporting full confidence in the result.
 */
export function latestCompletionTransitionForTesting(
  history: Array<{ toStateId: string | null; createdAt: Date }>,
  stateType: Map<string, string>,
): Date | null {
  return latestCompletionTransition(history, stateType);
}

/** Check a key and say whose workspace it belongs to, for the setup page. */
export async function verifyKey(
  apiKey: string,
): Promise<{ organization: string; user: string }> {
  try {
    const viewer = await client(apiKey).viewer;
    const org = await viewer.organization;
    return { organization: org.name, user: viewer.name };
  } catch (error) {
    throw explain(error);
  }
}

/**
 * Every issue that moved into a completed state since `since`, plus every
 * other issue touched in the window for a report to say what else was
 * happening.
 *
 * State types are resolved once into a lookup rather than once per issue —
 * the SDK's own accessor (`history.toState`) is a network call per row, and
 * a window with fifty transitions would mean fifty extra requests for
 * information that comes from a handful of workflow states per team.
 */
export async function fetchChangedIssues(
  apiKey: string,
  since: Date,
): Promise<LinearChange[]> {
  const c = client(apiKey);

  const states = await c.workflowStates({ first: 250 });
  const stateType = new Map(states.nodes.map((s) => [s.id, s.type]));

  const out: LinearChange[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let connection;
    try {
      connection = await c.issues({
        first: PAGE_SIZE,
        after: cursor,
        orderBy: "updatedAt" as never,
        filter: {
          updatedAt: { gte: since.toISOString() },
        } as never,
      });
    } catch (error) {
      throw explain(error);
    }

    for (const issue of connection.nodes) {
      const [state, team, assignee, labelConn] = await Promise.all([
        issue.state,
        issue.team,
        issue.assignee,
        issue.labels(),
      ]);

      let movedToCompletedAt: Date | null = null;

      // Only look at history for an issue that IS completed. An issue that
      // was completed and reopened has state.type back to something else,
      // and its most recent completion is no longer the current picture —
      // treating it as a shipped change would claim something that, as far
      // as this workspace is concerned right now, did not ship.
      if (state?.type === "completed") {
        const history = await issue.history({ first: 50 });
        movedToCompletedAt =
          latestCompletionTransition(
            history.nodes.map((e) => ({ toStateId: e.toStateId ?? null, createdAt: e.createdAt })),
            stateType,
          ) ??
          // A workspace can complete an issue by hand with no recorded
          // transition (a bulk edit, an import). completedAt is the only
          // fact left in that case, worse than a transition but not nothing.
          issue.completedAt ??
          null;
      }

      out.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        stateType: state?.type ?? "unknown",
        movedToCompletedAt,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        teamKey: team?.key ?? null,
        labels: labelConn.nodes.map((l) => l.name),
        assignee: assignee?.name ?? null,
        url: issue.url,
      });
    }

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor ?? undefined;
  }

  return out;
}

/**
 * An issue's comment thread, rendered as attributed lines.
 *
 * The same shape Slack threads are rendered as, deliberately: both go through
 * the same transcript chunker afterward, and "who said this" is half of what
 * makes a quote evidence in either source.
 */
/**
 * Turn raw comments into attributed lines, oldest first.
 *
 * Ordered explicitly rather than trusted from the API for the same reason as
 * the history transition above: comment order isn't confirmed from the
 * shipped types, and a transcript read backwards attributes each reply to
 * the wrong point in the argument.
 */
function renderComments(
  comments: Array<{ body: string; createdAt: Date; authorName: string | null }>,
): { transcript: string; count: number; latest: Date | null } {
  const lines = comments
    .map((c) => ({ ...c, body: c.body.trim() }))
    .filter((c) => c.body)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return {
    transcript: lines.map((c) => `${c.authorName ?? "Someone"}: ${c.body}`).join("\n"),
    count: lines.length,
    latest: lines.length > 0 ? lines[lines.length - 1].createdAt : null,
  };
}

/**
 * Exposed so the ordering and filtering can be checked without a workspace.
 */
export function renderCommentsForTesting(
  comments: Array<{ body: string; createdAt: Date; authorName: string | null }>,
): { transcript: string; count: number; latest: Date | null } {
  return renderComments(comments);
}

export async function fetchCommentThread(
  apiKey: string,
  issueId: string,
): Promise<LinearCommentThread | null> {
  const c = client(apiKey);

  let issue;
  try {
    issue = await c.issue(issueId);
  } catch (error) {
    throw explain(error);
  }
  if (!issue) return null;

  const comments = await issue.comments({ first: MAX_COMMENTS_PER_ISSUE });
  if (comments.nodes.length === 0) return null;

  const withAuthors = await Promise.all(
    comments.nodes.map(async (comment) => ({
      body: comment.body,
      createdAt: comment.createdAt,
      authorName: (await comment.user)?.name ?? null,
    })),
  );

  const { transcript, count, latest } = renderComments(withAuthors);
  if (count === 0) return null;

  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    transcript,
    messageCount: count,
    occurredAt: latest ?? issue.updatedAt,
    url: `${issue.url}#comment`,
  };
}
