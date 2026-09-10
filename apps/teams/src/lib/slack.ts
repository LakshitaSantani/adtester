/**
 * Reading Slack, so a change can be explained by the argument that produced it.
 *
 * In the git product this evidence comes from PRDs and meeting transcripts —
 * "the phone field must accept E.164", "US-only is fine for now, ship the
 * simple version". A team whose work lives in Linear and Slack has the same
 * material; it is just in threads instead of documents.
 *
 * Slack threads are already the right shape for the chunker: attributed lines
 * of people arguing, in order. Rendered as "Name: text" they are detected as
 * transcripts and split on speaker changes, which keeps "who said this" — half
 * of what makes a quote evidence. A concern raised by the tech lead and
 * overruled reads very differently from the same words in an aside.
 *
 * Nothing is summarised on the way in. Every reference implementation of this
 * that I looked at summarises at ingest, and it is the one thing we cannot do:
 * the intent layer only believes a passage it can find verbatim in the source,
 * and a summary destroys exactly the substring that check depends on. Storage
 * is cheap; an unverifiable quote is not.
 */

const SLACK_API = "https://slack.com/api";

/** Messages per request. Slack's own maximum for conversations.history. */
const PAGE_SIZE = 200;

/** Pages per channel per run, so one busy channel can't spend the whole budget. */
const MAX_PAGES = 10;

/**
 * Threads whose replies get fetched, per channel.
 *
 * Each one is its own API call, and Slack's rate limit for these tiers is
 * strict. The substance of a decision is nearly always in a thread rather
 * than the top-level message, so this is the budget worth having, not one to
 * economise on.
 */
const MAX_THREADS = 60;

/** Slack asks for one request per second on these methods; this is the pause. */
const RATE_LIMIT_MS = 1100;

export type SlackMessage = {
  ts: string;
  userId: string | null;
  text: string;
  threadTs: string | null;
  replyCount: number;
};

export type SlackThread = {
  channelId: string;
  channelName: string;
  /** The thread's root timestamp, which is also its permalink anchor. */
  ts: string;
  occurredAt: Date;
  /** Rendered as attributed lines, verbatim, oldest first. */
  transcript: string;
  messageCount: number;
  url: string;
};

type SlackResponse<T> = T & { ok: boolean; error?: string };

/**
 * Fields assigned explicitly rather than as constructor parameter properties.
 *
 * Node's type stripping cannot handle parameter properties — they are syntax
 * that needs emitting, not erasing — and the worker runs TypeScript that way.
 * A class that only fails under the runtime it ships on is not worth the two
 * saved lines.
 */
class SlackError extends Error {
  readonly method: string;
  readonly slackError: string;

  constructor(method: string, slackError: string) {
    super(
      slackError === "missing_scope"
        ? `Slack refused ${method}: the token is missing a scope. Reading history needs ` +
          `channels:history for public channels, groups:history for private ones, and ` +
          `users:read to turn user ids into names.`
        : slackError === "not_in_channel"
          ? `Slack refused ${method}: the app isn't in that channel. Invite it with ` +
            `/invite @yourapp, or use a user token, which can read what you can read.`
          : `Slack refused ${method}: ${slackError}`,
    );
    this.name = "SlackError";
    this.method = method;
    this.slackError = slackError;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Slack call, with the two failures that actually happen handled.
 *
 * A 429 is normal rather than exceptional on these endpoints — Slack answers
 * with how long to wait and expects you to wait it. Everything else surfaces
 * with the scope or invite problem named, because "invalid_auth" on its own
 * has sent enough people to the wrong settings page.
 */
async function call<T>(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<SlackResponse<T>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${SLACK_API}/${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? "5");
      await sleep((wait + 1) * 1000);
      continue;
    }

    const body = (await response.json()) as SlackResponse<T>;
    if (!body.ok) throw new SlackError(method, body.error ?? "unknown_error");
    return body;
  }

  throw new SlackError(method, "rate_limited_repeatedly");
}

/**
 * Everyone in the workspace, fetched once.
 *
 * Resolving a user id per message is the obvious way to do this and it is a
 * request per message, which on a real channel means rate limiting long
 * before it means an answer. One listing covers the whole run.
 */
export async function fetchUsers(token: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await call<{
      members: Array<{
        id: string;
        real_name?: string;
        name?: string;
        profile?: { display_name?: string };
      }>;
      response_metadata?: { next_cursor?: string };
    }>(token, "users.list", { limit: "200", ...(cursor ? { cursor } : {}) });

    for (const m of body.members ?? []) {
      names.set(m.id, m.profile?.display_name || m.real_name || m.name || m.id);
    }

    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
    await sleep(RATE_LIMIT_MS);
  }

  return names;
}

/** The channels a token can see, so setup can offer a list rather than ask for ids. */
export async function listChannels(
  token: string,
): Promise<Array<{ id: string; name: string; isPrivate: boolean; members: number }>> {
  const out: Array<{ id: string; name: string; isPrivate: boolean; members: number }> = [];
  let cursor = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await call<{
      channels: Array<{
        id: string;
        name: string;
        is_private: boolean;
        num_members?: number;
      }>;
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.list", {
      limit: "200",
      exclude_archived: "true",
      types: "public_channel,private_channel",
      ...(cursor ? { cursor } : {}),
    });

    for (const c of body.channels ?? []) {
      out.push({
        id: c.id,
        name: c.name,
        isPrivate: c.is_private,
        members: c.num_members ?? 0,
      });
    }

    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
    await sleep(RATE_LIMIT_MS);
  }

  return out.sort((a, b) => b.members - a.members);
}

/** A Slack timestamp is seconds with microseconds after the dot. */
function tsToDate(ts: string): Date {
  return new Date(Number(ts.split(".")[0]) * 1000);
}

