/**
 * The live-delta overlay.
 *
 * The `/tiles` TileLayer is authoritative but lags a paint by up to ~2s,
 * because the tile worker debounces (a hot tile taking 100 paints in two
 * seconds re-renders once). Without something covering that window, every
 * paint would visibly appear two seconds late — the debounce would be the
 * user-facing latency.
 *
 * So: a transparent canvas above the tile layer holds every pixel received
 * over WebSocket since that pixel's tile was last rendered. Once those
 * pixels have aged past the tile worker's normal render window, the overlay
 * asks the Leaflet layer to reload. A pending pixel is removed only after the
 * loaded PNG is inspected and shown to contain that exact colour.
 *
 * The image check is important: a time-to-live used to delete pixels after
 * 15 seconds whether or not a fresh tile had arrived. A stale browser/edge
 * tile then made paint disappear until a zoom fetched a newer image.
 *
 * The same canvas draws the optional "highlight new pixels" rings, because it
 * already receives every incoming pixel and already sits directly above the
 * tiles. The two sets only share a frame, though: a pending pixel lives until
 * its tile proves it, a ring for a fixed 1.5s, so they are tracked apart.
 */

import L from "leaflet";
import { ERASED, PALETTE, TILE_SIZE, WORLD_SIZE, Z_PIXEL, pixelToLatLng } from "@canvasplanet/shared";
import { livePixelScreenSize } from "./livePixels.js";
import { PixelHighlights, highlightAlpha, highlightRingWidth } from "./pixelHighlights.js";
import { tilePixelMatches } from "./tilePixels.js";

interface PendingPixel {
  x: number;
  y: number;
  color: number;
  at: number;
}

/** Give the debounced tile worker time to render before asking for the PNG. */
const REFRESH_AFTER_MS = 5_000;
/** A stale edge response or a busy worker should not cause a request storm. */
const REFRESH_RETRY_MS = 5_000;
/** The ring itself, and the darker stroke that keeps it legible over red. */
const HIGHLIGHT_RING = "#FF2D2D";
const HIGHLIGHT_EDGE = "rgba(24, 0, 6, 0.8)";

