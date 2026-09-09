"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Was this right?
 *
 * Asked plainly, because a vague impression is worth nothing and a recorded
 * verdict against a prediction made beforehand is worth a great deal. The
 * note matters as much as the yes or no — "right commit, wrong reason" is a
 * different failure from "completely wrong" and they need different fixes.
 */
export default function Verdict({
  token,
  investigationId,
  existing,
}: {
  token: string;
  investigationId: string;
  existing: { wasCorrect: boolean; note: string | null } | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState(existing?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function record(wasCorrect: boolean) {
    setBusy(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, investigationId, wasCorrect, note }),
      });
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="verdict">
      <div className="verdict-head">
        <strong>Was this right?</strong>
        {existing && (
          <span className={`pill ${existing.wasCorrect ? "verdict-yes" : "verdict-no"}`}>
            recorded: {existing.wasCorrect ? "correct" : "wrong"}
          </span>
        )}
      </div>
      <p className="small muted">
        This is the only way to find out whether a confidence score means anything. The note
        matters as much as the answer — &quot;right commit, wrong reason&quot; is a different
        failure from &quot;completely wrong&quot;.
      </p>
      <input
        type="text"
        value={note}
        placeholder="What did it get right or wrong? (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
        <button onClick={() => void record(true)} disabled={busy}>
          Correct
        </button>
        <button className="ghost" onClick={() => void record(false)} disabled={busy}>
          Wrong
        </button>
        {saved && <span className="small muted">Recorded.</span>}
      </div>
    </div>
  );
}
