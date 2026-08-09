/**
 * The live dashboard and the kill switch.
 *
 * Polls once a second while open and stops when it is not — an admin panel
 * left open in a tab should not be a permanent load on the box it is
 * monitoring.
 */

import { useEffect, useState } from "react";
import { AlertOctagon, Ban, Snowflake } from "lucide-react";
import { api, type AdminStats } from "../../api.js";
import { useStore } from "../../store.js";

export function ControlTab({ isAdmin }: { isAdmin: boolean }) {
  const frozen = useStore((s) => s.frozen);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.admin
        .stats()
        .then((s) => alive && setStats(s))
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

  async function toggleFreeze(): Promise<void> {
    setBusy(true);
    try {
      const r = await api.admin.freeze(!frozen);
      // The server broadcasts a freeze frame to every client including this
      // one, but set it locally too so the button does not sit stale if the
      // socket happens to be reconnecting.
      useStore.setState({ frozen: r.frozen });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wc-admin-control">
      {isAdmin && (
        <button
          className={frozen ? "wc-danger wc-on" : "wc-danger"}
          disabled={busy}
          onClick={() => void toggleFreeze()}
        >
          {frozen ? <AlertOctagon size={15} /> : <Snowflake size={15} />}
          {frozen ? "Unfreeze canvas" : "Freeze canvas"}
        </button>
      )}
      {frozen && (
        <p className="wc-admin-alert">
          <AlertOctagon size={14} /> The canvas is frozen. No one can paint.
        </p>
      )}

      <div className="wc-stat-grid">
        <Stat label="paints/sec" value={stats ? String(stats.pps) : "—"} />
        <Stat label="clients" value={stats ? String(stats.ws.clients) : "—"} />
        <Stat
          label="tile queue"
          value={stats ? stats.tiles.queue.toLocaleString() : "—"}
          // A queue that keeps climbing means the worker cannot keep up and
          // the canvas is drifting behind what people have painted.
          warn={(stats?.tiles.queue ?? 0) > 5000}
        />
        <Stat label="world total" value={stats ? stats.world.toLocaleString() : "—"} />
        <Stat
          label="degraded sockets"
          value={stats ? String(stats.ws.degraded) : "—"}
          warn={(stats?.ws.degraded ?? 0) > 0}
        />
        <Stat
          label="geo fallback"
          value={stats ? `${(Number(stats.geo.fallbackRate) * 100).toFixed(1)}%` : "—"}
        />
      </div>

      <h3 className="wc-admin-sub">Latency</h3>
      <div className="wc-stat-grid">
        {/* Sustained loop lag means everything queues behind something on
            this thread; a high max with a low p99 means a rare stall. The
            two need very different fixes, which is why both are shown. */}
        <Stat
          label="loop lag p99"
          value={stats ? `${stats.loop.p99Ms}ms` : "—"}
          warn={(stats?.loop.p99Ms ?? 0) > 100}
        />
        <Stat
          label="loop lag max"
          value={stats ? `${stats.loop.maxMs}ms` : "—"}
          warn={(stats?.loop.maxMs ?? 0) > 500}
        />
        <Stat label="tile query" value={stats ? `${stats.tileTiming.query.meanMs}ms` : "—"} />
        <Stat
          label="tile encode"
          value={stats ? `${stats.tileTiming.encode.meanMs}ms` : "—"}
          warn={(stats?.tileTiming.encode.meanMs ?? 0) > 25}
        />
      </div>

      <h3 className="wc-admin-sub">Busiest IPs (last hour)</h3>
      {!stats ? (
        <p className="wc-hint">Loading…</p>
      ) : stats.topIps.length === 0 ? (
        <p className="wc-hint">No paints in the last hour.</p>
      ) : (
        <ul className="wc-ip-list">
          {stats.topIps.map((row) => (
            <li key={row.ip}>
              <code>{row.ip}</code>
              <span className="wc-ip-count">{row.paints.toLocaleString()}</span>
              <button
                className="wc-mini-danger"
                title="Ban this IP for 24 hours"
                onClick={() => void api.admin.ban({ ip: row.ip, hours: 24, reason: "manual" })}
              >
                <Ban size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={warn ? "wc-stat wc-stat-warn" : "wc-stat"}>
      <span className="wc-stat-value">{value}</span>
      <span className="wc-stat-label">{label}</span>
    </div>
  );
}
