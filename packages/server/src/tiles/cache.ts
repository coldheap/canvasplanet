/**
 * Three-layer tile cache. Cloudflare's edge is layer 1 and lives outside this
 * process; this file is layers 2 and 3.
 *
 *   in-process LRU  — the hottest few hundred encoded buffers
 *   disk            — TILE_CACHE_DIR/{z}/{x}/{y}.png
 *
 * The disk cache is derived state. It is never backed up and can be deleted
 * at any time; everything rebuilds on demand from `pixels`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Z_PIXEL } from "@canvasplanet/shared";
import { env } from "../env.js";
import { EMPTY_TILE, renderTile, type TileMode } from "./renderer.js";

const LRU_MAX = 500;
const lru = new Map<string, Buffer>();
/** A grid-size change gives every coordinate a different geographic meaning.
 *  Namespace derived files so an old z8 tile can never be served as z12. */
const GRID_CACHE_DIR = `grid-z${Z_PIXEL}`;

const keyOf = (z: number, x: number, y: number, mode: TileMode) => `${mode}/${z}/${x}/${y}`;
// Colour is the default inside the grid namespace; alternate render modes
// get their own subdirectory.
const pathOf = (z: number, x: number, y: number, mode: TileMode) =>
  mode === "color"
    ? join(env.tileCacheDir, GRID_CACHE_DIR, String(z), String(x), `${y}.png`)
    : join(env.tileCacheDir, GRID_CACHE_DIR, mode, String(z), String(x), `${y}.png`);

function touch(key: string, buf: Buffer): Buffer {
  lru.delete(key);
  lru.set(key, buf);
  if (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
  return buf;
}

/** Read through: LRU -> disk -> render. Always returns a valid PNG. */
export async function readTile(z: number, x: number, y: number, mode: TileMode = "color"): Promise<Buffer> {
  const key = keyOf(z, x, y, mode);
  const hot = lru.get(key);
  if (hot) return touch(key, hot);

  try {
    const buf = await readFile(pathOf(z, x, y, mode));
    return touch(key, buf);
  } catch {
    // miss — fall through to render
  }

  const rendered = await renderTile(z, x, y, mode);
  // Empty tiles are the common case worldwide; keep them out of the LRU and
  // off disk so the cache holds only tiles that actually have content.
  if (rendered !== EMPTY_TILE) {
    await writeTile(z, x, y, rendered, mode);
    touch(key, rendered);
  }
  return rendered;
}

/**
 * Cache-only lookup: LRU, then disk, then give up. Never renders.
 *
 * This is what parent tiles must use to read their children. `readTile`
 * renders on a miss, and a parent reading four children through it descends
 * the whole pyramid: rendering one z0 tile with a cold cache is 4^12 = 16.7
 * million tile renders in a single request. That is both an unbounded hang
 * and a trivial denial of service on a public URL.
 *
 * A missing child is treated as empty instead. The result is briefly
 * incomplete rather than catastrophic, and self-corrects: the tile worker
 * marks a tile's parent whenever it renders it, so every level is rebuilt
 * from fresh children a tick later.
 */
export async function peekTile(z: number, x: number, y: number, mode: TileMode = "color"): Promise<Buffer | null> {
  const key = keyOf(z, x, y, mode);
  const hot = lru.get(key);
  if (hot) return touch(key, hot);
  try {
    return touch(key, await readFile(pathOf(z, x, y, mode)));
  } catch {
    return null;
  }
}

export async function writeTile(
  z: number,
  x: number,
  y: number,
  buf: Buffer,
  mode: TileMode = "color",
): Promise<void> {
  const p = pathOf(z, x, y, mode);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, buf);
  lru.delete(keyOf(z, x, y, mode));
}

export function evict(z: number, x: number, y: number, mode: TileMode = "color"): void {
  lru.delete(keyOf(z, x, y, mode));
}

export function tileUrl(z: number, x: number, y: number, mode: TileMode = "color"): string {
  const modePath = mode === "heat" ? "heat/" : "";
  return `${env.publicUrl}/tiles/z${Z_PIXEL}/${modePath}${z}/${x}/${y}.png`;
}

export function cacheStats() {
  return { lruSize: lru.size, lruMax: LRU_MAX };
}
