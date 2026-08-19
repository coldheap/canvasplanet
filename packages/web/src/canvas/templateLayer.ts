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
} from "@canvasplanet/shared";
import { templateColorAt, type TemplatePlacement } from "./templatePixels.js";

// At native zoom there is no room for a per-pixel marker. A deliberately
// lightened/darkened guide colour still makes an unfinished pixel visibly
// change when the correct, clean palette colour lands underneath it.
const GUIDE_RGB = PALETTE_RGB.map(([r, g, b]) => {
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrast = light > 145 ? 0 : 255;
  const mix = 0.32;
  return [
    Math.round(r * (1 - mix) + contrast * mix),
    Math.round(g * (1 - mix) + contrast * mix),
    Math.round(b * (1 - mix) + contrast * mix),
  ] as const;
});

export class TemplateLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Cached unfinished-pixel image used when individual pixels are sub-screen. */
  private preview: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private frame: number | null = null;

  private placement: TemplatePlacement | null = null;
  /** Current canvas colours under the template, same layout as `data`. */
  private actual: Uint8Array | null = null;
  private opacity = 0.85;
  private nextPixel: { x: number; y: number } | null = null;
  private visible = true;

  constructor(private readonly map: L.Map) {
    this.canvas = L.DomUtil.create("canvas", "cp-template-layer") as HTMLCanvasElement;
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.position = "absolute";
    // Above the live overlay so the ghost is visible over freshly painted
    // pixels; the map still receives every click.
    this.canvas.style.zIndex = "450";
    map.getPanes().overlayPane!.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.preview = document.createElement("canvas");
    this.previewCtx = this.preview.getContext("2d")!;

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

  set(placement: TemplatePlacement | null): void {
    this.placement = placement;
    this.actual = null;
    this.nextPixel = null;
    this.rebuildPreview();
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
    this.rebuildPreview();
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
    const index = (y - p.y) * p.w + (x - p.x);
    this.actual[index] = color === ERASED ? TRANSPARENT_INDEX : color;
    this.updatePreviewPixel(index);
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

  /** Required palette colour under a pointer, or null outside painted art. */
  colorAt(x: number, y: number): number | null {
    return templateColorAt(this.placement, x, y);
  }

  private rebuildPreview(): void {
    const p = this.placement;
    if (!p) {
      this.preview.width = 1;
      this.preview.height = 1;
      return;
    }

    this.preview.width = p.w;
    this.preview.height = p.h;
    const image = this.previewCtx.createImageData(p.w, p.h);
    for (let i = 0; i < p.data.length; i++) {
      const want = p.data[i]!;
      if (want === TRANSPARENT_INDEX || (this.actual && this.actual[i] === want)) continue;
      const rgb = GUIDE_RGB[want];
      if (!rgb) continue;
      const offset = i * 4;
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
      image.data[offset + 3] = 255;
    }
    this.previewCtx.putImageData(image, 0, 0);
  }

  private updatePreviewPixel(index: number): void {
    const p = this.placement;
    if (!p) return;
    const x = index % p.w;
    const y = Math.floor(index / p.w);
    const want = p.data[index]!;
    if (want === TRANSPARENT_INDEX || (this.actual && this.actual[index] === want)) {
      this.previewCtx.clearRect(x, y, 1, 1);
      return;
    }
    const rgb = GUIDE_RGB[want];
    if (!rgb) return;
    this.previewCtx.globalAlpha = 1;
    this.previewCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    this.previewCtx.fillRect(x, y, 1, 1);
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

    const origin = this.map.latLngToContainerPoint(
      pixelToLatLng({ x: p.x, y: p.y }) as never,
    );

    if (px < 4) {
      // One cached blit keeps even multi-million-pixel templates visible and
      // responsive while zoomed out. Nearest-neighbour scaling preserves the
      // pixel-art silhouette instead of blurring it into the basemap.
      this.ctx.globalAlpha = this.opacity;
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.preview, origin.x, origin.y, p.w * px, p.h * px);
    } else {
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
          const rgb = px < 6 ? GUIDE_RGB[want] : PALETTE_RGB[want];
          if (!rgb) continue;
          this.ctx.globalAlpha = this.opacity;
          this.ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          this.ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(px), Math.ceil(px));

          // At close zoom, a high-contrast centre marker makes unfinished
          // pixels unmistakable. It disappears the instant the canvas matches
          // the template, leaving the clean target colour behind.
          if (px >= 6) {
            const light = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            const marker = Math.max(2, Math.min(5, Math.floor(px / 4)));
            this.ctx.globalAlpha = Math.min(1, this.opacity + 0.1);
            this.ctx.fillStyle = light > 145 ? "#111827" : "#ffffff";
            this.ctx.fillRect(
              Math.floor(sx + (px - marker) / 2),
              Math.floor(sy + (px - marker) / 2),
              marker,
              marker,
            );
          }
        }
      }
    }
    this.ctx.globalAlpha = 1;

    // Outline the whole template so its edges are unambiguous.
    this.ctx.strokeStyle = "#2563eb";
    this.ctx.lineWidth = px < 1 ? 2 : 1;
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
