import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  EVENT_DURATION_MS,
  EVENT_INTERVAL_MS,
  EXPORT_EXPIRY_HOURS,
  TILE_WORKER_INTERVAL_MS,
} from "@canvasplanet/shared";

// One .env at the repo root, shared by every package. Real environment
// variables always win, so container env in production is unaffected.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = join(repoRoot, ".env");
// quiet: true — dotenv prints a randomized promotional "tip" line (for its
// own dotenvx/vestauth products) on every load otherwise; harmless but has
// no place in this app's logs.
if (existsSync(envFile)) loadDotenv({ path: envFile, quiet: true });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

/**
 * Resolve a configured path against the REPO ROOT, not the current working
 * directory. `pnpm dev` runs from packages/server while scripts and the
 * container run from elsewhere, so a bare "./tilecache" would otherwise
 * scatter cache directories wherever each entrypoint happened to start.
 * Absolute paths (what docker-compose passes) are used as-is.
 */
function repoPath(value: string): string {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 8080),
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:5173",

  databaseUrl: req("DATABASE_URL"),
  sessionSecret: req("SESSION_SECRET"),

  /**
   * Only true when a proxy that OVERWRITES CF-Connecting-IP is in front.
   * Off by default: trusting it on a directly reachable origin lets anyone
   * forge a fresh IP per request and walk straight past the IP budget.
   */
  trustCfConnectingIp: process.env.TRUST_CF_CONNECTING_IP === "true",
  /** Optional local-development stand-in for Cloudflare's CF-IPCountry.
   * Never used in production. */
  devCountryIso: process.env.DEV_COUNTRY_ISO ?? "",

  tileCacheDir: repoPath(process.env.TILE_CACHE_DIR ?? "./tilecache"),
  geoIndexPath: repoPath(process.env.GEO_INDEX_PATH ?? "./data/geo-index.bin"),
  /** Pre-baked, never written to at runtime — see `pnpm geo:bake-basemap`
   *  and routes/basemap.ts. A missing tile there 404s; it never renders
   *  on demand, unlike the pixel canvas's tilecache. */
  basemapDir: repoPath(process.env.BASEMAP_DIR ?? "./data/basemap-tiles"),
  exportOutputDir: repoPath(process.env.EXPORT_OUTPUT_DIR ?? "./exports"),
  exportExpiryHours: Number(process.env.EXPORT_EXPIRY_HOURS ?? EXPORT_EXPIRY_HOURS),
  tileWorkerIntervalMs: Number(
    process.env.TILE_WORKER_INTERVAL_MS ?? TILE_WORKER_INTERVAL_MS,
  ),
  /**
   * Keeps the heatmap's mip pyramid warm by rendering it alongside the
   * colour tile on every drain, roughly doubling the worker's per-tile cost.
   * The escape hatch matters because that cost was already worth studying
   * once (see ROADMAP.md §2.5) before the heatmap existed at all — turn it
   * off without a deploy if a load run shows it moved the p99.
   */
  heatmapWorkerEnabled: process.env.HEATMAP_WORKER !== "false",

  /**
   * Corruption event timing (ROADMAP.md Phase 7). Overridable so
   * `verify/events.mjs` can run a whole event — start, bot ticks, a
   * defending paint, resolution, revert — in seconds instead of the real
   * ~90min/10min cadence, the same reason TILE_WORKER_INTERVAL_MS is
   * overridable above.
   */
  eventIntervalMs: Number(process.env.EVENT_INTERVAL_MS ?? EVENT_INTERVAL_MS),
  eventDurationMs: Number(process.env.EVENT_DURATION_MS ?? EVENT_DURATION_MS),

  cf: {
    token: process.env.CF_API_TOKEN ?? "",
    zoneId: process.env.CF_ZONE_ID ?? "",
    /** Purging is a no-op in dev; the disk cache is authoritative there. */
    enabled: process.env.CF_PURGE_ENABLED === "true",
  },

  /**
   * SMTP is the one interface every provider speaks, including Resend's own
   * SMTP relay (smtp.resend.com, user "resend", pass = API key) — so prod and
   * dev differ only in which host answers on port 587/1025, not in how the
   * app talks to it. Dev default is a local maildev catcher (`pnpm mail:dev`,
   * port 1025, no auth) so the verification email flow is testable on this
   * Docker-less box without a real Resend account.
   */
  smtp: {
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 1025),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    /** Auth is only sent when credentials are configured — maildev accepts
     *  a bare, unauthenticated connection. */
    get auth() {
      return this.user && this.pass ? { user: this.user, pass: this.pass } : undefined;
    },
    secure: process.env.SMTP_SECURE === "true",
  },
  emailFrom: process.env.EMAIL_FROM ?? "CanvasPlanet <noreply@canvasplanet.net>",

  turnstile: {
    sitekey: process.env.TURNSTILE_SITEKEY ?? "",
    secret: process.env.TURNSTILE_SECRET ?? "",
    hostnames: (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
    /** Blank keys disable the first-paint challenge entirely (dev default). */
    get enabled() {
      return Boolean(process.env.TURNSTILE_SITEKEY && process.env.TURNSTILE_SECRET);
    },
  },

  discord: {
    clientId: process.env.DISCORD_CLIENT_ID ?? "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
    /** Blank credentials disable the route entirely (404) rather than
     *  half-working — same shape as turnstile.enabled above. */
    get enabled() {
      return Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
    },
  },
} as const;
