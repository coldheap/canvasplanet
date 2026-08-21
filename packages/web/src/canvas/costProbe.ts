/**
 * What a pixel costs, answered locally.
 *
 * `paintCost` needs two facts about a pixel: the colour currently on it and
 * whether it is land or water. Both used to be server-only, so the client
 * asked `/api/pixel` on hover and fell back to COST_BASE for anything it had
 * not hovered. On a phone there is no hover, so *every* paint was priced at
 * the base rate — half the real cost of an overpaint or a terrain violation.
 * The charge bar then drained at half the true speed and the server started
 * refusing paints while the bar still showed charges left. That is the
 * "it stops letting me paint even though I have charge" bug.
 *
 * Both facts are already on screen, though: the canvas tile is a palette
 * image (transparent where unpainted, see tiles/renderer.ts) and the
 * native-grid backdrop is exactly two flat colours, one image pixel per
 * canvas pixel (see basemap/renderer.ts). So instead of asking the network,
 * sample the tiles the map has already downloaded.
 *
 * Decoding is lazy: panning stores an image reference per native tile and
 * costs nothing. The 256x256 read-back only happens the first time a price
 * is asked for inside that tile, and is then cached until a fresh copy of
 * the tile arrives.
 */

import {
  BASEMAP_WATER_COLOR_INDEX,
  PALETTE_RGB,
  TERRAIN_LAND,
  TERRAIN_WATER,
  TILE_SIZE,
  Z_PIXEL,
  type Terrain,
} from "@canvasplanet/shared";

/** Palette index stored for a pixel nobody has painted. */
const UNPAINTED = 255;

/**
 * Native tiles to keep. A phone viewport spans at most a handful at z12 and
 * fewer as you zoom in, so this covers the visible set plus recent panning
 * without pinning much: an image reference is cheap, and at most
 * DECODED_MAX of them ever hold a 64 KB sample array.
 */
const IMAGE_MAX = 32;
const DECODED_MAX = 8;

/** Exact RGB -> palette index, built once. Canvas tiles are palette images. */
const INDEX_BY_RGB = new Map<number, number>(
  PALETTE_RGB.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i]),
);

const WATER_RGB = PALETTE_RGB[BASEMAP_WATER_COLOR_INDEX]!;

/**
 * A decoded backdrop tile. The overwhelming majority of the world is open
 * ocean or inland land, and those tiles are a single flat colour — storing
 * one number for them instead of 65,536 keeps a full viewport of terrain
 * under a kilobyte almost everywhere.
 */
type TerrainTile = Uint8Array | Terrain;

interface Layer<T> {
  images: Map<string, HTMLImageElement>;
  decoded: Map<string, T>;
}

function emptyLayer<T>(): Layer<T> {
  return { images: new Map(), decoded: new Map() };
}

/** Insertion order is eviction order: the oldest key is the one panned away from first. */
function trim(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export class CostProbe {
  private readonly canvas = emptyLayer<Uint8Array>();
  private readonly terrain = emptyLayer<TerrainTile>();

  /** A `/tiles` PNG finished loading. Only the 1:1 level prices a pixel. */
  observeCanvasTile = (z: number, x: number, y: number, img: HTMLImageElement): void => {
    this.observe(this.canvas, z, x, y, img);
  };

  /** A `/basemap/z12` PNG finished loading. */
  observeTerrainTile = (z: number, x: number, y: number, img: HTMLImageElement): void => {
    this.observe(this.terrain, z, x, y, img);
  };

  /**
   * The colour on this pixel: a palette index, `null` when it is unpainted,
   * or `undefined` when no loaded tile can answer.
   */
  colorAt(x: number, y: number): number | null | undefined {
    const tile = this.tileFor(this.canvas, x, y, (rgba) => decodeCanvasTile(rgba));
    if (!tile) return undefined;
    const value = tile[offsetIn(x, y)];
    if (value === undefined) return undefined;
    return value === UNPAINTED ? null : value;
  }

  /** Land or water, or `undefined` when the backdrop tile is not loaded. */
  terrainAt(x: number, y: number): Terrain | undefined {
    const tile = this.tileFor(this.terrain, x, y, (rgba) => decodeTerrainTile(rgba));
    if (tile === undefined) return undefined;
    if (typeof tile === "number") return tile;
    return tile[offsetIn(x, y)] === TERRAIN_WATER ? TERRAIN_WATER : TERRAIN_LAND;
  }

  /** Drop everything. Used when the map is torn down. */
  clear(): void {
    for (const layer of [this.canvas, this.terrain]) {
      layer.images.clear();
      layer.decoded.clear();
    }
  }

  private observe<T>(layer: Layer<T>, z: number, x: number, y: number, img: HTMLImageElement): void {
    if (z !== Z_PIXEL) return;
    const k = key(x, y);
    // Painting rewrites the bytes behind a URL that never changes, so a
    // second load of the same coordinates is a *newer* image, not a repeat.
    layer.decoded.delete(k);
    layer.images.delete(k);
    layer.images.set(k, img);
    trim(layer.images, IMAGE_MAX);
  }

  private tileFor<T>(
    layer: Layer<T>,
    x: number,
    y: number,
    decode: (rgba: Uint8ClampedArray) => T,
  ): T | undefined {
    const k = key(x >> 8, y >> 8);
    const cached = layer.decoded.get(k);
    if (cached !== undefined) return cached;

    const img = layer.images.get(k);
    if (!img || !img.complete || img.naturalWidth === 0) return undefined;

    const rgba = readBack(img);
    if (!rgba) return undefined;

    const tile = decode(rgba);
    layer.decoded.set(k, tile);
    trim(layer.decoded, DECODED_MAX);
    return tile;
  }
}

function key(tx: number, ty: number): string {
  return `${tx}/${ty}`;
}

function offsetIn(x: number, y: number): number {
  return (y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1));
}

/** One shared scratch canvas — a fresh one per tile would churn GPU surfaces. */
let scratch: CanvasRenderingContext2D | null | undefined;

function readBack(img: HTMLImageElement): Uint8ClampedArray | null {
  if (scratch === undefined) {
    const el = document.createElement("canvas");
    el.width = TILE_SIZE;
    el.height = TILE_SIZE;
    scratch = el.getContext("2d", { willReadFrequently: true });
  }
  if (!scratch) return null;
  try {
    scratch.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    scratch.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
    return scratch.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  } catch {
    // A deployment serving tiles from another origin without CORS taints the
    // canvas. Pricing falls back to the conservative reserve rather than
    // throwing on every hover.
    return null;
  }
}

function decodeCanvasTile(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(UNPAINTED);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    // Unpainted pixels are fully transparent by design, and the renderer
    // never emits partial alpha, so this single test covers "not painted".
    if (rgba[o + 3] !== 255) continue;
    const index = INDEX_BY_RGB.get((rgba[o]! << 16) | (rgba[o + 1]! << 8) | rgba[o + 2]!);
    if (index !== undefined) out[i] = index;
  }
  return out;
}

function decodeTerrainTile(rgba: Uint8ClampedArray): TerrainTile {
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE);
  let water = 0;
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    // The backdrop is two flat colours with no antialiasing, so an exact
    // match on the water shade is enough; everything else is land.
    const isWater =
      rgba[o] === WATER_RGB[0] && rgba[o + 1] === WATER_RGB[1] && rgba[o + 2] === WATER_RGB[2];
    if (isWater) {
      out[i] = TERRAIN_WATER;
      water++;
    } else {
      out[i] = TERRAIN_LAND;
    }
  }
  if (water === 0) return TERRAIN_LAND;
  if (water === out.length) return TERRAIN_WATER;
  return out;
}
