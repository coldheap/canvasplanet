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
 * over WebSocket since that pixel's tile was last rendered. When the tile's
 * PNG reloads, the pixels inside it are dropped from the overlay and the two
 * layers agree again. Net visible latency is the WebSocket round trip.
 *
 * Pixels also expire on a safety TTL, so a tile that never reloads (offscreen,
 * cached hard, worker wedged) cannot leave the overlay permanently diverged
 * from the canvas underneath it.
 */

import L from "leaflet";
import { ERASED, PALETTE, WORLD_SIZE, Z_PIXEL, pixelToLatLng } from "@worldcanvas/shared";

interface PendingPixel {
  x: number;
  y: number;
  color: number;
  at: number;
}

/** Longer than the tile worker interval plus a render, with margin. */
const TTL_MS = 15_000;

export class LiveOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pending = new Map<number, PendingPixel>();
  private frame: number | null = null;
  private sweepTimer: number;
  private visible = true;

  constructor(private readonly map: L.Map) {
    this.canvas = L.DomUtil.create("canvas", "wc-live-overlay") as HTMLCanvasElement;
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

    this.sweepTimer = window.setInterval(() => this.sweep(), 5_000);
  }

  destroy(): void {
    this.map.off("move", this.reposition);
    this.map.off("resize zoomend", this.onResize);
    this.map.off("zoomstart", this.hide);
    this.map.off("zoomend", this.show);
    window.clearInterval(this.sweepTimer);
    this.canvas.remove();
  }

  /** Pixels arriving over WebSocket, and the local optimistic paint. */
  add(pixels: Array<[number, number, number]>): void {
    const at = Date.now();
    for (const [x, y, color] of pixels) {
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
   * A tile's PNG just reloaded, so every pixel inside it that predates the
   * load is now baked into the tile underneath. Dropping them here is what
   * keeps the overlay small and stops it drifting out of sync.
   */
  clearTile(z: number, tx: number, ty: number, loadStartedAt: number): void {
    if (z !== Z_PIXEL) return; // only the 1:1 level bakes individual pixels
    const x0 = tx * 256;
    const y0 = ty * 256;
    let changed = false;
    for (const [k, pixel] of this.pending) {
      if (
        pixel.at <= loadStartedAt &&
        pixel.x >= x0 &&
        pixel.x < x0 + 256 &&
        pixel.y >= y0 &&
        pixel.y < y0 + 256
      ) {
        this.pending.delete(k);
        changed = true;
      }
    }
    if (changed) this.schedule();
  }

  private sweep = (): void => {
    const cutoff = Date.now() - TTL_MS;
    let changed = false;
    for (const [k, pixel] of this.pending) {
      if (pixel.at < cutoff) {
        this.pending.delete(k);
        changed = true;
      }
    }
    if (changed) this.schedule();
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
    if (this.pending.size === 0) return;

    const zoom = this.map.getZoom();
    // One grid pixel is 2^(zoom-Z_PIXEL) screen pixels. Below Z_PIXEL that is
    // fractional; clamp so a pixel never renders as nothing.
    const pxSize = Math.max(1, 2 ** (zoom - Z_PIXEL));

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
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Pack a pixel into one collision-free integer key for the configured world. */
function key(x: number, y: number): number {
  return x * WORLD_SIZE + y;
}
