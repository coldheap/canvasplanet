/**
 * Persists a health snapshot on a timer and serves the daily-aggregated
 * uptime strip the status pages render.
 *
 * Sampled from inside this process, which is a real limitation worth being
 * explicit about: a full crash of this process writes no bad sample at all,
 * so that kind of outage shows up as a *gap* in the strip, not as "down"
 * time. This is the "what did our own numbers look like" record, not a
 * substitute for an external monitor that can page someone.
 */

import {
  STATUS_HISTORY_INTERVAL_MS,
  STATUS_HISTORY_MAX_DAYS,
  STATUS_HISTORY_RETENTION_DAYS,
} from "@worldcanvas/shared";
import { pool } from "../db/pool.js";
import { computeStatus, deriveComponents, overallOf, type ComponentKey, type ComponentState } from "./snapshot.js";

let timer: NodeJS.Timeout | null = null;

export function startStatusHistory(): void {
  void sample(); // one point immediately — don't wait a full interval for the first
  timer = setInterval(() => void sample(), STATUS_HISTORY_INTERVAL_MS);
}

export function stopStatusHistory(): void {
  if (timer) clearInterval(timer);
}

async function sample(): Promise<void> {
  try {
    const s = await computeStatus();
    await pool.query(
      `INSERT INTO status_history (ok, db_ok, db_latency_ms, paints_per_sec, tile_queue_depth, ws_degraded)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.ok, s.dbOk, s.dbLatencyMs, s.paintsPerSec, s.tileQueueDepth, s.wsDegraded],
    );
    // Pruning here rather than a separate cron: this already runs on a fixed
    // schedule, and deleting a range off a BRIN-indexed timestamp is cheap.
    await pool.query(
      `DELETE FROM status_history WHERE checked_at < now() - ($1 || ' days')::interval`,
      [STATUS_HISTORY_RETENTION_DAYS],
    );
  } catch (err) {
    console.error("[status] history sample failed", err);
  }
}

export type DayState = ComponentState | "nodata";

export interface DayHistory {
  /** UTC calendar date, YYYY-MM-DD — the strip means the same thing regardless of the reader's timezone. */
  date: string;
  overall: DayState;
  /** Fraction of that day's samples with ok=true. null when there were none. */
  uptimeRatio: number | null;
  samples: number;
  components: Record<ComponentKey, DayState>;
}

export interface HistoryResult {
  days: number;
  /** ISO timestamp of the earliest sample in the window, or null if history is empty. */
  since: string | null;
  history: DayHistory[];
}

const DAY_SEVERITY: Record<DayState, number> = { nodata: -1, operational: 0, degraded: 1, down: 2 };
const worstDay = (a: DayState, b: DayState): DayState => (DAY_SEVERITY[b] > DAY_SEVERITY[a] ? b : a);

export async function dailyHistory(daysRequested: number): Promise<HistoryResult> {
  const days = Math.max(1, Math.min(STATUS_HISTORY_MAX_DAYS, Math.floor(daysRequested) || STATUS_HISTORY_MAX_DAYS));

  const { rows } = await pool.query<{
    checked_at: Date;
    ok: boolean;
    db_ok: boolean;
    db_latency_ms: number;
    tile_queue_depth: number;
    ws_degraded: number;
  }>(
    `SELECT checked_at, ok, db_ok, db_latency_ms, tile_queue_depth, ws_degraded
       FROM status_history
      WHERE checked_at > now() - ($1 || ' days')::interval
      ORDER BY checked_at ASC`,
    [days],
  );

  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.checked_at.toISOString().slice(0, 10);
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }

  const history: DayHistory[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const samples = byDay.get(key);

    if (!samples || samples.length === 0) {
      history.push({
        date: key,
        overall: "nodata",
        uptimeRatio: null,
        samples: 0,
        components: { canvas: "nodata", realtime: "nodata", database: "nodata" },
      });
      continue;
    }

    let overall: DayState = "operational";
    const components: Record<ComponentKey, DayState> = {
      canvas: "operational",
      realtime: "operational",
      database: "operational",
    };
    let okCount = 0;
    for (const r of samples) {
      if (r.ok) okCount++;
      const rowComponents = deriveComponents({
        dbOk: r.db_ok,
        dbLatencyMs: r.db_latency_ms,
        tileQueueDepth: r.tile_queue_depth,
        wsDegraded: r.ws_degraded,
      });
      for (const k of Object.keys(rowComponents) as ComponentKey[]) {
        components[k] = worstDay(components[k], rowComponents[k]);
      }
      overall = worstDay(overall, overallOf(rowComponents));
    }

    history.push({ date: key, overall, uptimeRatio: okCount / samples.length, samples: samples.length, components });
  }

  return { days, since: rows[0]?.checked_at.toISOString() ?? null, history };
}
