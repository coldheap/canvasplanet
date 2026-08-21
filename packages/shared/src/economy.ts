/**
 * The charge economy: what a paint costs, and how the bank regenerates.
 *
 * Both functions are pure and shared. The server runs them as the
 * authority inside the paint transaction; the client runs the same code to
 * show a cost preview under the cursor and a live countdown. They can never
 * disagree, because it is literally the same function.
 *
 * The client's answer is always advisory — the server recomputes and its
 * number wins.
 */

import {
  CHARGE_MAX,
  CHARGE_REGEN_MS,
  COST_BASE,
  COST_OVERPAINT,
  COST_RESTORE,
  COST_VIOLATION,
  EVENT_BONUS_MULTIPLIER,
} from "./config.js";
import {
  BASEMAP_LAND_COLOR_INDEX,
  BASEMAP_WATER_COLOR_INDEX,
  Family,
  familyOf,
} from "./palette.js";

export const enum Terrain {
  Water = 0,
  Land = 1,
}

/**
 * The same two values as plain exported constants.
 *
 * `const enum` members are erased at compile time and only inlined *within*
 * the file that declares them, so under `isolatedModules` (which every
 * package here uses) a bundled client module importing `Terrain.Land` would
 * compile and then be `undefined` at runtime. Client code that has to
 * construct a Terrain — rather than just receive one over the wire — uses
 * these instead.
 */
export const TERRAIN_WATER: Terrain = Terrain.Water;
export const TERRAIN_LAND: Terrain = Terrain.Land;

/**
 * Palette index an unpainted pixel is drawn as in a preview that has no
 * basemap behind it (report thumbnail, timelapse) — the terrain's canonical
 * shade instead of literal transparency, so an empty stretch of ocean or
 * ground reads as ocean or ground rather than a hole in the image.
 */
export const DEFAULT_TERRAIN_COLOR: Record<Terrain, number> = {
  [Terrain.Water]: BASEMAP_WATER_COLOR_INDEX,
  [Terrain.Land]: BASEMAP_LAND_COLOR_INDEX,
};

/** A water-family colour belongs on water; everything else belongs on land. */
export function isViolation(colorIndex: number, terrain: Terrain): boolean {
  const wantsWater = familyOf(colorIndex) === Family.Water;
  return wantsWater !== (terrain === Terrain.Water);
}

export interface CostInput {
  /** Current colour of the pixel, or null if never painted. */
  currentColor: number | null;
  /** Colour being applied. */
  newColor: number;
  /** Land or water, from the geo index. */
  terrain: Terrain;
}

export interface CostResult {
  cost: number;
  /** Why it costs what it costs — surfaced in the cursor tooltip. */
  reason: "base" | "overpaint" | "violation" | "restore";
}

/**
 * The cost table from PLAN.md §2.
 *
 *   empty  + correct     -> 2  base
 *   empty  + violating   -> 4  violation
 *   painted + correct    -> 4  overpaint
 *   painted + violating  -> 4  (max, not sum — modifiers do NOT stack)
 *   violating -> correct -> 2  restore   (cheap on purpose: healing a
 *                                         sunk coastline should not be
 *                                         more expensive than sinking it)
 */
export function paintCost({ currentColor, newColor, terrain }: CostInput): CostResult {
  const wasPainted = currentColor !== null;
  const wasViolating = wasPainted && isViolation(currentColor, terrain);
  const nowViolating = isViolation(newColor, terrain);

  // Restoration always wins, and always costs the base rate.
  if (wasViolating && !nowViolating) {
    return { cost: COST_RESTORE, reason: "restore" };
  }

  const overpaint = wasPainted ? COST_OVERPAINT : COST_BASE;
  const violation = nowViolating ? COST_VIOLATION : COST_BASE;
  const cost = Math.max(overpaint, violation);

  if (cost === COST_BASE) return { cost, reason: "base" };
  return { cost, reason: nowViolating ? "violation" : "overpaint" };
}

// ---------------------------------------------------------------------------
// Charge bank
// ---------------------------------------------------------------------------

export interface Bank {
  charges: number;
  /** When the current partial charge started accruing. */
  updatedAt: number;
}

