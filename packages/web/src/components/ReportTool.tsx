/**
 * "Report this area" — the input side of moderation that ROADMAP.md §3.1
 * called out as the one missing piece: the tooling to act on vandalism
 * (revert, ban) already existed, but the only way to hear about it was a
 * moderator noticing on their own. This is how anyone else can flag one.
 */

import { useState } from "react";
import { Check, Flag, Square, X } from "lucide-react";
import { api } from "../api.js";
import { pickBbox } from "../canvas/pickBbox.js";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";

export function ReportTool({ handle }: { handle: MapHandle | null }) {
  const setPanel = useStore((s) => s.setPanel);
  const [bbox, setBbox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function clear(): void {
    handle?.bbox.clear();
    setBbox(null);
    setReason("");
    setSent(false);
    setError(null);
  }

  async function submit(): Promise<void> {
    if (!bbox) return;
    setBusy(true);
    setError(null);
    try {
      await api.reportArea({ ...bbox, reason: reason.trim() || undefined });
      setSent(true);
      handle?.bbox.clear();
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "Could not send that report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wc-report-tool wc-card">
      <button className="wc-modal-close" aria-label="Close" onClick={() => setPanel("none")}>
        <X size={16} />
      </button>
      <h2 className="wc-panel-title">
        <Flag size={16} />
        Report an area
      </h2>

      {sent ? (
        <>
          <p className="wc-ok">
            <Check size={14} /> Report sent. A moderator will take a look.
          </p>
          <button className="wc-btn" onClick={clear}>
            Report another area
          </button>
        </>
      ) : (
        <>
          <p className="wc-hint">
            Draw a box around something that shouldn't be there — hate symbols, harassment,
            spam. A moderator reviews every report before anything changes.
          </p>

          <div className="wc-actions">
            <button
              className="wc-btn"
              disabled={!handle}
              onClick={async () => {
                const b = await pickBbox(handle);
                if (b) setBbox(b);
              }}
            >
              <Square size={15} />
              {bbox ? "Redraw area" : "Draw area on map"}
            </button>
            {bbox && (
              <button className="wc-btn" onClick={clear}>
                Clear
              </button>
            )}
          </div>

          {bbox && (
            <p className="wc-hint">
              <code>
                {bbox.x0},{bbox.y0} → {bbox.x1},{bbox.y1}
              </code>
            </p>
          )}

          <textarea
            placeholder="What's wrong here? (optional)"
            maxLength={500}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />

          <div className="wc-actions">
            <button className="wc-btn wc-btn-primary" disabled={!bbox || busy} onClick={() => void submit()}>
              <Flag size={15} />
              Send report
            </button>
          </div>

          {error && <p className="wc-error">{error}</p>}
        </>
      )}
    </div>
  );
}
