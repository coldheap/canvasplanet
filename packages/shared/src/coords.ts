/**
 * Coordinate math — the single most safety-critical module in the project.
 *
 * The grid is Web Mercator at Z_PIXEL, identical to Leaflet's CRS.EPSG3857,
 * so a pixel (x, y) is exactly the pixel Leaflet would place at that zoom.
 * If this file is ever wrong, every stored pixel is in the wrong place and
 * there is no migration back. It is fully unit-tested.
 */

import { MAX_LATITUDE, TILES_PER_AXIS, TILE_SIZE, WORLD_SIZE, Z_PIXEL } from "./config.js";

export interface Pixel {
  x: number;
  y: number;
}
export interface LatLng {
  lat: number;
  lng: number;
}
export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Longitude → grid x. Wraps at the antimeridian. */
export function lngToX(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return clamp(Math.floor(((wrapped + 180) / 360) * WORLD_SIZE), 0, WORLD_SIZE - 1);
}

/** Latitude → grid y. Clamped to the Mercator limit. */
export function latToY(lat: number): number {
  const clamped = clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
  const rad = (clamped * Math.PI) / 180;
  const merc = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return clamp(Math.floor(((1 - merc / Math.PI) / 2) * WORLD_SIZE), 0, WORLD_SIZE - 1);
}

export function latLngToPixel(ll: LatLng): Pixel {
  return { x: lngToX(ll.lng), y: latToY(ll.lat) };
}

/** Grid x → longitude of the pixel's *left* edge. */
export function xToLng(x: number): number {
  return (x / WORLD_SIZE) * 360 - 180;
}

/** Grid y → latitude of the pixel's *top* edge. */
export function yToLat(y: number): number {
  const n = Math.PI - (2 * Math.PI * y) / WORLD_SIZE;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function pixelToLatLng(c: Pixel): LatLng {
  return { lat: yToLat(c.y), lng: xToLng(c.x) };
}

/** Centre of the pixel, which is what you want for point-in-polygon tests. */
export function pixelCenterLatLng(c: Pixel): LatLng {
  return { lat: yToLat(c.y + 0.5), lng: xToLng(c.x + 0.5) };
}

export function inWorld(x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < WORLD_SIZE &&
    y < WORLD_SIZE
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * Packed Z_PIXEL tile id, matching the `tile_id` generated column in
 * Postgres. Keep these two definitions in lockstep — the DB expression is
 * `(x >> 8) * TILES_PER_AXIS + (y >> 8)` (currently `(x >> 8) * 4096 + (y
 * >> 8)`, see migrations/0018_restore_z12_world.sql).
 */
export function tileIdOf(x: number, y: number): number {
  return (x >> 8) * TILES_PER_AXIS + (y >> 8);
}

export function tileIdToXY(tileId: number): { tx: number; ty: number } {
  return { tx: Math.floor(tileId / TILES_PER_AXIS), ty: tileId % TILES_PER_AXIS };
}

/** Pixel-space bbox covered by a native Z_PIXEL tile. */
export function tileBbox(tx: number, ty: number): Bbox {
  return {
    x0: tx * TILE_SIZE,
    y0: ty * TILE_SIZE,
    x1: tx * TILE_SIZE + TILE_SIZE - 1,
    y1: ty * TILE_SIZE + TILE_SIZE - 1,
  };
}

/** Offset of a pixel inside its own native tile, 0..65535. */
export function pixelIndexInTile(x: number, y: number): number {
  return (y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1));
}

/**
 * The full dirty chain for a paint: its native tile plus every ancestor up to
 * z0. Z_PIXEL + 1 entries. Ordered leaf-first so the tile worker can render
 * children before the parents that downsample from them.
 */
export function tileAncestry(x: number, y: number): Array<{ z: number; x: number; y: number }> {
  const out: Array<{ z: number; x: number; y: number }> = [];
  let tx = x >> 8;
  let ty = y >> 8;
  for (let z = Z_PIXEL; z >= 0; z--) {
    out.push({ z, x: tx, y: ty });
    tx >>= 1;
    ty >>= 1;
  }
  return out;
}

/** Tile key at an arbitrary zoom for a given pixel — used for WS subscriptions. */
export function tileKeyAt(z: number, x: number, y: number): string {
  const shift = Z_PIXEL - z + 8; // 8 bits pixel→native tile, then one per zoom step
  return `${z}/${x >> shift}/${y >> shift}`;
}

/** Every subscription-zoom tile key overlapping a pixel-space bbox. */
export function subKeysForBbox(b: Bbox, z: number): string[] {
  const shift = Z_PIXEL - z + 8;
  const keys: string[] = [];
  for (let tx = b.x0 >> shift; tx <= b.x1 >> shift; tx++) {
    for (let ty = b.y0 >> shift; ty <= b.y1 >> shift; ty++) {
      keys.push(`${z}/${tx}/${ty}`);
    }
  }
  return keys;
}
