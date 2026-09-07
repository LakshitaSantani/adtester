"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ConnectRepo({
  token,
  existing,
}: {
  token: string;
  existing: { owner: string; name: string } | null;
}) {
  const router = useRouter();
  const [repo, setRepo] = useState(existing ? `${existing.owner}/${existing.name}` : "");
  const [accessToken, setAccessToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(method: "POST" | "PUT") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/repos", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, repo, accessToken: accessToken || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `server returned ${response.status}`);
      setAccessToken("");
      // The sync runs in the background; refresh to start showing progress.
      setTimeout(() => router.refresh(), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <label htmlFor="repo">Repository</label>
      <input
        id="repo"
        type="text"
        value={repo}
        placeholder="owner/name, or a GitHub URL"
        onChange={(e) => setRepo(e.target.value)}
      />

      <div style={{ marginTop: 16 }}>
        <label htmlFor="pat">
          Access token {existing && <span className="muted">— only to change it</span>}
        </label>
        <input
          id="pat"
          type="text"
          value={accessToken}
          placeholder="ghp_… (leave blank for a public repo)"
          onChange={(e) => setAccessToken(e.target.value)}
          autoComplete="off"
        />
        <p className="small muted" style={{ marginTop: 8 }}>
          A fine-grained token with <strong>Contents: read</strong> on this repository is
          enough. Nothing is written back, ever.
        </p>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
        <button onClick={() => void submit("POST")} disabled={busy || !repo.trim()}>
          {busy ? "Checking…" : existing ? "Update" : "Connect"}
        </button>
        {existing && (
          <button className="ghost" onClick={() => void submit("PUT")} disabled={busy}>
            Sync now
          </button>
        )}
      </div>

      {error && (
        <div className="note warn" style={{ marginBottom: 0 }}>
          {error}
        </div>
      )}
    </div>
  );
}
