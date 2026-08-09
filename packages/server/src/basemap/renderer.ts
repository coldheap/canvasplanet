import { PNG } from "pngjs";
import { TILE_SIZE } from "@worldcanvas/shared";
import { TerrainBits } from "../geo/bake.js";
import { geo } from "../geo/index.js";

/** Matches the existing pre-baked basemap exactly. */
export const WATER_RGB = [170, 211, 223] as const;
export const LAND_RGB = [242, 239, 233] as const;

const LRU_MAX = 500;
const lru = new Map<string, Buffer>();

export function encodeTerrainTile(terrain: TerrainBits.Land | TerrainBits.Water | Uint8Array): Buffer {
  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    const value = typeof terrain === "number" ? terrain : terrain[i]!;
    const rgb = value === TerrainBits.Water ? WATER_RGB : LAND_RGB;
    const o = i * 4;
    png.data[o] = rgb[0];
    png.data[o + 1] = rgb[1];
    png.data[o + 2] = rgb[2];
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

// Uniform tiles make up almost the whole world and all share these two
// buffers, so they consume no per-coordinate cache entries.
const LAND_TILE = encodeTerrainTile(TerrainBits.Land);
const WATER_TILE = encodeTerrainTile(TerrainBits.Water);

/** Render the land/ocean map on the exact same 256x256 grid as paint pixels. */
export function renderPixelBasemapTile(tx: number, ty: number): Buffer {
  const key = `${tx}/${ty}`;
  const cached = lru.get(key);
  if (cached) {
    lru.delete(key);
    lru.set(key, cached);
    return cached;
  }

  const terrain = geo.terrainTile(tx, ty);
  if (terrain === TerrainBits.Land) return LAND_TILE;
  if (terrain === TerrainBits.Water) return WATER_TILE;

  const rendered = encodeTerrainTile(terrain);
  lru.set(key, rendered);
  if (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
  return rendered;
}
