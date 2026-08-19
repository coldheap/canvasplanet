/**
 * Zoom-out heatmap overlay: paint density instead of colour.
 *
 * The server encodes each tile as pure greyscale+alpha (see the server's
 * tiles/renderer.ts for why — colour cannot survive the mipmap's
 * alpha-weighted averaging as a meaningful scalar, greyscale can). This
 * layer is what turns that scalar back into a colour ramp, once the whole
 * pyramid has already been downsampled server-side.
 */

import L from "leaflet";
import { Z_PIXEL } from "@canvasplanet/shared";

/** [t, r, g, b] stops, t ascending 0..1. Cool for sparse activity, hot for dense. */
const STOPS: Array<[number, number, number, number]> = [
  [0.0, 37, 99, 235], // blue
  [0.35, 16, 185, 129], // teal
  [0.65, 250, 204, 21], // yellow
  [1.0, 239, 68, 68], // red
];

function rampColor(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, r1, g1, b1] = STOPS[i - 1]!;
    const [t2, r2, g2, b2] = STOPS[i]!;
    if (t <= t2) {
      const f = t2 === t1 ? 0 : (t - t1) / (t2 - t1);
      return [Math.round(r1 + (r2 - r1) * f), Math.round(g1 + (g2 - g1) * f), Math.round(b1 + (b2 - b1) * f)];
    }
  }
  const [, r, g, b] = STOPS[STOPS.length - 1]!;
  return [r, g, b];
}

const HeatGridLayer = L.GridLayer.extend({
  createTile(coords: L.Coords, done: (err: Error | null, tile: HTMLElement) => void) {
    const canvas = L.DomUtil.create("canvas") as HTMLCanvasElement;
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 256, 256);
      try {
        const frame = ctx.getImageData(0, 0, 256, 256);
        const d = frame.data;
        for (let i = 0; i < d.length; i += 4) {
          // Server writes R=G=B=A=intensity; alpha is as good a read as any.
          const v = d[i + 3]!;
          if (v === 0) continue;
          const [r, g, b] = rampColor(v / 255);
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          // Floor the alpha so faint activity is still visible against the
          // basemap rather than reading as "nothing here".
          d[i + 3] = Math.min(255, 110 + v);
        }
        ctx.putImageData(frame, 0, 0);
      } catch {
        // Same-origin in every deployment this runs in; a getImageData
        // failure here would mean a CSP or origin change, not bad data.
      }
      done(null, canvas);
    };
    img.onerror = () => done(null, canvas); // blank tile beats a broken one
    img.src = `/tiles/z${Z_PIXEL}/heat/${Math.min(coords.z, Z_PIXEL)}/${coords.x}/${coords.y}.png`;

    return canvas;
  },
}) as unknown as new (opts: L.GridLayerOptions) => L.GridLayer;

export function createHeatLayer(): L.GridLayer {
  return new HeatGridLayer({
    maxNativeZoom: Z_PIXEL,
    className: "cp-heat-layer",
    keepBuffer: 1,
    updateWhenZooming: false,
    opacity: 0.85,
  });
}
