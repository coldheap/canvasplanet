/**
 * Every tunable constant in CanvasPlanet, in one place.
 *
 * Rule: if a number appears in PLAN.md, it appears here and nowhere else.
 * Server and client both import from this file so they can never disagree
 * about the grid, the economy, or the protocol.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const SITE_NAME = "CanvasPlanet";
export const SITE_URL = "canvasplanet.net";

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** Web Mercator zoom whose native pixel grid *is* the canvas. */
export const Z_PIXEL = 12;
export const TILE_SIZE = 256;

/** Pixels per axis: 256 * 2^12 = 1,048,576. */
export const WORLD_SIZE = TILE_SIZE * 2 ** Z_PIXEL;

/** Tiles per axis at Z_PIXEL: 4096. */
export const TILES_PER_AXIS = 2 ** Z_PIXEL;

/** Total z12 tiles: 16,777,216. Sized so the geo index fits in memory. */
export const TOTAL_TILES = TILES_PER_AXIS ** 2;

/** Metres per pixel at the equator. Informational — derived, not used in math. */
export const METRES_PER_PIXEL_EQUATOR = 40075016.686 / WORLD_SIZE; // ≈ 38.2185

/** Mercator's latitude limit. Beyond this y would run to infinity. */
export const MAX_LATITUDE = 85.05112877980659;

// ---------------------------------------------------------------------------
// Zoom policy
// ---------------------------------------------------------------------------

/** Below this, painting is disabled — a click could not resolve one pixel. */
export const MIN_PAINT_ZOOM = Z_PIXEL; // 12
export const MAX_MAP_ZOOM = 18;
export const MIN_MAP_ZOOM = 2;
/** Auto-show pixel gridlines at and above this zoom. */
export const GRID_ZOOM = 14; // Z_PIXEL + 2
/** Below this the client sends no tile subscription and gets no pixel stream. */
export const MIN_STREAM_ZOOM = 10; // Z_PIXEL - 2
/** Zoom level at which WS subscriptions are keyed (1 tile = 1024×1024 pixels). */
export const SUB_ZOOM = 10; // Z_PIXEL - 2

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

/** Milliseconds to regenerate one charge. */
export const CHARGE_REGEN_MS = 1_000;
/** Maximum bank size. */
export const CHARGE_MAX = 60;
/** A brand-new session starts with a full bank (see IP_BUDGET_MAX for the
 *  containment on cookie-wiping). */
export const CHARGE_START = 60;

/** Cost table. Modifiers do not stack — see economy.ts. */
export const COST_BASE = 2;
export const COST_OVERPAINT = 4;
export const COST_VIOLATION = 4;
export const COST_RESTORE = 2;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Charges per rolling hour per IP, regardless of how many cookies it holds.
 *  Exactly matches one honest user's regen rate (3600 = 3600s / 1s). */
export const IP_BUDGET_MAX = 3600;
export const IP_BUDGET_REFILL_MS = 1_000;
/** Flagged datacenter/VPN ASNs get half the budget and forced Turnstile. */
export const IP_BUDGET_FLAGGED_ASN = 1800;

// ---------------------------------------------------------------------------
// Geographic scope gate
// ---------------------------------------------------------------------------

/**
 * The one-line lever for scoping the canvas. `null` = worldwide.
 * To restrict to e.g. the GCC, set a pixel-space bbox here — nothing else
 * in the paint path needs to change.
 */
export const PAINT_BOUNDS: { x0: number; y0: number; x1: number; y1: number } | null = null;

// ---------------------------------------------------------------------------
// The seeded landmark
// ---------------------------------------------------------------------------

/** Null Island (0°, 0°) is the exact centre of the grid. */
export const GRID_CENTER = WORLD_SIZE / 2; // 524,288

export const LANDMARK = {
  name: "landmark",
  width: 256,
  height: 128,
  x0: GRID_CENTER - 128, // 524,160
  y0: GRID_CENTER - 64, //  524,224
  x1: GRID_CENTER + 127, // 524,415
  y1: GRID_CENTER + 63, //  524,351
} as const;

/** Where the map opens when there is no URL hash. */
export const DEFAULT_VIEW = { x: GRID_CENTER, y: GRID_CENTER, z: Z_PIXEL } as const;

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** Pixel frames are coalesced into batches at this interval. */
export const PX_BATCH_MS = 100;
/** Leaderboard + pulse tick. */
export const LB_TICK_MS = 1000;
/** Drop pixel frames (never leaderboard frames) past this buffered amount. */
export const WS_BACKPRESSURE_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export const TILE_WORKER_INTERVAL_MS = 2_000;
/** Max tiles re-rendered per worker tick. */
export const TILE_WORKER_BATCH = 256;
/** Cloudflare accepts 30 URLs per purge call on the free plan. */
export const CF_PURGE_BATCH = 30;

