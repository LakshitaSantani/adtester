"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type SetupState = {
  posthog: { connected: boolean; host: string | null; projectId: string | null };
  repo: { connected: boolean; label: string | null };
  anthropic: { connected: boolean; hint: string | null };
  documents: { count: number; titles: string[] };
  sessions: number;
  installSnippet: string;
};

type Errors = Record<string, string>;

export default function SetupForm({
  token,
  state,
}: {
  token: string;
  state: SetupState;
}) {
  const router = useRouter();

  const [host, setHost] = useState(state.posthog.host ?? "https://us.i.posthog.com");
  const [phProject, setPhProject] = useState(state.posthog.projectId ?? "");
  const [phKey, setPhKey] = useState("");
  const [repoUrl, setRepoUrl] = useState(state.repo.label ?? "");
  const [repoToken, setRepoToken] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  // Off by default. The most expensive key is the one least worth leaving at
  // rest, and a manual run can just as easily carry it.
  const [storeKey, setStoreKey] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [demoNote, setDemoNote] = useState<string | null>(null);

  async function save(run: boolean) {
    setBusy(run ? "running" : "saving");
    setErrors({});
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          posthog: phKey ? { host, projectId: phProject, apiKey: phKey } : null,
          repo: repoUrl ? { url: repoUrl, accessToken: repoToken || undefined } : null,
          anthropicKey: anthropicKey || null,
          storeAnthropicKey: storeKey,
          run,
        }),
      });
      const data = (await response.json()) as { errors?: Errors };
      setErrors(data.errors ?? {});
      // Keys are never sent back, so clear the fields rather than leave
      // something that looks saved but isn't.
      setPhKey("");
      setRepoToken("");
      setAnthropicKey("");
      if (run && Object.keys(data.errors ?? {}).length === 0) {
        router.push(`/p/${token}/reports`);
        return;
      }
      router.refresh();
    } catch {
      setErrors({ general: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy("uploading");
    try {
      const form = new FormData();
      form.append("token", token);
      for (const file of Array.from(files)) form.append("files", file);
      const response = await fetch("/api/documents", { method: "POST", body: form });
      const data = (await response.json()) as {
        results?: Array<{ filename: string; title?: string; error?: string }>;
      };
      setUploaded((data.results ?? []).map((r) => r.error ? `${r.filename}: ${r.error}` : (r.title ?? r.filename)));
      router.refresh();
    } catch {
      setErrors({ documents: "Upload failed." });
    } finally {
      setBusy(null);
    }
  }

  async function loadDemo() {
    setBusy("demo");
    try {
      const response = await fetch("/api/dev/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await response.json()) as { investigations?: number; error?: string };
      if (data.error) {
        setDemoNote(data.error);
        return;
      }
      window.location.href = `/p/${token}/reports`;
    } catch {
      setDemoNote("Could not load the demo data.");
    } finally {
      setBusy(null);
    }
  }

  const ready =
    (state.posthog.connected || state.sessions > 0) && state.repo.connected;

  return (
    <>
      <Step
        n={1}
        title="Recordings"
        done={state.posthog.connected || state.sessions > 0}
        summary={
          state.posthog.connected
            ? `PostHog project ${state.posthog.projectId} connected`
            : state.sessions > 0
              ? `${state.sessions} sessions recorded`
              : "Not connected"
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          Import from PostHog if you already record there — months of real sessions,
          available immediately. Otherwise install the recorder and wait for traffic.
        </p>

        <label htmlFor="ph-host">PostHog host</label>
        <input id="ph-host" type="text" value={host} onChange={(e) => setHost(e.target.value)} />

        <label htmlFor="ph-project" style={{ marginTop: 12 }}>
          Project id <span className="muted">— the number in your PostHog URL</span>
        </label>
        <input
          id="ph-project"
          type="text"
          value={phProject}
          placeholder="12345"
          onChange={(e) => setPhProject(e.target.value)}
        />

        <label htmlFor="ph-key" style={{ marginTop: 12 }}>
          Personal API key <span className="muted">— starts with phx_</span>
        </label>
        <input
          id="ph-key"
          type="password"
          value={phKey}
          placeholder={state.posthog.connected ? "saved — paste to replace" : "phx_…"}
          autoComplete="off"
          onChange={(e) => setPhKey(e.target.value)}
        />
        <p className="small muted">
          Needs <code>session_recording:read</code> and <code>query:read</code>. This key can
          read every recording in the project, so use a test project if you have one.
        </p>
        {errors.posthog && <div className="note warn">{errors.posthog}</div>}

        <details style={{ marginTop: 14 }}>
          <summary className="small">Or install the recorder instead</summary>
          <pre className="snippet" style={{ marginTop: 10 }}>{state.installSnippet}</pre>
          <p className="small muted">
            Set <code>data-swy-release</code> from your build. It&apos;s the field that links
            a recording to the code that was running, and it can&apos;t be added later.
          </p>
        </details>
      </Step>

      <Step
        n={2}
        title="Code"
        done={state.repo.connected}
        summary={state.repo.connected ? state.repo.label! : "Not connected"}
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          One connection gives both the commit history and the codebase — the second is what
          lets a page&apos;s URL point at the files that serve it.
        </p>

        <label htmlFor="repo">Repository</label>
        <input
          id="repo"
          type="text"
          value={repoUrl}
          placeholder="owner/name, or a GitHub URL"
          onChange={(e) => setRepoUrl(e.target.value)}
        />

        <label htmlFor="repo-token" style={{ marginTop: 12 }}>
          Access token <span className="muted">— leave blank for a public repo</span>
        </label>
        <input
          id="repo-token"
          type="password"
          value={repoToken}
          placeholder={state.repo.connected ? "saved — paste to replace" : "github_pat_…"}
          autoComplete="off"
          onChange={(e) => setRepoToken(e.target.value)}
        />
        <p className="small muted">
          Read-only. <code>Contents: read</code> is enough; nothing is ever written back.
        </p>
        {errors.repo && <div className="note warn">{errors.repo}</div>}
      </Step>

      <Step
        n={3}
        title="Context"
        done={state.documents.count > 0}
        optional
        summary={
          state.documents.count > 0
            ? `${state.documents.count} documents`
            : "None yet — optional"
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          PRDs and meeting transcripts. This is what turns &quot;this commit broke it&quot;
          into &quot;and here&apos;s the decision that made it that way&quot;. Markdown, text,
          .vtt and .srt all work.
        </p>
        <input
          type="file"
          multiple
          accept=".md,.txt,.vtt,.srt,.markdown"
          onChange={(e) => void upload(e.target.files)}
        />
        {uploaded.length > 0 && (
          <p className="small" style={{ marginTop: 10 }}>
            Added: {uploaded.join(", ")}
          </p>
        )}
        {state.documents.titles.length > 0 && (
          <p className="small muted" style={{ marginTop: 8 }}>
            Already here: {state.documents.titles.join(", ")}
          </p>
        )}
        {errors.documents && <div className="note warn">{errors.documents}</div>}
      </Step>

      <Step
        n={4}
        title="Analysis"
        done={state.anthropic.connected}
        optional
        summary={
          state.anthropic.connected
            ? `Key saved (${state.anthropic.hint})`
            : "Not set — findings still work, explanations won't"
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          Used to read the diff and the recording and write the explanation and the fix.
          Without it you still get findings, evidence and confidence scores — just no prose
          and no patch.
        </p>
        <label htmlFor="anthropic">Anthropic API key</label>
        <input
          id="anthropic"
          type="password"
          value={anthropicKey}
          placeholder={state.anthropic.connected ? "saved — paste to replace" : "sk-ant-…"}
          autoComplete="off"
          onChange={(e) => setAnthropicKey(e.target.value)}
        />
        <label
          style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            marginTop: 12, textTransform: "none", letterSpacing: 0, fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={storeKey}
            onChange={(e) => setStoreKey(e.target.checked)}
            style={{ width: "auto", marginTop: 2 }}
          />
          <span>
            Save this key for future runs. Leave it off and it is used for this run only and
            never written down — safer, but you will paste it again next time.
          </span>
        </label>
        <p className="small muted">
          Worth creating a key with a spend limit for this. If it ever leaks, the damage is
          capped at whatever you set.
        </p>
        {errors.anthropic && <div className="note warn">{errors.anthropic}</div>}
      </Step>

      <div className="setup-actions">
        <button onClick={() => void save(true)} disabled={busy !== null || !ready}>
          {busy === "running" ? "Starting…" : "Run the analysis"}
        </button>
        <button className="ghost" onClick={() => void save(false)} disabled={busy !== null}>
          {busy === "saving" ? "Saving…" : "Save without running"}
        </button>
        {!ready && (
          <span className="small muted">
            Needs recordings and a repository before it can narrow anything.
          </span>
        )}
      </div>

      {errors.general && <div className="note warn">{errors.general}</div>}

      <div className="note">
        <b>Just want to see what it looks like?</b> This fills the dashboard with a
        made-up week — findings at three confidence levels, all three kinds of refusal, a
        suggested patch, and quotes from a PRD and a standup. Nothing here is worked out by
        the product; it is written by hand so the interface can be judged without connecting
        anything.
        <div style={{ marginTop: 12 }}>
          <button className="ghost" onClick={() => void loadDemo()} disabled={busy !== null}>
            {busy === "demo" ? "Loading…" : "Load demo data"}
          </button>
          {demoNote && <span className="small muted" style={{ marginLeft: 10 }}>{demoNote}</span>}
        </div>
      </div>

      <div className="note guard">
        <b>About the keys you just pasted.</b> They are stored in this
        install&apos;s own database in plain text, and anyone with this
        dashboard link can start work that uses them. That is honest for a
        prototype among people who know each other, and not good enough for
        anything wider — real accounts and encryption at rest are the next
        thing to build.
      </div>
    </>
  );
}

function Step({
  n,
  title,
  done,
  optional,
  summary,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  optional?: boolean;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`setup-step ${done ? "done" : ""}`}>
      <div className="setup-head">
        <span className="setup-n">{done ? "✓" : n}</span>
        <div>
          <h2 style={{ margin: 0 }}>
            {title}
            {optional && <span className="muted small"> · optional</span>}
          </h2>
          <div className="small muted">{summary}</div>
        </div>
      </div>
      <div className="setup-body">{children}</div>
    </section>
  );
}
