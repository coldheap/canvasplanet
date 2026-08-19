/**
 * Independent uptime watcher: polls the public `/api/status` endpoint and
 * pushes a notification on state changes (see ROADMAP.md §3.3).
 *
 *   pnpm alert:watch
 *
 * "Independent" is the entire point. `status/history.ts` already samples
 * health every 5 minutes, but it does so *from inside the app process* — a
 * full crash of that process writes no bad sample at all, it just leaves a
 * gap in the strip (see its own doc comment). This script is deliberately a
 * separate OS process that only talks to the app over HTTP, so a dead
 * server shows up as a fetch failure here even when nothing app-side is
 * left running to report it.
 *
 * Run it anywhere that can reach the app: alongside it via pm2/systemd, on
 * a second box, or on this dev machine against a local server. It has no
 * dependency on the DB, the app's env, or even the app's language.
 *
 * Deliberately not a full monitoring stack (no persistence, no dashboard —
 * that is what `/api/status/history` and the status page are for). This is
 * the "someone gets pinged" half that was missing.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = join(repoRoot, ".env");
// quiet: true — see the identical note in src/env.ts.
if (existsSync(envFile)) loadDotenv({ path: envFile, quiet: true });

const STATUS_URL = process.env.ALERT_STATUS_URL || `http://localhost:${process.env.PORT ?? 8080}/api/status`;
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const POLL_INTERVAL_MS = Number(process.env.ALERT_POLL_INTERVAL_MS) || 30_000;
// One bad poll can just be a GC pause or a network blip; require a couple
// in a row before paging anyone.
const FAIL_THRESHOLD = Number(process.env.ALERT_FAIL_THRESHOLD) || 2;
// While still down, don't send a fresh notification on every single poll —
// but do re-surface it periodically so a long outage isn't silent after
// the first message.
const RENOTIFY_MS = Number(process.env.ALERT_RENOTIFY_MS) || 15 * 60_000;
const REQUEST_TIMEOUT_MS = Math.min(10_000, POLL_INTERVAL_MS);

type Severity = "operational" | "degraded" | "down";

interface Poll {
  reachable: boolean;
  overall: Severity;
  detail: string;
}

interface StatusSnapshotShape {
  overall: Severity;
  components: Record<string, Severity>;
  dbLatencyMs: number;
  paintsPerSec: number;
  tileQueueDepth: number;
  connectedClients: number;
}

async function poll(): Promise<Poll> {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    // The endpoint itself returns 503 when overall is "down" — still a
    // successful fetch, just an unhealthy one, so read the body either way.
    const body = (await res.json()) as StatusSnapshotShape;
    const parts = Object.entries(body.components ?? {})
      .filter(([, v]) => v !== "operational")
      .map(([k, v]) => `${k}=${v}`);
    const detail =
      parts.length > 0
        ? parts.join(", ")
        : `db ${body.dbLatencyMs}ms, ${body.paintsPerSec} paints/s, tile queue ${body.tileQueueDepth}`;
    return { reachable: true, overall: body.overall ?? "down", detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, overall: "down", detail: `unreachable — ${message}` };
  }
}

async function notify(text: string): Promise<void> {
  const stamp = new Date().toISOString();
  console.log(`[alert-watch] ${stamp} ${text}`);
  if (!WEBHOOK_URL) return;
  try {
    // Both `text` (Slack incoming webhooks) and `content` (Discord incoming
    // webhooks) so the same payload works against either without config.
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[alert-watch] failed to deliver webhook: ${(err as Error).message}`);
  }
}

let consecutiveBad = 0;
let alerting = false;
let downSince: number | null = null;
let lastNotifiedAt = 0;
let lastSeverity: Severity = "operational";

async function tick(): Promise<void> {
  const result = await poll();
  const bad = result.overall !== "operational";

  if (!bad) {
    consecutiveBad = 0;
    if (alerting) {
      const downtimeMin = downSince ? Math.round((Date.now() - downSince) / 60_000) : 0;
      await notify(`✅ canvasplanet recovered (was down ~${downtimeMin}m). ${result.detail}`);
      alerting = false;
      downSince = null;
    }
    lastSeverity = "operational";
    return;
  }

  consecutiveBad++;
  if (consecutiveBad < FAIL_THRESHOLD) return;

  const now = Date.now();
  const justEscalated = alerting && result.overall === "down" && lastSeverity === "degraded";
  const dueForRenotify = alerting && now - lastNotifiedAt >= RENOTIFY_MS;

  if (!alerting || justEscalated || dueForRenotify) {
    if (!alerting) downSince = now;
    const icon = result.overall === "down" ? "🔴" : "🟡";
    await notify(`${icon} canvasplanet is ${result.overall}: ${result.detail} (${STATUS_URL})`);
    lastNotifiedAt = now;
    alerting = true;
  }
  lastSeverity = result.overall;
}

console.log(`[alert-watch] watching ${STATUS_URL} every ${POLL_INTERVAL_MS}ms`);
if (!WEBHOOK_URL) {
  console.warn(
    "[alert-watch] WARNING: ALERT_WEBHOOK_URL is not set — transitions are logged here only, nothing pages anyone",
  );
}

void tick();
const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);

function shutdown(): void {
  clearInterval(timer);
  console.log("[alert-watch] stopped");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
