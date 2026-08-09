/**
 * Wire types for the WebSocket and the REST API.
 *
 * Imported by both sides, so a protocol change that breaks the client is a
 * typecheck failure rather than a runtime mystery.
 */

import type { PaintRefusal } from "./gating.js";
import type { Terrain } from "./economy.js";

// ---------------------------------------------------------------------------
// WebSocket: client -> server
// ---------------------------------------------------------------------------

/** Subscribe to the z10 tiles currently in the viewport. Replaces the previous set. */
export interface CSub {
  t: "sub";
  tiles: string[]; // "10/512/511"
}
export interface CPing {
  t: "ping";
}

export type ClientMessage = CSub | CPing;

// ---------------------------------------------------------------------------
// WebSocket: server -> client
// ---------------------------------------------------------------------------

/** [x, y, colorIndex] — compact on purpose, this is the highest-volume frame. */
export type PixelTuple = [number, number, number];

/**
 * Colour sentinel meaning "this pixel is now unpainted".
 *
 * A revert can delete a pixel outright (when it had never been painted before
 * the incident), and the wire format carries a colour with no way to express
 * absence. Without this the client keeps drawing the old colour until its
 * tile happens to refresh, so a moderator watching their own revert sees
 * nothing happen.
 */
export const ERASED = 255;

/** Batched every PX_BATCH_MS, delivered only to subscribers of the tile. */
export interface SPixels {
  t: "px";
  p: PixelTuple[];
}

/** [countryId, cumulative, held] */
export type LbRow = [number, number, number];

export interface SLeaderboard {
  t: "lb";
  world: number;
  rows: LbRow[];
}

/** [allianceId, cumulative, held] — same shape as LbRow, no world total: the
 *  world total already exists on the country leaderboard, and every painted
 *  pixel is in exactly one country regardless of alliance membership. */
export type AllianceLbRow = [number, number, number];

export interface SAllianceLb {
  t: "alb";
  rows: AllianceLbRow[];
}

/** [userId, displayName, cumulative, held, streakDays] — unlike LbRow/
 *  AllianceLbRow the name rides along in the tuple itself: countries/
 *  alliances are small, static-ish catalogs the client already has indexed
 *  by id from bootstrap, but the players table is neither, so there is no
 *  local catalog to join against. streakDays is the *current* streak
 *  (Phase 6) — a flame badge on the row, not the all-time best, which only
 *  matters on the player's own account panel (see UserDTO.bestStreak). */
export type UserLbRow = [number, string, number, number, number];

export interface SUserLb {
  t: "plb";
  rows: UserLbRow[];
}

export interface SCharges {
  t: "charges";
  bank: number;
  max: number;
  /** Epoch ms when the next charge lands; null when full. */
  nextAt: number | null;
}

/** The activity ticker: paints/sec plus the countries of recent paints. */
export interface SPulse {
  t: "pulse";
  pps: number;
  recent: number[];
}

export interface SFreeze {
  t: "freeze";
  on: boolean;
}

export interface SRegion {
  t: "region";
  op: "add" | "remove";
  region: { id: number; name: string; x0: number; y0: number; x1: number; y1: number };
}

export interface SPong {
  t: "pong";
}

/** A corruption event in progress (ROADMAP.md Phase 7), or null when none
 *  is active — the latter is broadcast once, right when an event resolves,
 *  so every connected client clears its banner/zone outline together rather
 *  than waiting for it to time out locally. */
export interface EventStateDTO {
  id: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  botColor: number;
  startedAt: number;
  endsAt: number;
  /** Corrupted pixels / zone area, 0..1, live. */
  corruptionPct: number;
  /** Distinct sessions that have landed at least one defending paint so far. */
  defenders: number;
}

export interface SEvent {
  t: "event";
  event: EventStateDTO | null;
}

export type ServerMessage =
  | SPixels
  | SLeaderboard
  | SAllianceLb
  | SUserLb
  | SCharges
  | SPulse
  | SFreeze
  | SRegion
  | SEvent
  | SPong;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export interface CountryDTO {
  id: number;
  iso_a2: string;
  name: string;
  flag: string;
}

export interface AllianceDTO {
  id: number;
  name: string;
  /** Palette index — an alliance's colour is one of the canvas's own 32, so
   *  it renders and broadcasts exactly like a pixel colour does. */
  color: number;
}

/** Present only for a logged-in player. Mirrors the shape of `staff` on
 *  BootstrapResponse — same "null means signed out" convention. */
