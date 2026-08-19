import { useEffect } from "react";
import { History, Radio, X } from "lucide-react";
import {
  HISTORY_BUCKET_MS,
  HISTORY_MAX_AGE_MS,
  Z_PIXEL,
} from "@canvasplanet/shared";
import { normalizeHistoryAt } from "../history.js";
import { useStore } from "../store.js";
import "./HistoryMode.css";

export function HistoryMode({ zoom }: { zoom: number }) {
  const historyAt = useStore((s) => s.historyAt);
  const setHistoryAt = useStore((s) => s.setHistoryAt);

  useEffect(() => {
    document.documentElement.classList.toggle("cp-history-mode", historyAt !== null);
    return () => document.documentElement.classList.remove("cp-history-mode");
  }, [historyAt]);

  if (historyAt === null) return null;

  const now = Date.now();
  const min = normalizeHistoryAt(now - HISTORY_MAX_AGE_MS, now);
  const max = normalizeHistoryAt(now, now);
  const at = Math.max(min, Math.min(historyAt, max));

  return (
    <section className="cp-history-bar cp-card" aria-label="Canvas history mode">
      <div className="cp-history-heading">
        <History size={17} />
        <strong>History</strong>
        <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>
        <button
          className="cp-history-close"
          aria-label="Return to live canvas"
          title="Return to live canvas (H or Esc)"
          onClick={() => setHistoryAt(null)}
        >
          <X size={17} />
        </button>
      </div>

      <input
        className="cp-history-slider"
        type="range"
        min={min}
        max={max}
        step={HISTORY_BUCKET_MS}
        value={at}
        aria-label="Historical canvas time"
        onChange={(event) => setHistoryAt(normalizeHistoryAt(Number(event.target.value), now))}
      />

      <div className="cp-history-fields">
        <span>{zoom < Z_PIXEL ? "Zoom in to view past pixels" : "Read-only past canvas"}</span>
        <input
          type="datetime-local"
          min={toLocalInput(min)}
          max={toLocalInput(max)}
          step={HISTORY_BUCKET_MS / 1000}
          value={toLocalInput(at)}
          aria-label="Historical date and time"
          onChange={(event) => {
            const parsed = new Date(event.target.value).getTime();
            if (Number.isFinite(parsed)) setHistoryAt(normalizeHistoryAt(parsed, now));
          }}
        />
        <button className="cp-btn cp-history-live" onClick={() => setHistoryAt(null)}>
          <Radio size={14} />
          Live
        </button>
      </div>
    </section>
  );
}

/** datetime-local deliberately has no timezone suffix; offset the ISO value
 *  so its fields represent the viewer's local wall-clock time. */
function toLocalInput(at: number): string {
  const date = new Date(at);
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
