/**
 * Country and terrain lookup — called once per paint, must stay well under
 * a millisecond.
 *
 * Structure (see bake.ts for why it is per-tile and not per-pixel):
 *   - `geo-index.bin` gives an O(1) answer for tiles that are uniform.
 *   - MIXED tiles (coastlines, land borders) fall back to point-in-polygon
 *     against the source geometry. For terrain the resulting 256x256 mask is
 *     cached, because coastal tiles people actually paint on are a small,
 *     very hot set.
 *
 * At z12 a native tile is roughly 9.8 km across at the equator, so the
 * uniform-tile fast path covers the great majority of the world.
 */

import { readFile } from "node:fs/promises";
import {
  INTERNATIONAL_WATERS_ID,
  TILE_SIZE,
  TILES_PER_AXIS,
  TOTAL_TILES,
  Terrain,
  Z_PIXEL,
  pixelCenterLatLng,
  tileIdOf,
} from "@worldcanvas/shared";
import { env } from "../env.js";
import { HEADER_BYTES, MAGIC, MIXED_COUNTRY, TerrainBits, rasterizeTile, unpack2Bit } from "./bake.js";
import type { PolygonIndex } from "./polygonIndex.js";

export { MIXED_COUNTRY, TerrainBits };

export interface GeoResult {
  countryId: number;
  terrain: Terrain;
}

class GeoIndex {
  private countries: Uint16Array = new Uint16Array(0);
  private terrainBits: Uint8Array = new Uint8Array(0);
  private maskCache = new Map<number, Uint8Array>();
  private readonly maskCacheMax = 2000; // ~16 MB of 8 KB masks
  private loaded = false;

  /** Source geometry for the MIXED fallback. Optional: without it, mixed
   *  tiles degrade to a documented default rather than failing a paint. */
  private countryPolys: PolygonIndex | null = null;
  private waterPolys: PolygonIndex | null = null;

  private hits = 0;
  private countryFallbacks = 0;
  private terrainFallbacks = 0;

  attachSources(country: PolygonIndex | null, water: PolygonIndex | null): void {
    this.countryPolys = country;
    this.waterPolys = water;
  }

  async load(path = env.geoIndexPath): Promise<void> {
    const buf = await readFile(path);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint32(0, true) !== MAGIC) throw new Error(`Bad geo index magic in ${path}`);
    const tiles = view.getUint32(8, true);
    if (tiles !== TOTAL_TILES) {
      throw new Error(`geo index has ${tiles} tiles, expected ${TOTAL_TILES} — rebake`);
    }

    const countryBytes = TOTAL_TILES * 2;
    // A Uint16Array view needs 2-byte alignment; Buffer pooling does not
    // guarantee it, so copy rather than view when the offset is odd.
    const base = buf.byteOffset + HEADER_BYTES;
    this.countries =
      base % 2 === 0
        ? new Uint16Array(buf.buffer, base, TOTAL_TILES)
        : new Uint16Array(buf.buffer.slice(base, base + countryBytes));
    this.terrainBits = new Uint8Array(
      buf.buffer,
      base + countryBytes,
      TOTAL_TILES / 4,
    );
    this.loaded = true;
    console.log(`[geo] loaded index: ${(buf.byteLength / 1e6).toFixed(1)} MB`);
  }

  lookup(x: number, y: number): GeoResult {
    if (!this.loaded) {
      // The thin slice runs before the bake exists. Degrade to a documented
      // no-op — International Waters, and land everywhere — so the terrain
      // rule is inert rather than wrong.
      return { countryId: INTERNATIONAL_WATERS_ID, terrain: Terrain.Land };
    }
    this.hits++;

    const tile = tileIdOf(x, y);

    let countryId = this.countries[tile]!;
    if (countryId === MIXED_COUNTRY) countryId = this.countryByPolygon(x, y);

    const bits = unpack2Bit(this.terrainBits, tile);
    const terrain =
      bits === TerrainBits.Mixed
        ? this.terrainFromMask(tile, x, y)
        : bits === TerrainBits.Land
          ? Terrain.Land
          : Terrain.Water;

    return { countryId, terrain };
  }

  /**
   * Exact land/water pixels for one native canvas tile.
   *
   * Almost every tile is uniform, which the baked geo index answers in O(1)
   * and the basemap renderer maps to one shared solid PNG. Only coastline
   * tiles descend through the source polygons to resolve all 256x256 cells.
   */
  terrainTile(tx: number, ty: number): TerrainBits.Land | TerrainBits.Water | Uint8Array {
    if (!this.loaded) return TerrainBits.Land;

    const tile = tx * TILES_PER_AXIS + ty;
    const bits = unpack2Bit(this.terrainBits, tile);
    if (bits === TerrainBits.Land || bits === TerrainBits.Water) return bits;

    return this.waterPolys
      ? rasterizeTile(this.waterPolys, Z_PIXEL, tx, ty, TILE_SIZE)
      : TerrainBits.Land;
  }

  private countryByPolygon(x: number, y: number): number {
    this.countryFallbacks++;
    if (!this.countryPolys) return INTERNATIONAL_WATERS_ID;
    const { lat, lng } = pixelCenterLatLng({ x, y });
    // A miss is not an error: it is genuinely the ocean, which is exactly
    // what the International Waters pseudo-country is for.
    return this.countryPolys.lookup(lng, lat) ?? INTERNATIONAL_WATERS_ID;
  }

  /**
   * Terrain for a pixel in a MIXED (coastal) tile.
   *
   * Resolved lazily PER PIXEL, not per tile. Rasterising the whole 256x256
   * tile up front would amortise nicely in theory, but it costs 65,536
   * point-in-polygon queries on the very first paint that touches a
   * coastline — seconds of latency on a request that must complete in
   * milliseconds. The measured mixed fraction is ~8% of all tiles, so this
   * is a common path, not a rare one.
   *
   * Instead each pixel is computed once and memoised in a per-tile byte
   * array: 0 = not yet known, 1 = land, 2 = water. One PIP per new pixel,
   * free thereafter, and the 64 KB array is only allocated for tiles
   * somebody actually paints on.
   */
  private terrainFromMask(tile: number, x: number, y: number): Terrain {
    let mask = this.maskCache.get(tile);
    if (!mask) {
      mask = new Uint8Array(65536); // all zero: nothing computed yet
      if (this.maskCache.size >= this.maskCacheMax) {
        // FIFO rather than LRU: coastal access is bursty and highly local,
        // so true LRU buys little and costs a Map delete/set on every hit.
        const oldest = this.maskCache.keys().next().value;
        if (oldest !== undefined) this.maskCache.delete(oldest);
      }
      this.maskCache.set(tile, mask);
    }

    const i = (y & 255) * 256 + (x & 255);
    const cached = mask[i]!;
    if (cached !== 0) return cached === 1 ? Terrain.Land : Terrain.Water;

    this.terrainFallbacks++;
    const { lat, lng } = pixelCenterLatLng({ x, y });
    const isWater = this.waterPolys ? this.waterPolys.lookup(lng, lat) !== null : false;
    mask[i] = isWater ? 2 : 1;
    return isWater ? Terrain.Water : Terrain.Land;
  }

  stats() {
    return {
      loaded: this.loaded,
      maskCacheSize: this.maskCache.size,
      hits: this.hits,
      countryFallbacks: this.countryFallbacks,
      terrainFallbacks: this.terrainFallbacks,
      /** Should stay near 1-2%. A rising ratio means the bake is stale. */
      fallbackRate: this.hits ? (this.countryFallbacks / this.hits).toFixed(4) : "0",
    };
  }
}

export const geo = new GeoIndex();