// ---------------------------------------------------------------------------
// Interactive canvas history
// ---------------------------------------------------------------------------

/** Past states exposed by history mode. Keeping the window bounded makes a
 *  public historical-tile request predictable even as pixel_events grows. */
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Historical tile URLs are immutable within this bucket. It also prevents a
 *  slider drag from creating an unbounded cache key for every millisecond. */
export const HISTORY_BUCKET_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Static land/ocean basemap (see geo/bake.ts's rasterizeTile)
// ---------------------------------------------------------------------------

/** Highest zoom the land/ocean backdrop is pre-baked to. It is deliberately
 *  lower-resolution than the paint grid: baking all 16.7 million z12
 *  basemap tiles is impractical. The client overzooms these tiles with
 *  nearest-neighbour sampling, while the optional OSM layer supplies
 *  detailed roads and labels. */
export const BASEMAP_MAX_ZOOM = 8;

// ---------------------------------------------------------------------------
// Status history (the public status page's uptime record)
// ---------------------------------------------------------------------------

/** How often a health snapshot is persisted for the uptime history strip. */
export const STATUS_HISTORY_INTERVAL_MS = 5 * 60_000;
/** Rows older than this are pruned on every sample. */
export const STATUS_HISTORY_RETENTION_DAYS = 90;
/** `/api/status/history?days=` is clamped to this — also the retention window. */
export const STATUS_HISTORY_MAX_DAYS = STATUS_HISTORY_RETENTION_DAYS;

// ---------------------------------------------------------------------------
// Templates / timelapse
// ---------------------------------------------------------------------------

// A 4096px cap supports large desktop artwork while keeping one region read
// bounded to 16 MiB of palette-index data before base64 encoding.
export const TEMPLATE_MAX_DIM = 4096;
/** Admin stamps retain their smaller cap because they write in one operation. */
export const ADMIN_STAMP_MAX_DIM = 512;
// Timelapse playback/export can handle larger regions than image templates.
// Keep this bounded to avoid unreasonably large history queries and frame buffers.
export const TIMELAPSE_MAX_DIM = 4096;
export const TIMELAPSE_MAX_FRAMES = 200;
export const TIMELAPSE_MAX_EVENTS = 50_000;

// ---------------------------------------------------------------------------
// Timelapse export (ROADMAP.md §4.3)
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ["gif", "mp4"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Output frame rate. Matches the player's default (100ms/frame at 1x). */
export const EXPORT_FPS = 10;
/** One encode per session per window — the encode is the one thing in this
 *  app that competes with the paint path for CPU, so this stays tight
 *  regardless of how cheap a cache hit is. */
export const EXPORT_RATE_LIMIT_MS = 10 * 60_000;
/** How long a finished file is kept before the expiry sweep deletes it. */
export const EXPORT_EXPIRY_HOURS = 36;

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "cp_sess";
export const SESSION_TTL_DAYS = 365;

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** Reserved id for ocean / unattributed pixels. */
export const INTERNATIONAL_WATERS_ID = 0;
export const INTERNATIONAL_WATERS = {
  id: INTERNATIONAL_WATERS_ID,
  iso_a2: "XX",
  name: "The Ocean",
  flag: "🌊",
} as const;

/** Rows shown in the collapsed leaderboard, above the pinned "your country". */
export const LEADERBOARD_TOP_N = 10;

// ---------------------------------------------------------------------------
// Alliances (ROADMAP.md §4.1)
// ---------------------------------------------------------------------------

export const ALLIANCE_NAME_MIN_LEN = 3;
export const ALLIANCE_NAME_MAX_LEN = 32;
/** New alliances per session per day. Creation is rare; this only stops a
 *  script from squatting names, not genuine community formation. */
export const ALLIANCE_CREATE_PER_DAY = 3;
/** Minimum time between alliance switches (join or leave) for one session.
 *  There is no natural "N per window" table to count against here the way
 *  reports/templates have — you don't rejoin the same alliance repeatedly,
 *  you switch — so this is a cooldown rather than a rolling count. Six
 *  minutes is generous for genuine reconsideration, tight enough to stop
 *  join/leave being used to spam the leaderboard's change broadcast. */
export const ALLIANCE_JOIN_COOLDOWN_MS = 6 * 60_000;
/** Rows shown in the collapsed alliance leaderboard, mirrors LEADERBOARD_TOP_N. */
export const ALLIANCE_LEADERBOARD_TOP_N = 10;

// ---------------------------------------------------------------------------
// Player accounts (ROADMAP.md §5.1)
// ---------------------------------------------------------------------------

export const USER_COOKIE = "cp_user";

/** Rows shown in the collapsed player leaderboard (ROADMAP.md §5.2), mirrors
 *  LEADERBOARD_TOP_N / ALLIANCE_LEADERBOARD_TOP_N. */
export const PLAYER_LEADERBOARD_TOP_N = 10;
/** Long-lived — a player convenience. Also, since ROADMAP's staff-role
 *  change, the cookie an admin's session rides on: granting/revoking a role
 *  takes effect immediately either way (staff.ts re-reads it per request),
 *  but there is no shorter separate staff-session expiry anymore. */
export const USER_SESSION_TTL_DAYS = 90;

export const DISPLAY_NAME_MIN_LEN = 3;
export const DISPLAY_NAME_MAX_LEN = 24;
/** Same shape as alliance names — see routes/admin.ts, routes/alliances.ts. */
export const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_. -]{3,24}$/;

export const PASSWORD_MIN_LEN = 8;

/** A signup/login attempt per IP within this window, before a 429. Login is
 *  the one account route worth guarding against credential stuffing — signup
 *  and verification are already gated by needing a working inbox. */
export const AUTH_RATE_LIMIT_PER_15MIN = 20;

export const EMAIL_VERIFY_TTL_HOURS = 24;
/** Minimum time between "resend verification" requests for one account. */
export const EMAIL_VERIFY_RESEND_COOLDOWN_MS = 60_000;

/** Shorter than email verification — a reset link is a stronger capability
 *  (a live one hands over the account outright), so it stays valid for less
 *  time. */
export const PASSWORD_RESET_TTL_HOURS = 1;
/** Minimum time between "request a reset" requests for one account. */
export const PASSWORD_RESET_COOLDOWN_MS = 60_000;

/** Short-lived CSRF cookie for the Discord OAuth redirect round trip — set on
 *  `/api/auth/discord`, checked and cleared on `/api/auth/discord/callback`.
 *  Not a login credential, so it does not need `USER_SESSION_TTL_DAYS`-scale
 *  lifetime; the whole authorize→callback hop is one browser navigation. */
export const DISCORD_STATE_COOKIE = "cp_discord_state";
export const DISCORD_STATE_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Corruption event (ROADMAP.md Phase 7) — recurring vs-server event
// ---------------------------------------------------------------------------

/** Roughly how often a new event fires, measured from the end of the last
 *  one. Same "fixed, tunable constant" shape as ALLIANCE_JOIN_COOLDOWN_MS —
 *  env.ts can override it for a fast test run without touching this file. */
export const EVENT_INTERVAL_MS = 90 * 60_000;
/** Square zone side length, in pixels. */
export const EVENT_ZONE_SIZE = 48;
/** How long defenders have to hold the zone before it's judged. */
export const EVENT_DURATION_MS = 10 * 60_000;
/** Palette index the bot corrupts pixels with — Black, so it reads as a
 *  clear "something wrong happened here" rather than an ordinary colour. */
export const EVENT_BOT_COLOR = 0;
/** Bot work budget per LB_TICK_MS tick. An ordinary target costs one unit. */
export const EVENT_BOT_PIXELS_PER_TICK = 6;
/** Bot work needed to overwrite a pixel currently held by a player. Claiming
 *  clean ground first therefore makes that ground twice as slow to corrupt. */
export const EVENT_BOT_PLAYER_PIXEL_COST = 2;
/** Extra canvas margin restored with the event zone so nearby event-time
 *  grief does not survive the automatic rollback. */
export const EVENT_ROLLBACK_PADDING = 3;
/** Coverage the zone must stay under, at the timer's end, for defenders to
 *  win. Measured as corrupted pixels / zone area. */
export const EVENT_WIN_THRESHOLD = 0.5;
/** Regen-speed multiplier for the reward — 2x means half the wait per charge. */
export const EVENT_BONUS_MULTIPLIER = 2;
/** How long the reward lasts after a winning event ends. */
export const EVENT_BONUS_DURATION_MS = 10 * 60_000;
