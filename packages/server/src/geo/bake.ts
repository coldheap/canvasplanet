/**
 * Builds the per-tile country and terrain index.
 *
 * Why per-TILE and not per-pixel: the grid is 1,048,576^2 = 1.1e12 pixels. One
 * byte per pixel is 1.1 TB; even one bit is 137 GB. Neither ships. But the
 * world is overwhelmingly uniform at 256-pixel granularity — a z12 tile is
 * ~9.8 km across at the equator, and only coastlines and land borders are
 * genuinely mixed. So: one entry per z12 tile, with a vector fallback for
 * the ~1-2% marked MIXED.
 *
 * The descent is a quadtree from z0. A node with no candidate polygons, or
 * one that lies wholly inside a single polygon, fills its entire subtree
 * from a single test — which is why open ocean (most of the planet) costs
 * almost nothing.
 */

import { TILES_PER_AXIS, TOTAL_TILES, Z_PIXEL, xToLng, yToLat } from "@worldcanvas/shared";
import type { Rect } from "@worldcanvas/shared";
import type { PolygonIndex } from "./polygonIndex.js";

export const MIXED_COUNTRY = 0xffff;
export const enum TerrainBits {
  Water = 0,
  Land = 1,
  Mixed = 2,
}

export interface BakeResult {
  countries: Uint16Array;
  terrain: Uint8Array;
  stats: {
    mixedCountryTiles: number;
    mixedTerrainTiles: number;
    landTiles: number;
    waterTiles: number;
    nodesVisited: number;
  };
}

/** Lon/lat rectangle covered by a tile at an arbitrary zoom. */
export function tileRect(z: number, tx: number, ty: number): Rect {
  const scale = 2 ** (Z_PIXEL - z) * 256; // pixels per tile edge at this zoom
  const x0 = tx * scale;
  const y0 = ty * scale;
  return {
    minX: xToLng(x0),
    maxX: xToLng(x0 + scale),
    // y grows southward in Mercator, so the top edge is the MAX latitude.
    maxY: yToLat(y0),
    minY: yToLat(y0 + scale),
  };
}

/**
 * A flat land/water raster for one basemap tile (see routes/basemap.ts) —
 * the pre-baked backdrop that renders under the pixel canvas when the OSM
 * layer is off, so unpainted ocean/land reads as ocean/land instead of the
 * transparent-by-design pixel tiles (see tiles/renderer.ts) showing raw page
 * background. `z`/`tx`/`ty` address the SAME grid as the pixel canvas — this
 * just stops descending at `outSize` cells per tile instead of at Z_PIXEL,
 * so the same quadtree trick stays cheap at any zoom: `outSize` (256, one
 * output pixel per leaf) never changes, so the recursion depth is a constant
 * 8 levels regardless of z, and still resolves in O(1) wherever no coastline
 * runs through the tile.
 */
export function rasterizeTile(waterIdx: PolygonIndex, z: number, tx: number, ty: number, outSize = 256): Uint8Array {
  const scale = 2 ** (Z_PIXEL - z) * 256; // world-pixel extent of this tile, same formula as tileRect()
  const leaf = scale / outSize; // world pixels per output cell
  const x0 = tx * scale;
  const y0 = ty * scale;
  const mask = new Uint8Array(outSize * outSize);
  descendRaster(waterIdx, x0, y0, scale, leaf, x0, y0, outSize, mask);
  return mask;
}

function descendRaster(
  waterIdx: PolygonIndex,
  x0: number,
  y0: number,
  size: number,
  leaf: number,
  originX: number,
  originY: number,
  outSize: number,
  mask: Uint8Array,
): void {
  if (size > leaf) {
    const verdict = waterIdx.classify(pixelRect(x0, y0, size));
    if ("uniform" in verdict) {
      fillBlock(mask, outSize, (x0 - originX) / leaf, (y0 - originY) / leaf, size / leaf, verdict.uniform !== null ? TerrainBits.Water : TerrainBits.Land);
      return;
    }
    const half = size / 2;
    descendRaster(waterIdx, x0, y0, half, leaf, originX, originY, outSize, mask);
    descendRaster(waterIdx, x0 + half, y0, half, leaf, originX, originY, outSize, mask);
    descendRaster(waterIdx, x0, y0 + half, half, leaf, originX, originY, outSize, mask);
    descendRaster(waterIdx, x0 + half, y0 + half, half, leaf, originX, originY, outSize, mask);
    return;
  }
  // A leaf cell too small to keep subdividing profitably: one representative
  // point test (its centre) decides the whole cell, same trade-off the
  // pixel-level MIXED-tile fallback makes in geo/index.ts's terrainFromMask.
  const isWater = waterIdx.lookup(xToLng(x0 + leaf / 2), yToLat(y0 + leaf / 2)) !== null;
  const lx = (x0 - originX) / leaf;
  const ly = (y0 - originY) / leaf;
  mask[ly * outSize + lx] = isWater ? TerrainBits.Water : TerrainBits.Land;
}