/**
 * Turn raw messages into attributed lines.
 *
 * Bot posts and join/leave notices are dropped: a deploy bot announcing a
 * release is a change event rather than an argument about one, and "X joined
 * the channel" is noise that would dilute every passage around it.
 */
function render(
  messages: SlackMessage[],
  users: Map<string, string>,
): { transcript: string; count: number } {
  const lines: string[] = [];

  for (const m of messages) {
    if (!m.text.trim() || !m.userId) continue;
    const who = users.get(m.userId) ?? m.userId;
    // Slack wraps mentions and links in angle brackets; left as-is they read
    // as noise in a quote, and a quote is what a person will be shown.
    const text = m.text
      .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_, id: string) => `@${users.get(id) ?? id}`)
      .replace(/<(https?:\/\/[^|>]+)(\|([^>]+))?>/g, (_, url: string, __, label: string) =>
        label || url,
      )
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .trim();
    if (text) lines.push(`${who}: ${text}`);
  }

  return { transcript: lines.join("\n"), count: lines.length };
}

/**
 * Exposed so the rendering can be checked without a workspace.
 *
 * This is where a thread stops being Slack's data model and becomes the
 * attributed lines the chunker splits on. If it regresses, every quote in
 * every report loses its speaker, and a quote without a speaker is half an
 * argument — which no live run would fail loudly enough to notice.
 */
export function renderForTesting(
  messages: SlackMessage[],
  users: Map<string, string>,
): { transcript: string; count: number } {
  return render(messages, users);
}

/**
 * Every thread in a channel that has been active since `since`.
 *
 * conversations.history returns top-level messages only, so a channel read
 * that way is all openings and no arguments — the reply is where somebody
 * says why. Threads with replies are therefore fetched in full, and a
 * top-level message with no replies is kept on its own so a one-line
 * announcement isn't lost.
 */
export async function fetchThreads(
  token: string,
  channel: { id: string; name: string },
  since: Date,
  users: Map<string, string>,
  workspaceUrl: string | null,
): Promise<SlackThread[]> {
  const oldest = String(Math.floor(since.getTime() / 1000));
  const roots: SlackMessage[] = [];
  let cursor = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await call<{
      messages: Array<{
        ts: string;
        user?: string;
        text?: string;
        subtype?: string;
        thread_ts?: string;
        reply_count?: number;
        bot_id?: string;
      }>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.history", {
      channel: channel.id,
      oldest,
      limit: String(PAGE_SIZE),
      ...(cursor ? { cursor } : {}),
    });

    for (const m of body.messages ?? []) {
      // Anything with a subtype is a join, a leave, a channel rename or a
      // file comment rather than somebody making a point.
      if (m.subtype || m.bot_id || !m.user) continue;
      roots.push({
        ts: m.ts,
        userId: m.user,
        text: m.text ?? "",
        threadTs: m.thread_ts ?? null,
        replyCount: m.reply_count ?? 0,
      });
    }

    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor || !body.has_more) break;
    await sleep(RATE_LIMIT_MS);
  }

  const threads: SlackThread[] = [];
  const withReplies = roots.filter((m) => m.replyCount > 0).slice(0, MAX_THREADS);
  const standalone = roots.filter((m) => m.replyCount === 0);

  const permalink = (ts: string) =>
    workspaceUrl
      ? `${workspaceUrl.replace(/\/$/, "")}/archives/${channel.id}/p${ts.replace(".", "")}`
      : `https://slack.com/archives/${channel.id}/p${ts.replace(".", "")}`;

  for (const root of withReplies) {
    await sleep(RATE_LIMIT_MS);
    const body = await call<{
      messages: Array<{
        ts: string;
        user?: string;
        text?: string;
        subtype?: string;
        bot_id?: string;
      }>;
    }>(token, "conversations.replies", {
      channel: channel.id,
      ts: root.ts,
      limit: String(PAGE_SIZE),
    });

    const messages: SlackMessage[] = (body.messages ?? [])
      .filter((m) => !m.subtype && !m.bot_id && m.user)
      .map((m) => ({
        ts: m.ts,
        userId: m.user ?? null,
        text: m.text ?? "",
        threadTs: root.ts,
        replyCount: 0,
      }));

    const { transcript, count } = render(messages, users);
    if (count === 0) continue;

    threads.push({
      channelId: channel.id,
      channelName: channel.name,
      ts: root.ts,
      occurredAt: tsToDate(root.ts),
      transcript,
      messageCount: count,
      url: permalink(root.ts),
    });
  }

  // Unreplied messages are collected per day rather than one document each.
  // A hundred single-line documents would each get a guaranteed coverage slot
  // in retrieval and crowd out the threads where the reasoning actually is.
  const byDay = new Map<string, SlackMessage[]>();
  for (const m of standalone) {
    const day = tsToDate(m.ts).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), m]);
  }

  for (const [day, messages] of byDay) {
    const ordered = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    const { transcript, count } = render(ordered, users);
    if (count === 0) continue;

    threads.push({
      channelId: channel.id,
      channelName: `${channel.name} (${day})`,
      ts: ordered[0].ts,
      occurredAt: tsToDate(ordered[0].ts),
      transcript,
      messageCount: count,
      url: permalink(ordered[0].ts),
    });
  }

  return threads;
}

/** Check a token and say who it belongs to, for the setup page. */
export async function verifyToken(
  token: string,
): Promise<{ team: string; user: string; url: string | null }> {
  const body = await call<{ team?: string; user?: string; url?: string }>(
    token,
    "auth.test",
    {},
  );
  return {
    team: body.team ?? "unknown workspace",
    user: body.user ?? "unknown",
    url: body.url ?? null,
  };
}
