import { Z_PIXEL } from "@canvasplanet/shared";

/** Screen size of one native pixel; zero means use raster tiles only. */
export function livePixelScreenSize(zoom: number): number {
  return zoom < Z_PIXEL ? 0 : 2 ** (zoom - Z_PIXEL);
}

/** A rectangle in whole device pixels, ready to fill on an untransformed canvas. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One live pixel's rectangle, in whole device pixels.
 *
 * The overlay fills integer CSS coordinates, which is exact only while the
 * device pixel ratio is a whole number. A phone reporting 2.625 — Pixel-class
 * Android, or any device once the browser's page zoom is not 100% — turns an
 * integer CSS coordinate into a fractional device one (100 * 2.625 = 262.5),
 * so every edge antialiases and is stored at partial alpha. Two neighbouring
 * pixels then each cover half of the device pixel they share and composite to
 * around three-quarters alpha, and the tile underneath shows through the seam
 * as a hairline of whatever colour was there before the paint.
 *
 * Rounding both edges onto the device grid removes it, and neighbours still
 * meet exactly: this pixel's far edge is the same expression as the next
 * one's near edge, so the two round identically.
 */
export function livePixelRect(x: number, y: number, pxSize: number, dpr: number): ScreenRect {
  const x0 = Math.round(x * dpr);
  const y0 = Math.round(y * dpr);
  const x1 = Math.round((x + pxSize) * dpr);
  const y1 = Math.round((y + pxSize) * dpr);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
