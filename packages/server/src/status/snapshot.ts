/**
 * The one health check everything in `status/` is built from.
 *
 * `/api/status` calls this live; the history sampler (`history.ts`) calls it
 * on a timer and persists the result. Same function either way, so the
 * "current" banner and the row written to `status_history` can never
 * disagree about what "ok" meant at that instant.
 *
 * "Components" is a real decomposition of real signals (DB reachability and
 * latency, tile-worker backlog, WebSocket socket health), not three
 * independently-monitored services — this is one process (see index.ts).
 * Treat it as "which part of the one health check is unhappy", not as
 * per-service uptime.
 */

import { pool } from "../db/pool.js";
import { leaderboard } from "../leaderboard/store.js";
import { isFrozen } from "../state/policy.js";
import { queueDepth } from "../tiles/worker.js";
import { hub } from "../ws/hub.js";

export type ComponentKey = "canvas" | "realtime" | "database";
export type ComponentState = "operational" | "degraded" | "down";

export interface StatusSnapshot {
  /** True unless `overall` is "down" — what an external uptime monitor should key on. */
  ok: boolean;
  overall: ComponentState;
  frozen: boolean;
  dbOk: boolean;
  dbLatencyMs: number;
  paintsPerSec: number;
  worldTotal: number;
  connectedClients: number;
  wsDegraded: number;
  /** -1 when the queue depth itself could not be read. */
  tileQueueDepth: number;
  uptimeSeconds: number;
  time: string;
  components: Record<ComponentKey, ComponentState>;
}

const bootedAt = Date.now();

/** Matches the admin dashboard's own warning thresholds — see admin.ts / AdminPanel. */
const TILE_QUEUE_WARN = 5000;
const DB_LATENCY_WARN_MS = 200;

const SEVERITY: Record<ComponentState, number> = { operational: 0, degraded: 1, down: 2 };

export function overallOf(components: Record<ComponentKey, ComponentState>): ComponentState {
  let worst: ComponentState = "operational";
  for (const s of Object.values(components)) {
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}

/**
 * Pure function of raw signals, so the live snapshot and a historical row
 * pulled back out of `status_history` are scored by identical rules.
 */
export function deriveComponents(input: {
  dbOk: boolean;
  dbLatencyMs: number;
  tileQueueDepth: number;
  wsDegraded: number;
}): Record<ComponentKey, ComponentState> {
  const database: ComponentState = !input.dbOk
    ? "down"
    : input.dbLatencyMs > DB_LATENCY_WARN_MS
      ? "degraded"
      : "operational";

  // Painting depends on the database (every paint is a transaction) and on
  // the tile worker keeping up — a queue that climbs means the canvas is
  // visibly drifting behind what people have painted, even though writes
  // are still succeeding.
  const canvas: ComponentState =
    !input.dbOk || input.tileQueueDepth < 0
      ? "down"
      : input.tileQueueDepth > TILE_QUEUE_WARN
        ? "degraded"
        : "operational";

  // No "down" state here: a fully dead WebSocket hub still leaves painting
  // and the API working (the live overlay degrades to the ~2s tile refresh),
  // and this process has no signal that distinguishes "hub is dead" from
  // "nobody has an open tab right now".
  const realtime: ComponentState = input.wsDegraded > 0 ? "degraded" : "operational";

  return { canvas, realtime, database };
}

export async function computeStatus(): Promise<StatusSnapshot> {
  const dbStarted = performance.now();
  let dbOk = true;
  let paintsPerSec = 0;
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pixel_events WHERE created_at > now() - interval '10 seconds'`,
    );
    paintsPerSec = Math.round((rows[0]?.n ?? 0) / 10);
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Math.round((performance.now() - dbStarted) * 100) / 100;

  // A queue-depth failure most often means the DB is down, which the probe
  // above already reflects — treat it as "unknown" (-1) here rather than a
  // second, redundant failure mode.
  const tileQueueDepth = await queueDepth().catch(() => -1);
  const ws = hub.stats();

  const components = deriveComponents({ dbOk, dbLatencyMs, tileQueueDepth, wsDegraded: ws.degraded });
  const overall = overallOf(components);

  return {
    ok: overall !== "down",
    overall,
    frozen: isFrozen(),
    dbOk,
    dbLatencyMs,
    paintsPerSec,
    worldTotal: leaderboard.worldTotal(),
    connectedClients: ws.clients,
    wsDegraded: ws.degraded,
    tileQueueDepth,
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
    time: new Date().toISOString(),
    components,
  };
}