export interface UserDTO {
  id: number;
  /** Null for a Discord-only account that never provided (or verified) an
   *  email through Discord — see routes/auth.ts's Discord callback. */
  email: string | null;
  displayName: string;
  cumulative: number;
  held: number;
  /** Current consecutive-UTC-day paint streak (ROADMAP.md Phase 6). */
  streakDays: number;
  /** All-time longest streak, never decreases. */
  bestStreak: number;
}

export interface BootstrapResponse {
  /** Charge bank, server-authoritative. */
  bank: number;
  max: number;
  nextAt: number | null;
  /**
   * Milliseconds per regenerated charge. Sent rather than assumed so that
   * anything modelling the bank — the countdown, the load test — tracks the
   * server's actual configuration instead of a hardcoded copy that silently
   * goes stale when the economy is retuned.
   */
  regenMs: number;
  /** Country of this session's last paint — drives the pinned leaderboard row. */
  yourCountryId: number | null;
  /** True once this session has passed Turnstile; false means the first
   *  paint will come back 428. */
  verified: boolean;
  /** Present only when the logged-in player account has been granted a
   *  staff role (routes/admin.ts's POST /api/admin/users/:id/role). */
  staff: { id: number; username: string; role: "mod" | "admin" } | null;
  /** Present only for a logged-in player account (ROADMAP.md §5.1). */
  user: UserDTO | null;
  countries: CountryDTO[];
  leaderboard: LbRow[];
  world: number;
  /** Alliance of this session's last paint — mirrors yourCountryId. */
  yourAllianceId: number | null;
  alliances: AllianceDTO[];
  allianceLeaderboard: AllianceLbRow[];
  /** Player leaderboard (ROADMAP.md §5.2) — "your" row is `user`, above; there
   *  is no separate yourUserId the way country/alliance have one, since a
   *  logged-out viewer has no row to pin in the first place. */
  playerLeaderboard: UserLbRow[];
  regions: Array<{ id: number; name: string; x0: number; y0: number; x1: number; y1: number }>;
  frozen: boolean;
  turnstileSitekey: string | null;
  /** True only when DISCORD_CLIENT_ID/SECRET are configured — lets the
   *  client hide the "Continue with Discord" button rather than offer a
   *  flow that would 404 at the first hop. */
  discordEnabled: boolean;
  /** Present only while a corruption event (ROADMAP.md Phase 7) is running —
   *  lets a client that loads mid-event show the banner immediately instead
   *  of waiting for the next 1Hz tick. */
  event: EventStateDTO | null;
}

export interface PaintRequest {
  x: number;
  y: number;
  color: number;
  turnstileToken?: string;
}

export interface PaintResponse {
  ok: true;
  bank: number;
  nextAt: number | null;
  cost: number;
  countryId: number;
}

export interface PaintError {
  ok: false;
  reason: PaintRefusal;
  message: string;
  /** Set for 429s so the client can show an accurate countdown. */
  retryAfterMs?: number;
  /** Set for 423 protected. */
  regionName?: string;
  /** Set for 428. Null when Turnstile is configured off (the dev default). */
  turnstileSitekey?: string | null;
}

export interface PixelInfo {
  x: number;
  y: number;
  color: number | null;
  terrain: Terrain;
  countryId: number;
  paintedAt: string | null;
  paintCount: number;
}

/** Admin-only extension of PixelInfo — who painted it. */
export interface PixelForensics extends PixelInfo {
  sessionId: number | null;
  staffId: number | null;
  ip: string | null;
}

export interface TimelapseFrame {
  /** Epoch ms at the end of this frame's window. */
  t: number;
  p: PixelTuple[];
}

export interface TimelapseResponse {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  from: number;
  to: number;
  /** State at `from`, so the player has something to start from. */
  base: PixelTuple[];
  frames: TimelapseFrame[];
  truncated: boolean;
  /**
   * Terrain for every pixel in the bbox, row-major from (x0,y0), packed one
   * bit per pixel (LSB first) and base64-encoded — a bit's value is the
   * `Terrain` enum value of that pixel. Lets the client paint pixels that
   * are still unpainted at `frame 0` as sea or land instead of transparent.
   */
  terrain: string;
}

export interface ExportStatusResponse {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  error: string | null;
  bytes: number | null;
  /** Set once `status` is "done" — where to GET the encoded file. */
  url: string | null;
}

export interface TemplateDTO {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** base64 of a Uint8Array of palette indices, 255 = transparent. */
  data: string;
}
