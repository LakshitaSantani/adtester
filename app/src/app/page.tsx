"use client";

import { useState } from "react";

type Created = {
  id: string;
  name: string;
  installKey: string;
  viewToken: string;
};

export default function Home() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`server returned ${response.status}`);
      setProject((await response.json()) as Created);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not create the project: ${e.message}`
          : "Could not create the project.",
      );
    } finally {
      setBusy(false);
    }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          simply<span>why</span>
        </div>
        <div className="muted small mono">phase 1 — record and watch</div>
      </header>

      {!project && (
        <>
          <h1>Create a project</h1>
          <p className="lede">
            You&apos;ll get a one-line snippet to paste into a site, and a private link where
            the recordings show up.
          </p>

          <div className="card">
            <label htmlFor="name">Project name</label>
            <input
              id="name"
              type="text"
              value={name}
              placeholder="My app"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void create();
              }}
            />
            <div style={{ marginTop: 16 }}>
              <button onClick={() => void create()} disabled={busy}>
                {busy ? "Creating…" : "Create project"}
              </button>
            </div>
            {error && (
              <div className="note warn" style={{ marginBottom: 0 }}>
                {error}
              </div>
            )}
          </div>
        </>
      )}

      {project && (
        <>
          <h1>{project.name} is ready</h1>
          <p className="lede">
            Paste this before <code>&lt;/body&gt;</code> on any page you want to record.
          </p>

          <pre className="snippet">{`<script src="${origin}/rec.js"
        data-swy-key="${project.installKey}"
        data-swy-release="YOUR_GIT_SHA" async></script>`}</pre>

          <div className="note">
            <b>Set data-swy-release from your build.</b> It&apos;s the field that links a
            recording to the code that was running — one line now, and it can never be added
            to sessions recorded without it.
          </div>

          <h2>Your private dashboard</h2>
          <p className="lede">
            Bookmark this. Anyone with the link can watch the recordings, so treat it like a
            password until real accounts land.
          </p>
          <pre className="snippet">{`${origin}/p/${project.viewToken}`}</pre>

          <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
            <a href={`/p/${project.viewToken}`}>
              <button>Open the dashboard</button>
            </a>
            <a href="/demo.html" target="_blank" rel="noreferrer">
              <button className="ghost">Open the test page</button>
            </a>
          </div>

          <div className="note" style={{ marginTop: 28 }}>
            <b>To try it right now:</b> open the test page, click around, break something on
            purpose, then come back to the dashboard. The recorder sends every 10 seconds and
            flushes immediately when you switch tabs.
          </div>
        </>
      )}
    </div>
  );
}
