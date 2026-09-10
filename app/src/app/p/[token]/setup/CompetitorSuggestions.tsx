"use client";

import { useEffect, useState } from "react";

type Suggestion = {
  name: string;
  kind: "established" | "emerging";
  because: string;
  url: string;
  foundAt: string;
};

/**
 * Competitors the product found, waiting for someone to rule on them.
 *
 * Nothing here is in use yet. Accepting is what puts a name on the list the
 * market research actually spends its search budget on, which is why it takes
 * a click rather than happening quietly — a wrong competitor doesn't fail
 * loudly, it files a month of irrelevant research beside real findings.
 *
 * Dismissed names are remembered, so the same company isn't offered again
 * every time this runs.
 */
export default function CompetitorSuggestions({ token }: { token: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/competitors?t=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        if (live) setSuggestions(d.suggestions ?? []);
      })
      .catch(() => {
        if (live) setSuggestions([]);
      });
    return () => {
      live = false;
    };
  }, [token]);

  const decide = async (name: string, accept: boolean) => {
    setBusy(true);
    try {
      const r = await fetch("/api/competitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name, accept }),
      });
      const d = await r.json();
      setSuggestions(d.suggestions ?? []);
      setNote(
        accept
          ? `${name} added — the next market search will include it.`
          : `${name} dismissed, and won't be suggested again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const lookAgain = async () => {
    setBusy(true);
    setNote("Searching. New names appear here when it finishes.");
    try {
      await fetch("/api/competitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, rediscover: true }),
      });
    } finally {
      setBusy(false);
    }
  };

  if (suggestions === null) return null;

  return (
    <div style={{ marginTop: 12 }}>
      {suggestions.length > 0 && (
        <>
          <p className="small" style={{ marginBottom: 8 }}>
            <strong>Found {suggestions.length} you haven&apos;t named.</strong> Nothing is
            researched until you accept it.
          </p>
          {suggestions.map((s) => (
            <div key={s.name} className="ev-block" style={{ marginBottom: 8 }}>
              <div className="ev-kind">
                {s.kind === "emerging" ? "recent entrant" : "established"}
              </div>
              <div className="ev-body">
                <div className="candidate-msg">{s.name}</div>
                <div className="small" style={{ marginTop: 4 }}>
                  {s.because}
                </div>
                <div className="small" style={{ marginTop: 6 }}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    source
                  </a>
                  <span className="muted"> · </span>
                  <button
                    className="linkish"
                    disabled={busy}
                    onClick={() => void decide(s.name, true)}
                  >
                    add
                  </button>
                  <span className="muted"> · </span>
                  <button
                    className="linkish"
                    disabled={busy}
                    onClick={() => void decide(s.name, false)}
                  >
                    not a competitor
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      <p className="small muted">
        {suggestions.length === 0 &&
          "Nobody new found yet. Worth running again in a month — the competitor " +
            "worth knowing about is usually the one that didn't exist when you " +
            "filled this in. "}
        <button className="linkish" disabled={busy} onClick={() => void lookAgain()}>
          {busy ? "working…" : "look for competitors"}
        </button>
        {" — needs an Anthropic key, and each run costs a few searches."}
      </p>

      {note && (
        <p className="small" style={{ marginTop: 6 }}>
          {note}
        </p>
      )}
    </div>
  );
}
