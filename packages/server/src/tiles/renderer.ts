/**
 * Tile rendering.
 *
 *   z=Z_PIXEL       — rendered from `pixels`, one index range scan per tile,
 *                      1 pixel = 1 px.
 *   z0..Z_PIXEL-1   — mipmap-downsampled from the four child tiles, averaging
 *                      RGBA *including alpha*, so a sparse region reads as
 *                      faint rather than snapping to whichever colour
 *                      happened to win.
 *
 * Unpainted pixels stay fully transparent — the static land/ocean backdrop
 * (routes/basemap.ts) and, optionally, the OSM overlay show through.
 *
 * Two modes share every byte of this file except the leaf query:
 *   "color" — the canvas itself, one palette RGB per painted pixel.
 *   "heat"  — paint density. A leaf's whole 256x256 tile is filled with one
 *             greyscale+alpha value (R=G=B=A=intensity), never real colour.
 *             That is deliberate, not a shortcut: the box filter below mixes
 *             RGB by alpha-weighted average, which is meaningful for photo-like
 *             colour but not for a colour ramp — averaging "blue" and "red" as
 *             RGB does not land on whatever colour represents the in-between
 *             density. Greyscale survives averaging as a genuine scalar mean,
 *             so the ramp is applied once, client-side, after the whole
 *             pyramid has been downsampled. See canvas/heatLayer.ts.
 */

import { PNG } from "pngjs";
import { ERASED, PALETTE_RGB, TILES_PER_AXIS, TILE_SIZE, Z_PIXEL, pixelIndexInTile } from "@canvasplanet/shared";
import { pool } from "../db/pool.js";
import { peekTile } from "./cache.js";
import { tileEncodeTime, tileQueryTime } from "../metrics.js";

export type TileMode = "color" | "heat";

/** A fully transparent tile, encoded once. Most of the world, most of the time. */
export const EMPTY_TILE: Buffer = (() => {
  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  png.data.fill(0);
  return PNG.sync.write(png);
})();

/**
 * A tile's painted-pixel count at which the heat ramp reaches full
 * intensity. 65,536 px make up a native tile; most painted areas are far
 * sparser than that, so saturating at 1/16 keeps ordinary activity visible
 * instead of everything but the most-repainted spots reading as "empty".
 */
const HEAT_SATURATION_PIXELS = 4096;

export async function renderTile(z: number, tx: number, ty: number, mode: TileMode = "color"): Promise<Buffer> {
  return z === Z_PIXEL ? renderPixelTile(tx, ty, mode) : renderParentTile(z, tx, ty, mode);
}

async function renderPixelTile(tx: number, ty: number, mode: TileMode): Promise<Buffer> {
  return mode === "heat" ? renderHeatLeaf(tx, ty) : renderColorLeaf(tx, ty);
}

async function renderColorLeaf(tx: number, ty: number): Promise<Buffer> {
  const tileId = tx * TILES_PER_AXIS + ty;
  // Split the timing: the query is I/O the event loop can interleave, the
  // encode is synchronous CPU that it cannot. Only the second is worth
  // moving to a worker thread, so measure them apart before deciding.
  const { rows } = await tileQueryTime.measure(() =>
    pool.query<{ x: number; y: number; color: number }>(
      `SELECT x, y, color FROM pixels WHERE tile_id = $1`,
      [tileId],
    ),
  );
  if (rows.length === 0) return EMPTY_TILE;

  return tileEncodeTime.measureSync(() => {
    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
    png.data.fill(0); // transparent
    for (const row of rows) {
      const rgb = PALETTE_RGB[row.color];
      if (!rgb) continue; // palette shrank under us; skip rather than crash
      const o = pixelIndexInTile(row.x, row.y) * 4;
      png.data[o] = rgb[0];
      png.data[o + 1] = rgb[1];
      png.data[o + 2] = rgb[2];
      png.data[o + 3] = 255;
    }
    return PNG.sync.write(png);
  });
}

/** Render an immutable native tile as it existed at `at`. Historical tiles
 *  deliberately have no lower-resolution pyramid: the interactive client
 *  requests them only at Z_PIXEL and overzooms for close inspection. */
