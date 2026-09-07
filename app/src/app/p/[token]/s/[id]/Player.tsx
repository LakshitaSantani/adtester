"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Replayer as ReplayerType } from "rrweb";

type Props = { sessionId: string; token: string };

const SPEEDS = [1, 2, 4, 8] as const;

/**
 * Drives rrweb's Replayer directly rather than using rrweb-player.
 *
 * rrweb-player's newest release is three years older than rrweb itself and
 * its controls no longer drive the current Replayer. Owning the controls is
 * also what phase 4 needs: an evidence link has to be able to open a
 * recording at a specific millisecond, and the timeline eventually has to
 * show markers where errors and rage clicks happened.
 */
export default function Player({ sessionId, token }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const replayer = useRef<ReplayerType | null>(null);
  const raf = useRef<number | null>(null);
  const built = useRef(false);

  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">(
    "loading",
  );
  const [detail, setDetail] = useState("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [now, setNow] = useState(0);
  const [total, setTotal] = useState(0);

  const tick = useCallback(() => {
    const r = replayer.current;
    if (!r) return;
    setNow(Math.min(r.getCurrentTime(), total || Number.MAX_SAFE_INTEGER));
    raf.current = requestAnimationFrame(tick);
  }, [total]);

  useEffect(() => {
    // React mounts effects twice in development; without this the replayer
    // is constructed twice into the same node.
    if (built.current) return;
    built.current = true;

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `/api/events/${sessionId}?t=${encodeURIComponent(token)}`,
        );
        if (!response.ok) {
          setStatus(response.status === 404 ? "empty" : "error");
          setDetail(`server returned ${response.status}`);
          return;
        }

        const events = (await response.text())
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        // A replay needs at least the meta event, a full snapshot, and
        // something to apply on top of them.
        if (events.length < 3) {
          setStatus("empty");
          return;
        }
        if (cancelled || !stage.current) return;

        const [{ Replayer }] = await Promise.all([
          import("rrweb"),
          import("rrweb/dist/style.css"),
        ]);
        if (cancelled || !stage.current) return;

        const r = new Replayer(events, {
          root: stage.current,
          speed: 1,
          skipInactive: true,
          mouseTail: { strokeStyle: "#0b5d6b", lineWidth: 3 },
        });
        replayer.current = r;

        const meta = r.getMetaData();
        setTotal(meta.totalTime);
        setStatus("ready");

        // Handy when debugging a replay that won't advance, and harmless:
        // the events are already in this page.
        (window as unknown as { __replayer?: unknown }).__replayer = r;

        r.on("finish", () => {
          setPlaying(false);
          if (raf.current) cancelAnimationFrame(raf.current);
          raf.current = null;
        });

        // Scale the replay down to fit the column. The recording is played
        // at the size it was made, so a 1440px session in a 900px column
        // needs scaling rather than cropping.
        const scaleToFit = () => {
          const wrapper = stage.current?.querySelector<HTMLElement>(
            ".replayer-wrapper",
          );
          const iframe = stage.current?.querySelector("iframe");
          if (!wrapper || !iframe || !stage.current) return;
          const recorded = iframe.clientWidth || 1;
          const available = stage.current.clientWidth || recorded;
          const scale = Math.min(1, available / recorded);
          wrapper.style.transform = `scale(${scale})`;
          wrapper.style.transformOrigin = "top left";
          stage.current.style.height = `${iframe.clientHeight * scale}px`;
        };
        scaleToFit();
        window.addEventListener("resize", scaleToFit);
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setDetail(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      cancelled = true;
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [sessionId, token]);

  function toggle() {
    const r = replayer.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPlaying(false);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
    } else {
      // play() from the current position; resume() would ignore a seek.
      r.play(now >= total ? 0 : now);
      setPlaying(true);
      raf.current = requestAnimationFrame(tick);
    }
  }

  function seek(ms: number) {
    const r = replayer.current;
    if (!r) return;
    setNow(ms);
    if (playing) r.play(ms);
    else r.pause(ms);
  }

  function changeSpeed(next: number) {
    setSpeed(next);
    replayer.current?.setConfig({ speed: next });
  }

  return (
    <>
      {status === "loading" && <div className="card empty">Loading the recording…</div>}
      {status === "empty" && (
        <div className="card empty">
          <strong>Nothing to replay yet</strong>
          The recorder sends every 10 seconds. If this session just started, give it a
          moment and refresh.
        </div>
      )}
      {status === "error" && (
        <div className="card empty">
          <strong>Could not load this recording</strong>
          <span className="mono small">{detail}</span>
        </div>
      )}

      <div style={{ display: status === "ready" ? "block" : "none" }}>
        <div className="stage" ref={stage} />

        <div className="controls">
          <button onClick={toggle} style={{ minWidth: 78 }}>
            {playing ? "Pause" : "Play"}
          </button>

          <input
            type="range"
            min={0}
            max={total || 1}
            value={now}
            step={100}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Seek"
          />

          <span className="mono small time">
            {fmt(now)} / {fmt(total)}
          </span>

          <span className="speeds">
            {SPEEDS.map((s) => (
              <button
                key={s}
                className={`ghost speed ${speed === s ? "on" : ""}`}
                onClick={() => changeSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </span>
        </div>
      </div>
    </>
  );
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
