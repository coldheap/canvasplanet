/**
 * Corruption event visibility (ROADMAP.md Phase 7) — a mod-visible status
 * view plus one escape hatch, same shape as ControlTab's freeze toggle. The
 * event itself is fully autonomous (events/engine.ts); this tab exists so a
 * mod can see what's happening and force-end a runaway or mistimed one
 * without waiting out the timer.
 */

import { useEffect, useState } from "react";
import { Biohazard, Square } from "lucide-react";
import { api, type EventHistoryRow } from "../../api.js";
import type { EventStateDTO } from "@worldcanvas/shared";

export function EventsTab() {
  const [current, setCurrent] = useState<EventStateDTO | null>(null);
  const [history, setHistory] = useState<EventHistoryRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.admin
        .events()
        .then((r) => {
          if (!alive) return;
          setCurrent(r.current);
          setHistory(r.history);
        })
        .catch(() => {
          /* transient: the next tick retries */
        });
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  async function forceEnd(): Promise<void> {
    setBusy(true);
    try {
      await api.admin.endEvent();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wc-admin-control">
      <h3 className="wc-admin-sub">Current event</h3>
      {!current ? (
        <p className="wc-hint">No corruption event running.</p>
      ) : (
        <>
          <p className="wc-admin-alert">
            <Biohazard size={14} />
            Zone ({current.bbox.x0},{current.bbox.y0})–({current.bbox.x1},{current.bbox.y1}) —{" "}
            {Math.round(current.corruptionPct * 100)}% corrupted, {current.defenders} defending,{" "}
            {Math.max(0, Math.round((current.endsAt - Date.now()) / 1000))}s left
          </p>
          <button className="wc-danger" disabled={busy} onClick={() => void forceEnd()}>
            <Square size={15} />
            Force end now
          </button>
        </>
      )}

      <h3 className="wc-admin-sub">History</h3>
      {history.length === 0 ? (
        <p className="wc-hint">No events yet.</p>
      ) : (
        <ul className="wc-ip-list">
          {history.map((h) => (
            <li key={h.id}>
              <code>
                ({h.x0},{h.y0})–({h.x1},{h.y1})
              </code>
              <span className="wc-ip-count">
                {h.result ?? "running"}
                {h.corruption_pct !== null ? ` · ${Math.round(h.corruption_pct * 100)}%` : ""}
                {" · "}
                {h.defenders} defenders
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
