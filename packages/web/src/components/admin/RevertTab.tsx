/**
 * The 3am tool.
 *
 * Three selectors — area, time, session — all reducing to the same server
 * call. Preview always runs before Apply: a revert writes its own batch id so
 * it can itself be reverted, but an unexpected 40,000-pixel blast radius
 * still ruins someone's afternoon.
 */

import { useState } from "react";
import { RotateCcw, Square } from "lucide-react";
import { api, type RevertResult, type RevertSelector } from "../../api.js";
import { pickBbox } from "../../canvas/pickBbox.js";
import type { MapHandle } from "../MapCanvas.js";

export function RevertTab({ handle, isAdmin }: { handle: MapHandle | null; isAdmin: boolean }) {
  const [minutes, setMinutes] = useState(30);
  const [useTime, setUseTime] = useState(true);
  const [bbox, setBbox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [result, setResult] = useState<RevertResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mods are capped at an hour of history; the server enforces this too.
  const maxMinutes = isAdmin ? 1440 : 60;

  function selector(preview: boolean): RevertSelector {
    const sel: RevertSelector = { preview };
    if (useTime) sel.since = Date.now() - minutes * 60_000;
    if (bbox) sel.bbox = bbox;
    if (sessionId.trim()) sel.sessionId = Number(sessionId.trim());
    return sel;
  }

  const hasSelector = useTime || bbox !== null || sessionId.trim() !== "";

  async function run(preview: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api.admin.revert(selector(preview));
      setResult(r);
      if (!preview) {
        handle?.bbox.clear();
        handle?.refreshTiles();
      }
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "The revert failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <p className="cp-hint">
        Selectors combine. With more than one set, only pixels matching all of
        them are reverted.
      </p>

      <label className="cp-toggle">
        <input type="checkbox" checked={useTime} onChange={(e) => setUseTime(e.target.checked)} />
        Painted in the last
        <input
          type="number"
          min={1}
          max={maxMinutes}
          value={minutes}
          disabled={!useTime}
          onChange={(e) => setMinutes(Math.min(maxMinutes, Math.max(1, +e.target.value)))}
        />
        minutes
      </label>
      {!isAdmin && <p className="cp-hint">Mods can revert at most one hour of history.</p>}

      <div className="cp-actions">
        <button
          className="cp-btn"
          disabled={!handle}
          onClick={async () => {
            const b = await pickBbox(handle);
            if (b) {
              setBbox(b);
              setResult(null);
            }
          }}
        >
          <Square size={15} />
          {bbox ? "Redraw area" : "Draw area on map"}
        </button>
        {bbox && (
          <button
            className="cp-btn"
            onClick={() => {
              handle?.bbox.clear();
              setBbox(null);
            }}
          >
            Clear area
          </button>
        )}
      </div>
      {bbox && (
        <p className="cp-hint">
          <code>
            {bbox.x0},{bbox.y0} → {bbox.x1},{bbox.y1}
          </code>{" "}
          · {((bbox.x1 - bbox.x0 + 1) * (bbox.y1 - bbox.y0 + 1)).toLocaleString()} pixels
        </p>
      )}

      <input
        placeholder="Session id (from the pixel inspector)"
        value={sessionId}
        inputMode="numeric"
        onChange={(e) => setSessionId(e.target.value.replace(/[^0-9]/g, ""))}
      />

      <div className="cp-actions">
        <button className="cp-btn" disabled={busy || !hasSelector} onClick={() => void run(true)}>
          Preview
        </button>
        <button
          className="cp-danger"
          disabled={busy || !result?.preview || result.affected === 0}
          onClick={() => void run(false)}
        >
          <RotateCcw size={15} />
          Apply
        </button>
      </div>

      {error && <p className="cp-error">{error}</p>}
      {result && (
        <p className={result.affected > 5000 ? "cp-admin-alert" : undefined}>
          <strong>{result.affected.toLocaleString()}</strong> pixels{" "}
          {result.preview ? "would be reverted" : "reverted"}
          {result.batchId && <em className="cp-hint"> · batch {result.batchId.slice(0, 8)}</em>}
        </p>
      )}
    </section>
  );
}
