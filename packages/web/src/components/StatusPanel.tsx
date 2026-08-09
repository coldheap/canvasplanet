/**
 * The public status view — the same /api/status an uptime monitor would
 * poll, shown to anyone. No auth, no IPs, no session data: just the numbers
 * that answer "is the canvas up right now".
 *
 * A compact companion to the standalone `status.<domain>` page (see
 * status/index.html at the repo root), not a replacement for it: this fits
 * inside a settings modal, so the history strip is a fixed 30 days with no
 * per-day tooltip, and the link out is for anyone who wants the full
 * interactive 90-day view.
 */

import { useEffect, useState } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, ExternalLink, Loader2, Radio, XCircle } from "lucide-react";

type ComponentKey = "canvas" | "realtime" | "database";
type ComponentState = "operational" | "degraded" | "down";
type DayState = ComponentState | "nodata";

interface Status {
  ok: boolean;
  overall: ComponentState;
  frozen: boolean;
  dbOk: boolean;
  dbLatencyMs: number;
  paintsPerSec: number;
  worldTotal: number;
  connectedClients: number;
  tileQueueDepth: number;
  uptimeSeconds: number;
  time: string;
  components: Record<ComponentKey, ComponentState>;
}

interface HistoryDay {
  date: string;
  components: Record<ComponentKey, DayState>;
}

interface History {
  history: HistoryDay[];
}

const COMPONENT_LABEL: Record<ComponentKey, string> = {
  canvas: "Canvas & painting",
  realtime: "Realtime updates",
  database: "Database",
};

const STATE_LABEL: Record<DayState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  nodata: "No data",
};

const HISTORY_DAYS = 30;

export function StatusPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch("/api/status")
        .then((r) => r.json())
        .then((s) => {
          if (alive) {
            setStatus(s);
            setFailed(false);
          }
        })
        .catch(() => alive && setFailed(true));
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/status/history?days=${HISTORY_DAYS}`)
      .then((r) => r.json())
      .then((h) => alive && setHistory(h))
      .catch(() => {
        /* the live section above still works without history */
      });
    return () => {
      alive = false;
    };
  }, []);

  const statusHost = typeof location !== "undefined" ? `status.${location.hostname}` : null;

  return (
    <div className="wc-status">
      <h2 className="wc-panel-title">
        <Radio size={16} />
        Status
      </h2>

      {failed && !status ? (
        <p className="wc-error">
          <AlertOctagon size={14} /> Could not reach the status endpoint.
        </p>
      ) : !status ? (
        <p className="wc-hint wc-loading">
          <Loader2 size={15} className="wc-spin" /> Checking…
        </p>
      ) : (
        <>
          <Banner status={status} />

          <div className="wc-status-components">
            {(Object.keys(COMPONENT_LABEL) as ComponentKey[]).map((key) => (
              <ComponentRow
                key={key}
                label={COMPONENT_LABEL[key]}
                state={status.components[key]}
                days={history?.history.map((d) => d.components[key]) ?? []}
              />
            ))}
          </div>

          <div className="wc-stat-grid">
            <Stat label="paints/sec" value={String(status.paintsPerSec)} />
            <Stat label="connected" value={String(status.connectedClients)} />
            <Stat
              label="tile queue"
              value={status.tileQueueDepth >= 0 ? status.tileQueueDepth.toLocaleString() : "—"}
              warn={status.tileQueueDepth > 5000}
            />
            <Stat label="world total" value={status.worldTotal.toLocaleString()} />
            <Stat
              label="db latency"
              value={`${status.dbLatencyMs}ms`}
              warn={!status.dbOk || status.dbLatencyMs > 200}
            />
            <Stat label="uptime" value={formatUptime(status.uptimeSeconds)} />
          </div>

          <p className="wc-hint">Last checked {new Date(status.time).toLocaleTimeString()}</p>
          {statusHost && (
            <a className="wc-status-link" href={`https://${statusHost}`} target="_blank" rel="noreferrer">
              <ExternalLink size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
              Full 90-day history at {statusHost}
            </a>
          )}
        </>
      )}
    </div>
  );
}

function Banner({ status }: { status: Status }) {
  if (status.overall === "operational") {
    return (
      <p className="wc-ok">
        <CheckCircle2 size={15} />
        All systems operational
        {status.frozen && " — canvas is frozen"}
      </p>
    );
  }
  if (status.overall === "degraded") {
    return (
      <p className="wc-warn-banner">
        <AlertTriangle size={14} />
        Degraded performance
        {status.frozen && " — canvas is frozen"}
      </p>
    );
  }
  return (
    <p className="wc-admin-alert">
      <AlertOctagon size={14} />
      Major outage
    </p>
  );
}

function ComponentRow({ label, state, days }: { label: string; state: ComponentState; days: DayState[] }) {
  const Icon = state === "operational" ? CheckCircle2 : state === "degraded" ? AlertTriangle : XCircle;
  return (
    <div className="wc-status-component">
      <span className={`wc-status-component-icon ${state}`}>
        <Icon size={14} />
      </span>
      <span className="wc-status-component-name">{label}</span>
      <span className="wc-status-component-state">{STATE_LABEL[state]}</span>
      <div className="wc-status-strip">
        {days.map((d, i) => (
          <span key={i} className={`wc-status-day ${d}`} title={`${STATE_LABEL[d]}`} />
        ))}
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={warn ? "wc-stat wc-stat-warn" : "wc-stat"}>
      <span className="wc-stat-value">{value}</span>
      <span className="wc-stat-label">{label}</span>
    </div>
  );
}