export async function renderHistoryTile(tx: number, ty: number, at: number): Promise<Buffer> {
  const { rows } = await tileQueryTime.measure(() =>
    pool.query<{ x: number; y: number; color: number }>(
      `SELECT DISTINCT ON (x, y) x, y, color
         FROM pixel_events
        WHERE (x >> 8) = $1 AND (y >> 8) = $2
          AND created_at <= to_timestamp($3 / 1000.0)
        ORDER BY x, y, created_at DESC, id DESC`,
      [tx, ty, at],
    ),
  );
  const visible = rows.filter((row) => row.color !== ERASED);
  if (visible.length === 0) return EMPTY_TILE;

  return tileEncodeTime.measureSync(() => {
    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
    png.data.fill(0);
    for (const row of visible) {
      const rgb = PALETTE_RGB[row.color];
      if (!rgb) continue;
      const o = pixelIndexInTile(row.x, row.y) * 4;
      png.data[o] = rgb[0];
      png.data[o + 1] = rgb[1];
      png.data[o + 2] = rgb[2];
      png.data[o + 3] = 255;
    }
    return PNG.sync.write(png);
  });
}

/**
 * A COUNT(*), not a row fetch — density needs only how many pixels are
 * painted in the tile, and `pixels_tile_idx` answers that as an index-only
 * scan. Cheap enough to compute alongside the colour render on every dirty
 * tile rather than needing its own invalidation path.
 */
async function renderHeatLeaf(tx: number, ty: number): Promise<Buffer> {
  const tileId = tx * TILES_PER_AXIS + ty;
  const { rows } = await tileQueryTime.measure(() =>
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pixels WHERE tile_id = $1`, [tileId]),
  );
  const n = rows[0]?.n ?? 0;
  if (n === 0) return EMPTY_TILE;

  const v = Math.min(255, Math.round((n / HEAT_SATURATION_PIXELS) * 255));
  return tileEncodeTime.measureSync(() => {
    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = v;
    }
    return PNG.sync.write(png);
  });
}

/**
 * Build a parent by downsampling its four children.
 *
 * Children are read from the cache ONLY — a missing child counts as empty.
 * It is tempting to render missing children on demand so a cold request
 * produces a complete picture, and that is exactly the trap: a parent
 * rendering its children recursively descends the entire pyramid, so one
 * cold z0 request is 4^12 = 16.7 million tile renders. It never returns, and
 * on a public URL it is a one-request denial of service.
 *
 * Instead the tile worker marks a tile's parent whenever it renders it, so
 * each level is rebuilt from fresh children on the following tick. A cold
 * zoomed-out view fills in over a few seconds rather than hanging forever.
 *
 * Mode-agnostic: for "heat" it is downsampling greyscale+alpha rather than
 * RGB, but the box filter is the same operation either way.
 */
async function renderParentTile(z: number, tx: number, ty: number, mode: TileMode): Promise<Buffer> {
  const half = TILE_SIZE / 2;
  const out = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  out.data.fill(0);

  let anyContent = false;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const childBuf = await peekTile(z + 1, tx * 2 + dx, ty * 2 + dy, mode);
    if (!childBuf || childBuf === EMPTY_TILE) continue;
    // Decoding four children and downsampling them is the CPU cost of a
    // parent tile, and it is four times the work of a leaf.
    const child = tileEncodeTime.measureSync(() => PNG.sync.read(childBuf));
    anyContent = true;

    // Box-filter 2x2 -> 1, alpha-weighted so transparent neighbours do not
    // drag the colour (or, in heat mode, the intensity) toward black.
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const [ox, oy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const i = ((y * 2 + oy) * TILE_SIZE + (x * 2 + ox)) * 4;
          const av = child.data[i + 3]!;
          r += child.data[i]! * av;
          g += child.data[i + 1]! * av;
          b += child.data[i + 2]! * av;
          a += av;
        }
        if (a === 0) continue;
        const o = ((dy * half + y) * TILE_SIZE + (dx * half + x)) * 4;
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a / 4);
      }
    }
  }

  return anyContent ? tileEncodeTime.measureSync(() => PNG.sync.write(out)) : EMPTY_TILE;
}
