/**
 * Everything that can refuse a paint before the economy is even consulted:
 * the world-scope gate, protected regions, and zoom.
 *
 * Kept separate from economy.ts because these are *policy* checks the admin
 * panel mutates at runtime, not fixed rules.
 */

import { MIN_PAINT_ZOOM, PAINT_BOUNDS } from "./config.js";
import type { Bbox } from "./coords.js";
import { inWorld } from "./coords.js";

export interface Region extends Bbox {
  id: number;
  name: string;
}

export function bboxContains(b: Bbox, x: number, y: number): boolean {
  return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
}

export function bboxArea(b: Bbox): number {
  return (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
}

export function bboxOverlaps(a: Bbox, b: Bbox): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

/**
 * The single geographic-scope lever. Ships as `null` (worldwide); setting
 * PAINT_BOUNDS to a bbox scopes the whole canvas without touching paint logic.
 */
export function inPaintBounds(x: number, y: number): boolean {
  if (!inWorld(x, y)) return false;
  if (PAINT_BOUNDS === null) return true;
  return bboxContains(PAINT_BOUNDS, x, y);
}

/**
 * Protected regions are held in memory on the server (refreshed whenever an
 * admin edits them), so this stays a handful of integer comparisons on the
 * hot path rather than a query.
 */
export function findProtecting(regions: readonly Region[], x: number, y: number): Region | null {
  for (const r of regions) {
    if (bboxContains(r, x, y)) return r;
  }
  return null;
}

export function canPaintAtZoom(z: number): boolean {
  return z >= MIN_PAINT_ZOOM;
}

export const enum PaintRefusal {
  OutOfWorld = "out_of_world",
  OutOfBounds = "out_of_bounds",
  Protected = "protected",
  Frozen = "frozen",
  EventResolving = "event_resolving",
  Banned = "banned",
  BadColor = "bad_color",
  NoCharges = "no_charges",
  IpBudget = "ip_budget",
  TurnstileRequired = "turnstile_required",
}

/** HTTP status for each refusal — used by both the server and the client toast. */
export const REFUSAL_STATUS: Record<PaintRefusal, number> = {
  [PaintRefusal.OutOfWorld]: 400,
  [PaintRefusal.BadColor]: 400,
  [PaintRefusal.Banned]: 403,
  [PaintRefusal.OutOfBounds]: 422,
  [PaintRefusal.Protected]: 423,
  [PaintRefusal.Frozen]: 423,
  [PaintRefusal.EventResolving]: 409,
  [PaintRefusal.TurnstileRequired]: 428,
  [PaintRefusal.NoCharges]: 429,
  [PaintRefusal.IpBudget]: 429,
};

export const REFUSAL_MESSAGE: Record<PaintRefusal, string> = {
  [PaintRefusal.OutOfWorld]: "That pixel is outside the canvas.",
  [PaintRefusal.BadColor]: "That colour is not in the palette.",
  [PaintRefusal.Banned]: "Painting is disabled for this session.",
  [PaintRefusal.OutOfBounds]: "Painting is not open in this part of the world yet.",
  [PaintRefusal.Protected]: "This area is protected.",
  [PaintRefusal.Frozen]: "The canvas is temporarily frozen.",
  [PaintRefusal.EventResolving]: "This event has ended and its zone is being restored.",
  [PaintRefusal.TurnstileRequired]: "Quick check before your first pixel.",
  [PaintRefusal.NoCharges]: "Not enough charges yet.",
  [PaintRefusal.IpBudget]: "Too many pixels from this network. Try again later.",
};
