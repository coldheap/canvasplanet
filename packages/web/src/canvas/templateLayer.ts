/**
 * The template ghost: a translucent image aligned to the pixel grid, drawn
 * over the canvas so you paint straight onto it.
 *
 * Aligned to the grid rather than to arbitrary lat/lng — a template that is
 * half a pixel out is worse than useless, because every pixel you place looks
 * almost right and is wrong.
 *
 * Also highlights the next unpainted pixel, which is what turns "a picture to
 * copy" into something you can work through without counting squares.
 */

import L from "leaflet";
import {
  ERASED,
  PALETTE_RGB,
  TRANSPARENT_INDEX,
  Z_PIXEL,
  pixelToLatLng,
} from "@worldcanvas/shared";

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** One palette index per pixel, TRANSPARENT_INDEX for "skip". */
  data: Uint8Array;
}

export class TemplateLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frame: number | null = null;

  private placement: Placement | null = null;
  /** Current canvas colours under the template, same layout as `data`. */
  private actual: Uint8Array | null = null;
  private opacity = 0.5;
  private nextPixel: { x: number; y: number } | null = null;
  private visible = true;

  constructor(private readonly map: L.Map) {
    this.canvas = L.DomUtil.create("canvas", "wc-template-layer") as HTMLCanvasElement;
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.position = "absolute";
    // Above the live overlay so the ghost is visible over freshly painted
    // pixels; the map still receives every click.
    this.canvas.style.zIndex = "450";
    map.getPanes().overlayPane!.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resize();
    map.on("move", this.reposition);
    map.on("resize zoomend", this.onResize);
    map.on("zoomstart", this.hide);
    map.on("zoomend", this.show);
  }

  destroy(): void {
    this.map.off("move", this.reposition);
    this.map.off("resize zoomend", this.onResize);
    this.map.off("zoomstart", this.hide);
    this.map.off("zoomend", this.show);
    this.canvas.remove();
  }

  set(placement: Placement | null): void {
    this.placement = placement;
    this.actual = null;
    this.nextPixel = null;
    this.schedule();
  }

  setOpacity(value: number): void {
    this.opacity = value;
    this.schedule();
  }

  /** Hide current-state guidance while the map is showing a past state. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.visibility = visible ? "visible" : "hidden";
    if (visible) this.schedule();
  }

  /** Current canvas state under the template, from /api/region. */
  setActual(actual: Uint8Array | null): void {
    this.actual = actual;
    this.recomputeNext();
    this.schedule();
  }

  /** Apply a live paint so progress tracks without refetching the region. */
  applyPaint(x: number, y: number, color: number): boolean {
    const p = this.placement;
    if (!p || !this.actual) return false;
    if (x < p.x || y < p.y || x >= p.x + p.w || y >= p.y + p.h) return false;
    // An erase means the pixel is unpainted again, not that it is now
    // colour 255 — which would otherwise read as "done" for a template
    // pixel that is genuinely still to do.
    this.actual[(y - p.y) * p.w + (x - p.x)] = color === ERASED ? TRANSPARENT_INDEX : color;
    this.recomputeNext();
    this.schedule();
    return true;
  }

  progress(): { done: number; total: number } {
    const p = this.placement;
    if (!p) return { done: 0, total: 0 };
    let done = 0;
    let total = 0;
    for (let i = 0; i < p.data.length; i++) {
      const want = p.data[i]!;
      if (want === TRANSPARENT_INDEX) continue;
      total++;
      if (this.actual && this.actual[i] === want) done++;
    }
    return { done, total };
  }

  /** First pixel, in reading order, that does not yet match the template. */
  private recomputeNext(): void {
    const p = this.placement;
    if (!p || !this.actual) {
      this.nextPixel = null;
      return;
    }
    for (let i = 0; i < p.data.length; i++) {
      const want = p.data[i]!;
      if (want === TRANSPARENT_INDEX) continue;
      if (this.actual[i] !== want) {
        this.nextPixel = { x: p.x + (i % p.w), y: p.y + Math.floor(i / p.w) };
        return;
      }
    }
    this.nextPixel = null;
  }

  getNextPixel(): { x: number; y: number } | null {
    return this.nextPixel;
  }

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
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.reposition();
  }

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
    const p = this.placement;
    if (!p) return;

    const zoom = this.map.getZoom();
    const px = 2 ** (zoom - Z_PIXEL);
    // Below one screen pixel per canvas pixel the ghost is unreadable and
    // just muddies the map, so it hides itself rather than becoming noise.
    if (px < 1) return;

    const origin = this.map.latLngToContainerPoint(
      pixelToLatLng({ x: p.x, y: p.y }) as never,
    );

    this.ctx.globalAlpha = this.opacity;
    for (let row = 0; row < p.h; row++) {
      // Cull rows outside the viewport before touching their pixels.
      const sy = origin.y + row * px;
      if (sy + px < 0 || sy > size.y) continue;
      for (let col = 0; col < p.w; col++) {
        const want = p.data[row * p.w + col]!;
        if (want === TRANSPARENT_INDEX) continue;
        // Already correct on the canvas: do not ghost over it, so what is
        // left to do is what you see.
        if (this.actual && this.actual[row * p.w + col] === want) continue;

        const sx = origin.x + col * px;
        if (sx + px < 0 || sx > size.x) continue;
        const rgb = PALETTE_RGB[want];
        if (!rgb) continue;
        this.ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        this.ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(px), Math.ceil(px));
      }
    }
    this.ctx.globalAlpha = 1;

    // Outline the whole template so its edges are unambiguous.
    this.ctx.strokeStyle = "#2563eb";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(
      Math.floor(origin.x) + 0.5,
      Math.floor(origin.y) + 0.5,
      Math.ceil(p.w * px),
      Math.ceil(p.h * px),
    );

    // And ring the next pixel to place.
    if (this.nextPixel && px >= 2) {
      const n = this.map.latLngToContainerPoint(
        pixelToLatLng({ x: this.nextPixel.x, y: this.nextPixel.y }) as never,
      );
      this.ctx.strokeStyle = "#111827";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(Math.floor(n.x) - 1, Math.floor(n.y) - 1, px + 2, px + 2);
    }
  }
}