export class LiveOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pending = new Map<number, PendingPixel>();
  private frame: number | null = null;
  private refreshTimer: number;
  private lastRefreshAt = 0;
  private visible = true;
  private highlights = new PixelHighlights();
  /** Off by default, and never switched on by the embed. */
  private highlightsOn = false;

  constructor(
    private readonly map: L.Map,
    private readonly refreshTiles: () => void,
  ) {
    this.canvas = L.DomUtil.create("canvas", "cp-live-overlay") as HTMLCanvasElement;
    // Clicks must reach the map underneath — this layer is purely visual.
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.position = "absolute";
    map.getPanes().overlayPane!.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resize();
    map.on("move", this.reposition);
    map.on("resize zoomend", this.onResize);
    // Leaflet's zoom animation transforms the pane under us. Rather than
    // reimplement that transform, hide for the ~250ms it runs; the tile
    // layer is doing the same thing and the result reads as one motion.
    map.on("zoomstart", this.hide);
    map.on("zoomend", this.show);

    this.refreshTimer = window.setInterval(() => this.refreshStaleTiles(), 1_000);
  }

  destroy(): void {
    this.map.off("move", this.reposition);
    this.map.off("resize zoomend", this.onResize);
    this.map.off("zoomstart", this.hide);
    this.map.off("zoomend", this.show);
    window.clearInterval(this.refreshTimer);
    this.canvas.remove();
  }

  /**
   * Pixels arriving over WebSocket, and the local optimistic paint.
   *
   * `source` only decides whether a highlight ring is drawn: "self" is your
   * own optimistic paint, remembered so that the copy the hub echoes back to
   * you is not mistaken for someone else showing up.
   */
  add(pixels: Array<[number, number, number]>, source: "live" | "self" = "live"): void {
    const at = Date.now();
    for (const [x, y, color] of pixels) {
      // A revert is not a placement, so it never gets a ring.
      if (this.highlightsOn && color !== ERASED) {
        if (source === "self") this.highlights.markSelf(x, y, color, at);
        else this.highlights.record(x, y, color, at);
      }
      if (color === ERASED) {
        // A revert deleted this pixel. Dropping it from the overlay is not
        // sufficient on its own — the tile underneath still shows the old
        // colour until it refreshes — but the revert dirties that tile too,
        // so together the pixel stops lingering on screen.
        this.pending.delete(key(x, y));
        continue;
      }
      this.pending.set(key(x, y), { x, y, color, at });
    }
    this.schedule();
  }

  /** Roll back a single optimistic pixel after the server refused the paint. */
  remove(x: number, y: number): void {
    this.pending.delete(key(x, y));
    // No echo is coming for a refused paint, so release the claim on this
    // pixel — otherwise the next person to paint it inherits the suppression.
    this.highlights.forgetSelf(x, y);
    this.schedule();
  }

  /** The "highlight new pixels" setting. Off drops the tracking as well as the
   *  drawing, so a session that does not want rings pays nothing for them on a
   *  canvas taking hundreds of paints a second. */
  setHighlights(on: boolean): void {
    if (on === this.highlightsOn) return;
    this.highlightsOn = on;
    if (!on) this.highlights.clear();
    this.schedule();
  }

  /** History mode keeps receiving live deltas but must not display them over
   *  the selected past state. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.visibility = visible ? "visible" : "hidden";
    if (visible) this.schedule();
  }

  /**
   * A native tile's PNG just loaded. Only drop pending pixels whose exact
   * palette colour is present in that image. Merely receiving `tileload` is
   * not proof of freshness: the browser or edge can legally return an older
   * cached image while the dirty-tile worker is still catching up.
   */
  confirmTile(z: number, tx: number, ty: number, tile: HTMLElement): void {
    if (z !== Z_PIXEL) return; // only the 1:1 level bakes individual pixels
    if (!(tile instanceof HTMLImageElement)) return;

    const x0 = tx * TILE_SIZE;
    const y0 = ty * TILE_SIZE;
    const candidates: Array<[number, PendingPixel]> = [];
    for (const entry of this.pending) {
      const pixel = entry[1];
      if (
        pixel.x >= x0 &&
        pixel.x < x0 + TILE_SIZE &&
        pixel.y >= y0 &&
        pixel.y < y0 + TILE_SIZE
      ) {
        candidates.push(entry);
      }
    }
    // Most initial/navigation tile loads have no live pixels to hand off.
    // Avoid decoding and reading back those images altogether.
    if (candidates.length === 0) return;

    const sample = document.createElement("canvas");
    sample.width = TILE_SIZE;
    sample.height = TILE_SIZE;
    const ctx = sample.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    let rgba: Uint8ClampedArray;
    try {
      ctx.drawImage(tile, 0, 0, TILE_SIZE, TILE_SIZE);
      rgba = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    } catch {
      // A deployment that serves tiles from another origin without CORS can
      // taint the image. Keeping the overlay is safer than hiding valid paint.
      return;
    }

    let changed = false;
    for (const [k, pixel] of candidates) {
      if (tilePixelMatches(rgba, pixel.x - x0, pixel.y - y0, pixel.color)) {
        this.pending.delete(k);
        changed = true;
      }
    }
    if (changed) this.schedule();
  }

  private refreshStaleTiles = (): void => {
    if (!this.visible || this.pending.size === 0) return;
    // Lower zooms load downsampled parent tiles, which cannot prove the state
    // of one native pixel. Keep drawing the overlay and wait until z12+.
    if (this.map.getZoom() < Z_PIXEL) return;
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_RETRY_MS) return;

    const size = this.map.getSize();
    const staleVisible = [...this.pending.values()].some((pixel) => {
      if (now - pixel.at < REFRESH_AFTER_MS) return false;
      const p = this.map.latLngToContainerPoint(pixelToLatLng({ x: pixel.x, y: pixel.y }) as never);
      return p.x >= 0 && p.y >= 0 && p.x <= size.x && p.y <= size.y;
    });
    if (!staleVisible) return;

    this.lastRefreshAt = now;
    this.refreshTiles();
  };

  private hide = (): void => {
    this.canvas.style.visibility = "hidden";
  };

  private show = (): void => {
    this.canvas.style.visibility = this.visible ? "visible" : "hidden";
    if (this.visible) this.schedule();
  };

  private onResize = (): void => {
    this.resize();
    this.schedule();
  };

  private resize(): void {
    const size = this.map.getSize();
    // Match the backing store to the device pixel ratio, or the pixels come
    // out soft on a retina display — which defeats the point of pixel art.
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.reposition();
  }

  /** Keep the canvas pinned to the viewport as the map pans beneath it. */
  private reposition = (): void => {
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));
    this.schedule();
  };

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  private draw(): void {
    const size = this.map.getSize();
    this.ctx.clearRect(0, 0, size.x, size.y);
    const now = Date.now();
    this.highlights.prune(now);
    if (this.pending.size === 0 && this.highlights.size === 0) return;

    const zoom = this.map.getZoom();
    // Below the native grid zoom, a world pixel occupies only a fraction of
    // one screen pixel. Drawing each live delta as a forced 1px dot makes
    // distant paint look randomly scattered and grows expensive on a busy
    // canvas. The raster pyramid is the correct aggregate at those zooms.
    const pxSize = livePixelScreenSize(zoom);
    if (pxSize === 0) return;

    for (const pixel of this.pending.values()) {
      const p = this.map.latLngToContainerPoint(pixelToLatLng({ x: pixel.x, y: pixel.y }) as never);
      // Cull offscreen work: at z18 a full viewport is only a few hundred
      // pixels, but a stale pending set can be much larger.
      if (p.x < -pxSize || p.y < -pxSize || p.x > size.x || p.y > size.y) continue;
      this.ctx.fillStyle = PALETTE[pixel.color]?.hex ?? "#ff00ff";
      // Floor the origin and ceil the size so adjacent pixels never leave a
      // sub-pixel seam between them.
      this.ctx.fillRect(Math.floor(p.x), Math.floor(p.y), Math.ceil(pxSize), Math.ceil(pxSize));
    }

    this.drawHighlights(size, pxSize, now);

    // A fade needs frames nothing else is asking for. Every mark expires and
    // prune() drops it, so this reschedules only while rings are alive.
    if (this.highlights.size > 0) this.schedule();
  }

  /**
   * The "highlight new pixels" rings, drawn after the pending fill so a marker
   * never covers the paint it is pointing at.
   */
  private drawHighlights(size: L.Point, pxSize: number, now: number): void {
    if (this.highlights.size === 0) return;

    const width = highlightRingWidth(pxSize);
    // Inset the stroked path by the full width of the wider stroke, so both
    // strokes land outside the pixel instead of over it. At z12, where a world
    // pixel is one screen pixel, that is the difference between a marker that
    // frames the paint and one that replaces it.
    const spread = width * 2;
    const side = Math.ceil(pxSize);
    for (const mark of this.highlights.values()) {
      const alpha = highlightAlpha(now - mark.at);
      if (alpha <= 0) continue;
      const p = this.map.latLngToContainerPoint(pixelToLatLng({ x: mark.x, y: mark.y }) as never);
      if (
        p.x < -pxSize - spread ||
        p.y < -pxSize - spread ||
        p.x > size.x + spread ||
        p.y > size.y + spread
      ) {
        continue;
      }

      const x = Math.floor(p.x) - spread / 2;
      const y = Math.floor(p.y) - spread / 2;
      this.ctx.globalAlpha = alpha;
      // Dark underneath, red over it. A bare red ring disappears against the
      // palette's own reds and against a dark stretch of canvas; the darker
      // stroke around it keeps the marker readable over anything.
      this.ctx.lineWidth = spread;
      this.ctx.strokeStyle = HIGHLIGHT_EDGE;
      this.ctx.strokeRect(x, y, side + spread, side + spread);
      this.ctx.lineWidth = width;
      this.ctx.strokeStyle = HIGHLIGHT_RING;
      this.ctx.strokeRect(x, y, side + spread, side + spread);
    }
    this.ctx.globalAlpha = 1;
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Pack a pixel into one collision-free integer key for the configured world. */
function key(x: number, y: number): number {
  return x * WORLD_SIZE + y;
}
