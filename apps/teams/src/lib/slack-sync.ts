/**
 * Keeping Slack in the chunk table, without ever asking anyone for a date.
 *
 * Two jobs. Refreshing the channel list, so setup can show the workspace and
 * let somebody tick what is worth reading. And fetching history for the
 * ticked ones, which is where the date question would normally appear and
 * doesn't: the first run reaches back as far as the engine can still use, and
 * every run after that resumes from a per-channel watermark.
 *
 * The watermark is per channel rather than per project on purpose. Channels
 * get enabled at different times, one can fail while others succeed, and a
 * single project-wide marker would either re-read everything or skip the
 * channel that was added yesterday.
 */

import { ingestDocument } from "@brain/ingest-docs";
import { getDb } from "@brain/db";
import { syncSince } from "@brain/window";
import { fetchThreads, fetchUsers, listChannels, verifyToken } from "./slack";

/**
 * How old a Linear issue can be and still be a candidate.
 *
 * The equivalent of the git product's commit window. Issues carry real
 * timestamps for when work moved state, so this is the shorter of the two
 * windows that product uses rather than the thirty-day allowance it makes for
 * commits whose deploy time is a guess.
 */
export const CHANGE_WINDOW_DAYS = 14;

export type SyncSummary = {
  channels: number;
  threads: number;
  chunks: number;
  skipped: string[];
  errors: Array<{ channel: string; error: string }>;
};

/**
 * Refresh what channels exist, without changing what anyone chose to read.
 *
 * Runs on connect and on demand. Existing rows keep their enabled flag and
 * their watermark — a channel being renamed or gaining members must not
 * quietly turn indexing on, or off.
 */
export async function refreshChannels(
  projectId: string,
  token: string,
): Promise<{ workspace: string; channels: number }> {
  const db = await getDb();
  const identity = await verifyToken(token);
  const channels = await listChannels(token);

  for (const c of channels) {
    await db.query(
      `INSERT INTO slack_channels (project_id, channel_id, name, is_private, members)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id, channel_id) DO UPDATE SET
         name = EXCLUDED.name,
         is_private = EXCLUDED.is_private,
         members = EXCLUDED.members`,
      [projectId, c.id, c.name, c.isPrivate, c.members],
    );
  }

  return { workspace: identity.team, channels: channels.length };
}

/**
 * Read every enabled channel from wherever it got to last time.
 *
 * A channel that fails records why and does not move its watermark, so the
 * next run retries the same stretch rather than stepping over it. One channel
 * the app was never invited to should cost that channel, not the sync.
 */
export async function syncSlack(
  projectId: string,
  token: string,
  workspaceUrl: string | null,
): Promise<SyncSummary> {
  const db = await getDb();
  const summary: SyncSummary = {
    channels: 0,
    threads: 0,
    chunks: 0,
    skipped: [],
    errors: [],
  };

  const enabled = await db.query<{
    channel_id: string;
    name: string;
    last_synced_at: string | null;
  }>(
    `SELECT channel_id, name, last_synced_at::text
       FROM slack_channels
      WHERE project_id = $1 AND enabled = true
      ORDER BY members DESC`,
    [projectId],
  );

  if (enabled.length === 0) return summary;

  // Once for the whole run. Resolving a name per message is a request per
  // message, which reaches Slack's rate limit long before it reaches an
  // answer.
  const users = await fetchUsers(token);

  for (const channel of enabled) {
    const since = syncSince(channel.last_synced_at, CHANGE_WINDOW_DAYS);

    try {
      const threads = await fetchThreads(
        token,
        { id: channel.channel_id, name: channel.name },
        since,
        users,
        workspaceUrl,
      );

      let newest = channel.last_synced_at ? new Date(channel.last_synced_at) : since;

      for (const thread of threads) {
        const result = await ingestDocument(projectId, {
          // Readable, and unique per thread through the URL below — two
          // threads in one channel on one day would otherwise collide.
          filename: `#${thread.channelName} · ${thread.occurredAt
            .toISOString()
            .slice(0, 16)
            .replace("T", " ")}`,
          text: thread.transcript,
          occurredAt: thread.occurredAt.toISOString(),
          url: thread.url,
          source: "slack",
          // Declared rather than sniffed: a four-line thread is still a
          // conversation, and guessing would strip every speaker off it.
          kind: "transcript",
        });

        summary.threads += 1;
        summary.chunks += result.chunks;
        if (thread.occurredAt > newest) newest = thread.occurredAt;
      }

      await db.query(
        `UPDATE slack_channels
            SET last_synced_at = $3, last_ts = $4, last_error = NULL
          WHERE project_id = $1 AND channel_id = $2`,
        [projectId, channel.channel_id, newest.toISOString(), String(newest.getTime() / 1000)],
      );
      summary.channels += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The watermark deliberately stays where it was: a failed stretch has
      // to be retried, not stepped over.
      await db.query(
        `UPDATE slack_channels SET last_error = $3
          WHERE project_id = $1 AND channel_id = $2`,
        [projectId, channel.channel_id, message.slice(0, 500)],
      );
      summary.errors.push({ channel: channel.name, error: message });
    }
  }

  return summary;
}

/** Turn reading on or off for a channel. Off leaves what was already read. */
export async function setChannelEnabled(
  projectId: string,
  channelId: string,
  enabled: boolean,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE slack_channels SET enabled = $3
      WHERE project_id = $1 AND channel_id = $2`,
    [projectId, channelId, enabled],
  );
}
