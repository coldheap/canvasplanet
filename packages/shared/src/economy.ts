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
} from "./config.js";
import { Family, familyOf } from "./palette.js";

export const enum Terrain {
  Water = 0,
  Land = 1,
}

/**
 * Palette index an unpainted pixel is drawn as in a preview that has no
 * basemap behind it (report thumbnail, timelapse) — the terrain's canonical
 * shade instead of literal transparency, so an empty stretch of ocean or
 * ground reads as ocean or ground rather than a hole in the image.
 */
export const DEFAULT_TERRAIN_COLOR: Record<Terrain, number> = {
  [Terrain.Water]: 29, // "Blue"
  [Terrain.Land]: 4, // "White"
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
 *   empty  + correct     -> 1  base
 *   empty  + violating   -> 2  violation
 *   painted + correct    -> 2  overpaint
 *   painted + violating  -> 2  (max, not sum — modifiers do NOT stack)
 *   violating -> correct -> 1  restore   (cheap on purpose: healing a
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
 */
export function regenerate(bank: Bank, now: number, max = CHARGE_MAX): Bank {
  if (bank.charges >= max) {
    // Already full: reset the accrual clock so the next spend starts a fresh
    // period rather than instantly granting a backlog.
    return { charges: max, updatedAt: now };
  }
  const elapsed = now - bank.updatedAt;
  if (elapsed < CHARGE_REGEN_MS) return bank;

  const gained = Math.floor(elapsed / CHARGE_REGEN_MS);
  const charges = Math.min(max, bank.charges + gained);
  const updatedAt =
    charges >= max ? now : bank.updatedAt + gained * CHARGE_REGEN_MS;
  return { charges, updatedAt };
}

/** Milliseconds until the next charge lands, or null when the bank is full. */
export function msUntilNextCharge(bank: Bank, now: number, max = CHARGE_MAX): number | null {
  if (bank.charges >= max) return null;
  const elapsed = now - bank.updatedAt;
  return Math.max(0, CHARGE_REGEN_MS - (elapsed % CHARGE_REGEN_MS));
}

export function canAfford(bank: Bank, cost: number, now: number, max = CHARGE_MAX): boolean {
  return regenerate(bank, now, max).charges >= cost;
}

/** Spend, or return null if unaffordable. Never mutates the input. */
export function spend(bank: Bank, cost: number, now: number, max = CHARGE_MAX): Bank | null {
  const r = regenerate(bank, now, max);
  if (r.charges < cost) return null;
  // Dropping below max starts the accrual clock at the moment of the spend.
  const wasFull = r.charges >= max;
  return { charges: r.charges - cost, updatedAt: wasFull ? now : r.updatedAt };
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