/**
 * Lazy regeneration — there is no timer anywhere in the system.
 *
 * `updatedAt` advances by whole regen periods only, so the partial progress
 * toward the next charge is never silently discarded by a read.
 *
 * `regenMs` defaults to the fixed economy constant; the one caller that
 * passes something else is the corruption event's charge-rate reward
 * (ROADMAP.md Phase 7, see `effectiveRegenMs` below) — a temporarily shorter
 * period is the entire mechanism, nothing else about spend/regen changes.
 */
export function regenerate(bank: Bank, now: number, max = CHARGE_MAX, regenMs = CHARGE_REGEN_MS): Bank {
  if (bank.charges >= max) {
    // Already full: reset the accrual clock so the next spend starts a fresh
    // period rather than instantly granting a backlog.
    return { charges: max, updatedAt: now };
  }
  const elapsed = now - bank.updatedAt;
  if (elapsed < regenMs) return bank;

  const gained = Math.floor(elapsed / regenMs);
  const charges = Math.min(max, bank.charges + gained);
  const updatedAt = charges >= max ? now : bank.updatedAt + gained * regenMs;
  return { charges, updatedAt };
}

/** Milliseconds until the next charge lands, or null when the bank is full. */
export function msUntilNextCharge(
  bank: Bank,
  now: number,
  max = CHARGE_MAX,
  regenMs = CHARGE_REGEN_MS,
): number | null {
  if (bank.charges >= max) return null;
  const elapsed = now - bank.updatedAt;
  return Math.max(0, regenMs - (elapsed % regenMs));
}

/**
 * Milliseconds until `bank` can afford `cost` after lazy regeneration.
 * Returns 0 when it is already affordable, or null when the cost exceeds the
 * maximum bank and therefore can never be afforded.
 */
export function msUntilAffordable(
  bank: Bank,
  cost: number,
  now: number,
  max = CHARGE_MAX,
  regenMs = CHARGE_REGEN_MS,
): number | null {
  if (cost > max) return null;

  const r = regenerate(bank, now, max, regenMs);
  if (r.charges >= cost) return 0;

  const chargesNeeded = Math.ceil(cost - r.charges);
  return Math.max(0, r.updatedAt + chargesNeeded * regenMs - now);
}

export function canAfford(
  bank: Bank,
  cost: number,
  now: number,
  max = CHARGE_MAX,
  regenMs = CHARGE_REGEN_MS,
): boolean {
  return regenerate(bank, now, max, regenMs).charges >= cost;
}

/** Spend, or return null if unaffordable. Never mutates the input. */
export function spend(
  bank: Bank,
  cost: number,
  now: number,
  max = CHARGE_MAX,
  regenMs = CHARGE_REGEN_MS,
): Bank | null {
  const r = regenerate(bank, now, max, regenMs);
  if (r.charges < cost) return null;
  // Dropping below max starts the accrual clock at the moment of the spend.
  const wasFull = r.charges >= max;
  return { charges: r.charges - cost, updatedAt: wasFull ? now : r.updatedAt };
}

/**
 * The corruption event's reward (ROADMAP.md Phase 7): while a session's
 * `eventBonusUntil` is in the future, charges regenerate EVENT_BONUS_MULTIPLIER
 * times faster. A plain number in, a plain number out, so every regen call
 * site (paint, bootstrap, the WS charges push) computes it the same way from
 * whatever `event_bonus_until` that session currently has.
 */
export function effectiveRegenMs(eventBonusUntil: number | null, now: number): number {
  return eventBonusUntil !== null && eventBonusUntil > now
    ? CHARGE_REGEN_MS / EVENT_BONUS_MULTIPLIER
    : CHARGE_REGEN_MS;
}

// ---------------------------------------------------------------------------
// IP token bucket — same maths, different constants
// ---------------------------------------------------------------------------

export interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function refillBucket(b: Bucket, now: number, max: number, refillMs: number): Bucket {
  const gained = (now - b.updatedAt) / refillMs;
  if (gained <= 0) return b;
  return { tokens: Math.min(max, b.tokens + gained), updatedAt: now };
}

export function takeToken(
  b: Bucket,
  cost: number,
  now: number,
  max: number,
  refillMs: number,
): Bucket | null {
  const r = refillBucket(b, now, max, refillMs);
  if (r.tokens < cost) return null;
  return { tokens: r.tokens - cost, updatedAt: r.updatedAt };
}
