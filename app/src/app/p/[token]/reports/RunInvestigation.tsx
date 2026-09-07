"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RunInvestigation({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `server returned ${response.status}`);
      setMessage("Looking for symptoms — this page will refresh in a moment.");
      setTimeout(() => router.refresh(), 4000);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ margin: "0 0 24px" }}>
      <button onClick={() => void run()} disabled={busy}>
        {busy ? "Starting…" : "Look for problems now"}
      </button>
      {message && (
        <span className="small muted" style={{ marginLeft: 12 }}>
          {message}
        </span>
      )}
    </div>
  );
}
