"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Draft, Profile } from "@brain/profile";
import CompetitorSuggestions from "./CompetitorSuggestions";

/**
 * The questions worth asking, and nothing else.
 *
 * Everything here is either impossible to infer (how you make money, who you
 * compete with, whether you roll out gradually) or gets inferred wrongly often
 * enough that a wrong guess would quietly distort every ranking afterwards.
 *
 * Anything that CAN be derived reliably is shown as a draft to correct rather
 * than a blank to fill. Asking someone to retype what we already know from
 * their repository is how a setup form gets abandoned.
 */
export default function ProfileForm({
  token,
  draft,
  existing,
}: {
  token: string;
  draft: Draft;
  existing: Profile | null;
}) {
  const router = useRouter();

  const [whatWeDo, setWhatWeDo] = useState(existing?.whatWeDo ?? "");
  const [customers, setCustomers] = useState(existing?.customers ?? "");
  const [revenueModel, setRevenueModel] = useState(existing?.revenueModel ?? "");
  const [rollout, setRollout] = useState(existing?.rollout ?? "");
  const [competitors, setCompetitors] = useState((existing?.competitors ?? []).join(", "));
  const [seasonality, setSeasonality] = useState(existing?.seasonality ?? "");

  // Pre-ticked from the draft on a first run, so the common case is one click.
  const [paths, setPaths] = useState<Set<string>>(
    new Set(
      existing?.criticalPaths?.length
        ? existing.criticalPaths
        : draft.suggestedPaths.map((p) => p.path),
    ),
  );

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const toggle = (path: string) => {
    const next = new Set(paths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setPaths(next);
  };

  async function save() {
    setBusy(true);
    try {
      await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          whatWeDo,
          customers: customers || null,
          revenueModel: revenueModel || null,
          criticalPaths: [...paths],
          rollout: rollout || null,
          competitors: competitors
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          seasonality: seasonality || null,
        }),
      });
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const suggested = new Map(draft.suggestedPaths.map((p) => [p.path, p.because]));

  return (
    <div className="setup-body" style={{ paddingLeft: 0 }}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Without this, a rage click on your help page and a broken checkout look identical —
        same shape, same signature — and whichever affected more people wins. These answers
        are what turn a list of anomalies into a ranked one.
      </p>

      <label htmlFor="what">What does the product do?</label>
      <input
        id="what"
        type="text"
        value={whatWeDo}
        placeholder="One line. e.g. subscription box for specialty coffee"
        onChange={(e) => setWhatWeDo(e.target.value)}
      />
      {draft.suggestedDescription && !whatWeDo && (
        <p className="small muted" style={{ marginTop: 6 }}>
          From your documents: &ldquo;{draft.suggestedDescription.slice(0, 140)}…&rdquo;
        </p>
      )}

      <div className="profile-row">
        <div>
          <label htmlFor="customers">Who buys it?</label>
          <select id="customers" value={customers} onChange={(e) => setCustomers(e.target.value)}>
            <option value="">—</option>
            <option value="b2c">People</option>
            <option value="b2b">Businesses</option>
            <option value="both">Both</option>
          </select>
        </div>
        <div>
          <label htmlFor="revenue">How do you make money?</label>
          <select
            id="revenue"
            value={revenueModel}
            onChange={(e) => setRevenueModel(e.target.value)}
          >
            <option value="">—</option>
            <option value="subscription">Subscription</option>
            <option value="transaction">Per transaction</option>
            <option value="one_off">One-off purchase</option>
            <option value="ads">Advertising</option>
            <option value="other">Something else</option>
          </select>
        </div>
      </div>

      <label style={{ marginTop: 18 }}>Which pages actually matter?</label>
      <p className="small muted" style={{ marginTop: 0 }}>
        {draft.suggestedPaths.length > 0
          ? "We've ticked the ones that look important from your routes. Correct them — we can't tell whether /billing is where customers pay or an admin screen nobody uses."
          : "No routes indexed yet. Connect a repository and come back, or leave this and rank by volume alone."}
      </p>

      {draft.allPaths.length > 0 && (
        <div className="path-picker">
          {draft.allPaths.map((path) => (
            <label key={path} className={`path-option ${paths.has(path) ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={paths.has(path)}
                onChange={() => toggle(path)}
              />
              <span className="mono">{path}</span>
              {suggested.has(path) && (
                <span className="small muted"> — {suggested.get(path)}</span>
              )}
            </label>
          ))}
        </div>
      )}

      <label htmlFor="rollout" style={{ marginTop: 18 }}>
        When you deploy, does everyone get it at once?
      </label>
      <select id="rollout" value={rollout} onChange={(e) => setRollout(e.target.value)}>
        <option value="">—</option>
        <option value="all_at_once">Everyone at once</option>
        <option value="gradual">Gradually, some users first</option>
        <option value="unsure">Not sure</option>
      </select>
      <p className="small muted">
        This decides whether we can ever prove a cause rather than argue for one. Rolling out
        to some users first leaves a group still on the old build to compare against.
      </p>

      <label htmlFor="competitors" style={{ marginTop: 18 }}>
        Main competitors <span className="muted">— comma separated, or leave it to us</span>
      </label>
      <input
        id="competitors"
        type="text"
        value={competitors}
        placeholder="Northwind Pay, Harbor Checkout"
        onChange={(e) => setCompetitors(e.target.value)}
      />
      <p className="small muted">
        Searched for pricing changes, launches and funding around the time each problem
        started. Never scored — a competitor&apos;s price cut can&apos;t be tested the way
        a commit can, so it stays context you weigh.
      </p>
      <CompetitorSuggestions token={token} />

      <label htmlFor="seasonality" style={{ marginTop: 18 }}>
        Anything seasonal we&apos;d misread? <span className="muted">— optional</span>
      </label>
      <input
        id="seasonality"
        type="text"
        value={seasonality}
        placeholder="e.g. quiet every August, spike in the week before Christmas"
        onChange={(e) => setSeasonality(e.target.value)}
      />
      <p className="small muted">
        Stops a known annual dip being reported as something broken.
      </p>

      <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center" }}>
        <button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : existing?.confirmedAt ? "Update" : "Save"}
        </button>
        {saved && <span className="small muted">Saved.</span>}
      </div>
    </div>
  );
}
