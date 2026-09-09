/**
 * The GitHub connector.
 *
 * Two things come from one authorisation, which is why this counts as a
 * single connector rather than two: the commit history (what changed, when)
 * and the codebase itself (how the system is wired). The design doc treats
 * them as separate sources because they answer different questions, but the
 * customer only clicks once.
 *
 * Uses a personal access token the customer pastes in — no OAuth app, no
 * app review, no marketplace listing. That becomes a GitHub App in phase 6,
 * when strangers start signing up.
 */

const API = "https://api.github.com";

export type RepoRef = { owner: string; name: string; token?: string | null };

export type CommitRecord = {
  sha: string;
  authoredAt: string | null;
  author: string | null;
  message: string;
  filesTouched: string[];
  prNumber: number | null;
  prTitle: string | null;
  prBody: string | null;
};

export type TreeFile = { path: string; size: number };

class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function gh<T>(repo: RepoRef, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "simplywhy",
      ...(repo.token ? { Authorization: `Bearer ${repo.token}` } : {}),
    },
  });

  if (!response.ok) {
    // Rate limits and bad tokens are the two failures worth naming, because
    // they're the two a customer can actually do something about.
    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      throw new GitHubError(
        remaining === "0"
          ? "GitHub rate limit reached. It resets within the hour, or add a token with a higher limit."
          : "GitHub rejected the token. Check it has repo read access and hasn't expired.",
        response.status,
      );
    }
    if (response.status === 404) {
      throw new GitHubError(
        "Repository not found. Check the owner/name, and that the token can see it if it's private.",
        404,
      );
    }
    throw new GitHubError(`GitHub returned ${response.status}`, response.status);
  }

  return (await response.json()) as T;
}

export async function getRepoMeta(repo: RepoRef): Promise<{ defaultBranch: string }> {
  const data = await gh<{ default_branch: string }>(repo, `/repos/${repo.owner}/${repo.name}`);
  return { defaultBranch: data.default_branch };
}

/**
 * Recent commits with the files each one touched.
 *
 * The file list needs a second request per commit — the list endpoint
 * doesn't include it — so this is deliberately capped. For an investigation
 * we only ever care about a window of days, not the whole history.
 */
export async function listCommits(
  repo: RepoRef,
  { since, limit = 100 }: { since?: Date; limit?: number } = {},
): Promise<CommitRecord[]> {
  const list = await gh<
    Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } | null };
      author: { login: string } | null;
    }>
  >(repo, `/repos/${repo.owner}/${repo.name}/commits`, {
    per_page: String(Math.min(limit, 100)),
    ...(since ? { since: since.toISOString() } : {}),
  });

  const out: CommitRecord[] = [];

  for (const item of list.slice(0, limit)) {
    let filesTouched: string[] = [];
    let prNumber: number | null = null;
    let prTitle: string | null = null;
    let prBody: string | null = null;

    try {
      const detail = await gh<{ files?: Array<{ filename: string }> }>(
        repo,
        `/repos/${repo.owner}/${repo.name}/commits/${item.sha}`,
      );
      filesTouched = (detail.files ?? []).map((f) => f.filename);
    } catch {
      // A commit whose detail we can't read is still worth recording — we
      // just can't use it for code-path filtering.
    }

    try {
      const pulls = await gh<Array<{ number: number; title: string; body: string | null }>>(
        repo,
        `/repos/${repo.owner}/${repo.name}/commits/${item.sha}/pulls`,
      );
      if (pulls.length > 0) {
        prNumber = pulls[0].number;
        prTitle = pulls[0].title;
        prBody = pulls[0].body;
      }
    } catch {
      // PR association is a nice-to-have; a commit without one is fine.
    }

    out.push({
      sha: item.sha,
      authoredAt: item.commit.author?.date ?? null,
      author: item.author?.login ?? item.commit.author?.name ?? null,
      message: item.commit.message,
      filesTouched,
      prNumber,
      prTitle,
      prBody,
    });
  }

  return out;
}

/**
 * Deployment times, where the customer's pipeline records them.
 *
 * Most teams don't use GitHub Deployments, so this usually comes back empty
 * — which is fine, because we can infer deploy time from the recordings
 * themselves. See inferDeployTimes in lexicon.ts for why that's often the
 * better signal anyway.
 */
export async function listDeployments(
  repo: RepoRef,
): Promise<Array<{ sha: string; deployedAt: string }>> {
  try {
    const deployments = await gh<Array<{ sha: string; created_at: string }>>(
      repo,
      `/repos/${repo.owner}/${repo.name}/deployments`,
      { per_page: "100" },
    );
    return deployments.map((d) => ({ sha: d.sha, deployedAt: d.created_at }));
  } catch {
    return [];
  }
}

/** The whole file tree at a ref, in one request. */
export async function getTree(repo: RepoRef, ref: string): Promise<TreeFile[]> {
  const data = await gh<{
    tree: Array<{ path: string; type: string; size?: number }>;
    truncated: boolean;
  }>(repo, `/repos/${repo.owner}/${repo.name}/git/trees/${ref}`, { recursive: "1" });

  if (data.truncated) {
    console.warn("github: file tree was truncated; lexicon will be partial");
  }

  return data.tree
    .filter((n) => n.type === "blob")
    .map((n) => ({ path: n.path, size: n.size ?? 0 }));
}

/**
 * The patch for one commit, as a unified diff.
 *
 * Capped per file: a lockfile or a generated bundle can run to tens of
 * thousands of lines and would crowd out the change that actually matters.
 */
export async function getCommitDiff(
  repo: RepoRef,
  sha: string,
  { maxCharsPerFile = 6000 } = {},
): Promise<string | null> {
  try {
    const data = await gh<{
      files?: Array<{ filename: string; patch?: string; status: string }>;
    }>(repo, `/repos/${repo.owner}/${repo.name}/commits/${sha}`);

    const parts = (data.files ?? [])
      .filter((f) => f.patch)
      .map(
        (f) =>
          `--- ${f.filename} (${f.status}) ---\n${f.patch!.slice(0, maxCharsPerFile)}`,
      );

    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch {
    return null;
  }
}

/** Raw file contents. Returns null rather than throwing for missing files. */
export async function getFile(
  repo: RepoRef,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const data = await gh<{ content?: string; encoding?: string }>(
      repo,
      `/repos/${repo.owner}/${repo.name}/contents/${encodeURI(path)}`,
      { ref },
    );
    if (!data.content) return null;
    return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

/** Accepts a URL, an owner/name pair, or a git remote. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  const cleaned = input.trim().replace(/\.git$/, "");
  const url = cleaned.match(/github\.com[/:]([^/]+)\/([^/?#]+)/);
  if (url) return { owner: url[1], name: url[2] };
  const pair = cleaned.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (pair) return { owner: pair[1], name: pair[2] };
  return null;
}
