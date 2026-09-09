/**
 * The PostHog connector.
 *
 * PostHog records with rrweb, exactly as we do, so its stored snapshots feed
 * our player and our signature extraction with no translation. That is the
 * whole reason this connector is worth building: a customer's existing
 * PostHog account holds months of real sessions from real users, and
 * borrowing them means the investigator can be judged on real behaviour today
 * rather than after a fortnight of collecting our own.
 *
 * Read-only throughout. We never write anything back to their account.
 */

export type PostHogConfig = {
  /** https://us.i.posthog.com, https://eu.i.posthog.com, or self-hosted. */
  host: string;
  /** The numeric project id from their PostHog URL. */
  projectId: string;
  /** A personal API key. Needs session_recording:read and query:read. */
  apiKey: string;
};

export type PostHogRecording = {
  id: string;
  distinctId: string | null;
  startTime: string;
  endTime: string | null;
  durationSeconds: number;
  startUrl: string | null;
  clickCount: number;
  keypressCount: number;
  consoleErrorCount: number;
};

export class PostHogError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function normaliseHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

async function api<T>(
  config: PostHogConfig,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${normaliseHost(config.host)}/api/projects/${config.projectId}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new PostHogError(explain(response.status), response.status);
  }
  return (await response.json()) as T;
}

function explain(status: number): string {
  if (status === 401) {
    return "PostHog rejected the key. Personal API keys start with phx_ — a project API key (phc_) won't work here, it can only write.";
  }
  if (status === 403) {
    return "The key is valid but lacks permission. It needs the session_recording:read and query:read scopes, and access to this project.";
  }
  if (status === 404) {
    return "Project not found. Check the project id — it's the number in your PostHog URL, not the project name.";
  }
  if (status === 429) {
    return "PostHog rate limit reached. Wait a few minutes and sync again.";
  }
  return `PostHog returned ${status}`;
}

/** Confirm the credentials before saving them, so failures surface early. */
export async function verify(config: PostHogConfig): Promise<{ name: string }> {
  const project = await api<{ name?: string }>(config, "");
  return { name: project.name ?? `Project ${config.projectId}` };
}

/**
 * Recent recordings, newest first.
 *
 * Sorted so a small import gets the most useful window rather than an
 * arbitrary one — the investigator compares a recent period against a
 * baseline, and both need to land inside whatever we pull.
 */
export async function listRecordings(
  config: PostHogConfig,
  { limit = 100, afterDays = 30 }: { limit?: number; afterDays?: number } = {},
): Promise<PostHogRecording[]> {
  const after = new Date(Date.now() - afterDays * 86_400_000).toISOString();

  const data = await api<{
    results: Array<{
      id: string;
      distinct_id?: string;
      start_time: string;
      end_time?: string;
      recording_duration?: number;
      start_url?: string;
      click_count?: number;
      keypress_count?: number;
      console_error_count?: number;
    }>;
  }>(config, "/session_recordings/", {
    limit: String(Math.min(limit, 100)),
    date_from: after,
  });

  return (data.results ?? []).map((r) => ({
    id: r.id,
    distinctId: r.distinct_id ?? null,
    startTime: r.start_time,
    endTime: r.end_time ?? null,
    durationSeconds: r.recording_duration ?? 0,
    startUrl: r.start_url ?? null,
    clickCount: r.click_count ?? 0,
    keypressCount: r.keypress_count ?? 0,
    consoleErrorCount: r.console_error_count ?? 0,
  }));
}

/**
 * The rrweb events for one recording.
 *
 * PostHog stores snapshots in chunks ("blobs"), so this is a listing request
 * followed by one fetch per chunk. The chunk format has changed across
 * PostHog versions and self-hosted installs lag, so both the wrapped
 * (`{window_id, data}`) and bare event shapes are accepted — see
 * normalizeEvent in rrweb-signals.
 */
export async function fetchSnapshots(
  config: PostHogConfig,
  recordingId: string,
): Promise<unknown[]> {
  const listing = await api<{
    sources?: Array<{ source: string; blob_key?: string }>;
  }>(config, `/session_recordings/${recordingId}/snapshots/`);

  const blobs = (listing.sources ?? []).filter((s) => s.blob_key);
  if (blobs.length === 0) {
    // Older installs return the events inline instead of a source listing.
    const inline = listing as unknown as { snapshots?: unknown[] };
    return inline.snapshots ?? [];
  }

  const events: unknown[] = [];

  for (const blob of blobs) {
    const url = new URL(
      `${normaliseHost(config.host)}/api/projects/${config.projectId}` +
        `/session_recordings/${recordingId}/snapshots/`,
    );
    url.searchParams.set("source", blob.source);
    if (blob.blob_key) url.searchParams.set("blob_key", blob.blob_key);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) continue; // a missing chunk costs detail, not the session

    const text = await response.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        // A chunk is usually one event per line, but can be an array.
        if (Array.isArray(parsed)) events.push(...parsed);
        else events.push(parsed);
      } catch {
        // Skip an unparseable line rather than losing the whole chunk.
      }
    }
  }

  return events;
}

/**
 * Run HogQL against their event data.
 *
 * Used to hunt for a build/version property, which is the one field the
 * counterfactual needs and nothing captures by default.
 */
export async function query<T = unknown>(
  config: PostHogConfig,
  hogql: string,
): Promise<T[]> {
  const response = await fetch(
    `${normaliseHost(config.host)}/api/projects/${config.projectId}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
    },
  );

  if (!response.ok) throw new PostHogError(explain(response.status), response.status);

  const data = (await response.json()) as { results?: T[] };
  return data.results ?? [];
}

/**
 * Look for a property that carries the customer's build version.
 *
 * Returns the property name if one is populated on recent events, so the
 * import can then read it per session. Nothing found means no counterfactual,
 * which the investigator handles by capping confidence and saying why.
 */
export async function detectReleaseProperty(
  config: PostHogConfig,
): Promise<{ property: string; sample: string } | null> {
  const candidates = [
    "$app_version",
    "release",
    "version",
    "app_version",
    "build",
    "commit_sha",
    "git_sha",
  ];

  for (const property of candidates) {
    try {
      const rows = await query<[string, number]>(
        config,
        `SELECT properties.${property} AS v, count() AS n
           FROM events
          WHERE timestamp > now() - INTERVAL 14 DAY
            AND properties.${property} IS NOT NULL
            AND properties.${property} != ''
          GROUP BY v ORDER BY n DESC LIMIT 1`,
      );
      const first = rows[0];
      if (first && first[0]) {
        return { property, sample: String(first[0]) };
      }
    } catch {
      // An unknown property is an error in HogQL, not an empty result.
      // Try the next one.
    }
  }

  return null;
}

/** Per-session values of whichever property carries the build. */
export async function releasesBySession(
  config: PostHogConfig,
  property: string,
  afterDays = 30,
): Promise<Map<string, string>> {
  const rows = await query<[string, string]>(
    config,
    `SELECT $session_id AS sid, any(properties.${property}) AS release
       FROM events
      WHERE timestamp > now() - INTERVAL ${Number(afterDays)} DAY
        AND $session_id IS NOT NULL
        AND properties.${property} IS NOT NULL
      GROUP BY sid
      LIMIT 10000`,
  );

  const out = new Map<string, string>();
  for (const [sid, release] of rows) {
    if (sid && release) out.set(String(sid), String(release));
  }
  return out;
}