function pixelRect(x0: number, y0: number, size: number): Rect {
  return {
    minX: xToLng(x0),
    maxX: xToLng(x0 + size),
    maxY: yToLat(y0),
    minY: yToLat(y0 + size),
  };
}

function fillBlock(mask: Uint8Array, outSize: number, lx: number, ly: number, size: number, value: number): void {
  for (let y = ly; y < ly + size; y++) {
    const row = y * outSize;
    mask.fill(value, row + lx, row + lx + size);
  }
}

/** Every z12 tile id under a node at (z, tx, ty). */
function fillSubtree(z: number, tx: number, ty: number, write: (tileId: number) => void): void {
  const span = 2 ** (Z_PIXEL - z); // z12 tiles per edge
  const bx = tx * span;
  const by = ty * span;
  for (let x = bx; x < bx + span; x++) {
    const col = x * TILES_PER_AXIS;
    for (let y = by; y < by + span; y++) write(col + y);
  }
}

export function bake(countryIdx: PolygonIndex, waterIdx: PolygonIndex): BakeResult {
  const countries = new Uint16Array(TOTAL_TILES);
  const terrain = new Uint8Array(TOTAL_TILES); // one byte per tile while baking
  const stats = {
    mixedCountryTiles: 0,
    mixedTerrainTiles: 0,
    landTiles: 0,
    waterTiles: 0,
    nodesVisited: 0,
  };

  // ---- countries ---------------------------------------------------------
  descend(countryIdx, (z, tx, ty, verdict) => {
    const value = verdict === "mixed" ? MIXED_COUNTRY : (verdict ?? 0);
    if (verdict === "mixed") stats.mixedCountryTiles += 4 ** (Z_PIXEL - z);
    fillSubtree(z, tx, ty, (id) => {
      countries[id] = value;
    });
  }, stats);

  // ---- terrain -----------------------------------------------------------
  // The water index answers "is this water"; anything not water is land.
  descend(waterIdx, (z, tx, ty, verdict) => {
    const bits =
      verdict === "mixed"
        ? TerrainBits.Mixed
        : verdict === null
          ? TerrainBits.Land
          : TerrainBits.Water;
    const n = 4 ** (Z_PIXEL - z);
    if (bits === TerrainBits.Mixed) stats.mixedTerrainTiles += n;
    else if (bits === TerrainBits.Land) stats.landTiles += n;
    else stats.waterTiles += n;
    fillSubtree(z, tx, ty, (id) => {
      terrain[id] = bits;
    });
  }, stats);

  return { countries, terrain: pack2Bit(terrain), stats };
}

/**
 * Quadtree descent. Calls `emit` for the largest node that can be answered
 * uniformly, and only recurses where a boundary actually runs.
 */
function descend(
  index: PolygonIndex,
  emit: (z: number, tx: number, ty: number, verdict: number | null | "mixed") => void,
  stats: { nodesVisited: number },
): void {
  const stack: Array<[number, number, number]> = [[0, 0, 0]];

  while (stack.length > 0) {
    const [z, tx, ty] = stack.pop()!;
    stats.nodesVisited++;

    const verdict = index.classify(tileRect(z, tx, ty));

    if ("uniform" in verdict) {
      emit(z, tx, ty, verdict.uniform);
      continue;
    }

    // Mixed. At the leaf level that is the final answer; above it, split.
    if (z === Z_PIXEL) {
      emit(z, tx, ty, "mixed");
      continue;
    }
    stack.push([z + 1, tx * 2, ty * 2]);
    stack.push([z + 1, tx * 2 + 1, ty * 2]);
    stack.push([z + 1, tx * 2, ty * 2 + 1]);
    stack.push([z + 1, tx * 2 + 1, ty * 2 + 1]);
  }
}

/** One byte per tile -> two bits per tile. 16.7 MB becomes 4.2 MB. */
export function pack2Bit(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length / 4);
  for (let i = 0; i < src.length; i++) {
    out[i >> 2]! |= (src[i]! & 0b11) << ((i & 3) * 2);
  }
  return out;
}

export function unpack2Bit(packed: Uint8Array, i: number): number {
  return (packed[i >> 2]! >> ((i & 3) * 2)) & 0b11;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export const MAGIC = 0x49474357; // 'WCGI'
export const VERSION = 1;
export const HEADER_BYTES = 16;

export function serialise(result: BakeResult): Buffer {
  const out = Buffer.alloc(
    HEADER_BYTES + result.countries.byteLength + result.terrain.byteLength,
  );
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(VERSION, 4);
  out.writeUInt32LE(TOTAL_TILES, 8);
  Buffer.from(result.countries.buffer, result.countries.byteOffset, result.countries.byteLength).copy(
    out,
    HEADER_BYTES,
  );
  Buffer.from(result.terrain.buffer, result.terrain.byteOffset, result.terrain.byteLength).copy(
    out,
    HEADER_BYTES + result.countries.byteLength,
  );
  return out;
}
