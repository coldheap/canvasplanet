/**
 * The moderation queue for user-submitted area reports (ROADMAP.md §3.1).
 *
 * Anyone can flag a bbox from the map; this is where a mod triages it.
 * Thumbnails are rendered live server-side (never stored) so a report
 * reviewed hours later shows the area's current state, not a stale
 * snapshot — and "suspects" are whoever painted there most in the last 24h,
 * so Revert and Ban are both one click from the report itself rather than a
 * trip through the forensic inspector.
 */

import { useEffect, useState } from "react";
import { Ban, Check, Flag, MapPin, RotateCcw } from "lucide-react";
import { api, type AreaReport } from "../../api.js";
import type { MapHandle } from "../MapCanvas.js";

type Status = "open" | "dismissed" | "reverted" | "all";

export function ReportsTab({ handle }: { handle: MapHandle | null }) {
  const [status, setStatus] = useState<Status>("open");
  const [rows, setRows] = useState<AreaReport[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load(): void {
    setRows(null);
    api.admin
      .reports(status)
      .then(setRows)
      .catch(() => setRows([]));
  }

  useEffect(load, [status]);

  async function resolve(id: number, action: "dismiss" | "revert"): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await api.admin.resolveReport(id, action);
      if (action === "revert") handle?.refreshTiles();
      load();
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      setError(body?.error ?? "That action failed.");
    } finally {
      setBusy(null);
    }
  }

  async function ban(sessionId: number): Promise<void> {
    setBusy(sessionId);
    setError(null);
    try {
      await api.admin.ban({ sessionId, hours: 24, reason: "area report" });
    } catch {
      setError("Could not ban that session.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
        <option value="open">Open</option>
        <option value="dismissed">Dismissed</option>
        <option value="reverted">Reverted</option>
        <option value="all">All</option>
      </select>

      <h3 className="wc-admin-sub">
        <Flag size={14} /> Area reports
      </h3>

      {error && <p className="wc-error">{error}</p>}

      {!rows ? (
        <p className="wc-hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="wc-hint">Nothing {status === "all" ? "reported" : status} yet.</p>
      ) : (
        <ol className="wc-report-list">
          {rows.map((r) => (
            <li key={r.id} className="wc-report-row">
              <img
                className="wc-report-thumb wc-pixelated"
                src={`/api/admin/reports/${r.id}/thumb.png`}
                alt=""
                width={64}
                height={64}
              />
              <div className="wc-report-body">
                <div className="wc-audit-head">
                  <code>
                    {r.x0},{r.y0} → {r.x1},{r.y1}
                  </code>
                  <em className="wc-hint">{new Date(r.created_at).toLocaleString()}</em>
                </div>
                {r.reason && <p className="wc-report-reason">"{r.reason}"</p>}

                {r.suspects.length > 0 && (
                  <div className="wc-report-suspects">
                    {r.suspects.map((s) => (
                      <span key={s.sessionId} className="wc-suspect">
                        session {s.sessionId} · {s.paints}px
                        {r.status === "open" && (
                          <button
                            className="wc-mini"
                            title="Ban this session 24h"
                            disabled={busy !== null}
                            onClick={() => void ban(s.sessionId)}
                          >
                            <Ban size={12} />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                <div className="wc-actions">
                  <button
                    className="wc-btn"
                    onClick={() => handle?.flyTo(Math.round((r.x0 + r.x1) / 2), Math.round((r.y0 + r.y1) / 2), 15)}
                  >
                    <MapPin size={14} /> View
                  </button>
                  {r.status === "open" ? (
                    <>
                      <button
                        className="wc-danger"
                        disabled={busy !== null}
                        onClick={() => void resolve(r.id, "revert")}
                      >
                        <RotateCcw size={14} /> Revert
                      </button>
                      <button className="wc-btn" disabled={busy !== null} onClick={() => void resolve(r.id, "dismiss")}>
                        <Check size={14} /> Dismiss
                      </button>
                    </>
                  ) : (
                    <span className="wc-hint">
                      {r.status} {r.resolved_by && `by ${r.resolved_by}`}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
