/**
 * Pixel-exact tile layer for the painted canvas and its native-grid backdrop.
 *
 * Leaflet's built-in overzoom (`maxNativeZoom`) keeps serving the z12 PNG and
 * magnifies it by putting `transform: scale(N)` on the tile *container*. At
 * z18 that is scale(64): one 256px tile is asked to cover 16384 CSS px, which
 * on a 3x phone is 49152 device pixels of texture for a single tile. Past the
 * GPU's texture limit the compositor rasterises at a reduced scale and
 * bilinear-upsamples the result, and WebKit additionally drops the
 * `image-rendering: pixelated` hint when the magnification comes from an
 * ancestor transform rather than the element's own box. Either way the art
 * turns to mush — on phones first, because the device pixel ratio is what
 * pushes the texture past the limit.
 *
 * So we do the overzoom ourselves: every zoom gets real tiles, each one a
 * canvas that crops its parent z12 PNG and blits the crop with
 * `imageSmoothingEnabled = false`. The container transform stays at scale 1,
 * textures stay one screen-tile big, and nearest-neighbour sampling becomes
 * explicit 2D-canvas work that every engine performs identically.
 */

import L from "leaflet";
import { TILE_SIZE, Z_PIXEL } from "@canvasplanet/shared";

export interface PixelTileLayerOptions extends L.GridLayerOptions {
  /** Tile template containing {z}/{x}/{y}. Only ever requested at z <= Z_PIXEL. */
  url: string;
  /**
   * Fired once per decoded native tile — not once per screen tile, which when
   * overzoomed would repeat the same image up to 4096 times. Lets the live
   * overlay reconcile pending paint against what the server actually rendered.
   */
  onNativeTile?: (z: number, x: number, y: number, img: HTMLImageElement) => void;
}

type Parent = Promise<HTMLImageElement | null>;

/** The GridLayer internals this subclass chains up to, which the types omit. */
const base = L.GridLayer.prototype as unknown as {
  initialize(options: unknown): void;
  _removeTile(key: string): void;
};

/** Tile canvases Leaflet has discarded, flagged so late blits can bail out. */
type TileCanvas = HTMLCanvasElement & { _cpRetired?: true };

/**
 * Decoded parents held only while overzoomed, where one image serves many
 * screen tiles. At native zoom the mapping is 1:1, so a cache would just pin
 * bitmaps the browser is better at managing. Bounded because panning would
 * otherwise accumulate a megabyte of RGBA per four tiles visited.
 */
const PARENT_CACHE_MAX = 32;

const PixelGridLayer = L.GridLayer.extend({
  initialize(this: any, options: PixelTileLayerOptions) {
    base.initialize.call(this, options);
    this._parents = new Map<string, Parent>();
  },

  /** Swap the tile source (history playback) and drop anything from the old one. */
  setUrl(this: any, url: string): void {
    this.options.url = url;
    this._parents.clear();
    L.GridLayer.prototype.redraw.call(this);
  },

  redraw(this: any) {
    // Painting changes the bytes behind a URL that never changes, so a redraw
    // has to forget decoded parents or it would re-blit stale art. The tile
    // route is `max-age=0` + ETag, so the refetch is a cheap revalidation.
    this._parents.clear();
    return L.GridLayer.prototype.redraw.call(this);
  },

  onRemove(this: any, map: L.Map) {
    this._parents.clear();
    return L.GridLayer.prototype.onRemove.call(this, map);
  },

  /**
   * Leaflet recycles a key the instant a tile is dropped, so a parent that
   * resolves after its tile was discarded would otherwise call done() for the
   * *replacement* tile and mark it loaded before anything is drawn into it —
   * a blank flash on every redraw, and redraw runs on every paint. L.TileLayer
   * neuters the same race by blanking the img's src; canvases need a flag.
   */
  _removeTile(this: any, key: string) {
    const tile = this._tiles[key];
    if (tile) (tile.el as TileCanvas)._cpRetired = true;
    return base._removeTile.call(this, key);
  },

  _load(this: any, z: number, x: number, y: number): Parent {
    // The history layer exists before a timestamp is chosen. An empty src
    // resolves to the page itself, so answer with an empty tile instead.
    if (!this.options.url) return Promise.resolve(null);
    return new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.options.onNativeTile?.(z, x, y, img);
        resolve(img);
      };
      // A missing or broken tile is empty canvas, not an error worth showing.
      img.onerror = () => resolve(null);
      img.src = (this.options.url as string)
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));
    });
  },

  /** The native tile containing `coords`, decoded and ready to blit. */
  _parent(this: any, z: number, x: number, y: number, shared: boolean): Parent {
    if (!shared) return this._load(z, x, y);

    const key = `${z}/${x}/${y}`;
    const cached = this._parents.get(key) as Parent | undefined;
    if (cached) return cached;

    const pending = this._load(z, x, y) as Parent;
    if (this._parents.size >= PARENT_CACHE_MAX) {
      // Insertion order is eviction order: the oldest key is the one the
      // viewport moved away from first.
      const oldest = this._parents.keys().next();
      if (!oldest.done) this._parents.delete(oldest.value);
    }
    this._parents.set(key, pending);
    return pending;
  },

  createTile(this: any, coords: L.Coords, done: (err: Error | null, tile: HTMLElement) => void) {
    const size = this.getTileSize();
    const canvas = L.DomUtil.create("canvas") as TileCanvas;

    // Back the tile at device resolution so one world pixel lands on a whole
    // number of screen pixels. Leaflet sizes the CSS box to `size` for us, so
    // the bitmap maps 1:1 onto the display and nothing rescales it afterwards.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);

    // How far past the native grid this tile sits, and which crop of its
    // parent it shows. `over <= 0` is the native or downsampled case, where
    // the whole parent maps onto the whole tile.
    const over = coords.z - Z_PIXEL;
    const nativeZ = Math.min(coords.z, Z_PIXEL);
    const span = over > 0 ? 2 ** over : 1;
    const px = Math.floor(coords.x / span);
    const py = Math.floor(coords.y / span);
    const src = TILE_SIZE / span;
    const sx = (coords.x - px * span) * src;
    const sy = (coords.y - py * span) * src;

    this._parent(nativeZ, px, py, over > 0).then((img: HTMLImageElement | null) => {
      if (canvas._cpRetired) return;
      if (img) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, sx, sy, src, src, 0, 0, canvas.width, canvas.height);
        }
      }
      done(null, canvas);
    });

    return canvas;
  },
}) as unknown as new (options: PixelTileLayerOptions) => PixelTileLayer;

export type PixelTileLayer = L.GridLayer & { setUrl(url: string): void };

export function createPixelTileLayer(options: PixelTileLayerOptions): PixelTileLayer {
  return new PixelGridLayer(options);
}
