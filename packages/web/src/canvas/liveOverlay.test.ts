import { PALETTE_RGB, TILE_SIZE } from "@canvasplanet/shared";
import { describe, expect, it } from "vitest";
import { livePixelRect, livePixelScreenSize } from "./livePixels.js";
import { tilePixelMatches } from "./tilePixels.js";

describe("tilePixelMatches", () => {
  it("confirms a pending pixel only when the loaded tile contains its exact colour", () => {
    const rgba = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    const x = 17;
    const y = 29;
    const color = 7;
    const offset = (y * TILE_SIZE + x) * 4;
    const [r, g, b] = PALETTE_RGB[color]!;
    rgba.set([r, g, b, 255], offset);

    expect(tilePixelMatches(rgba, x, y, color)).toBe(true);
    expect(tilePixelMatches(rgba, x, y, color + 1)).toBe(false);
    expect(tilePixelMatches(rgba, x + 1, y, color)).toBe(false);
  });
});

describe("livePixelScreenSize", () => {
  it("leaves sub-pixel paints to the raster pyramid below native zoom", () => {
    expect(livePixelScreenSize(10)).toBe(0);
    expect(livePixelScreenSize(11)).toBe(0);
  });

  it("draws exact live pixels at native zoom and above", () => {
    expect(livePixelScreenSize(12)).toBe(1);
    expect(livePixelScreenSize(15)).toBe(8);
  });
});

describe("livePixelRect", () => {
  // The overlay canvas carries a setTransform(dpr, ...), so filling integer
  // CSS coordinates is exact only while dpr is whole. At 2.625 an integer CSS
  // coordinate is a fractional device one, the edge antialiases, and the tile
  // shows through the seam between two pending pixels.
  const FRACTIONAL = [2.625, 2.75, 1.5, 3.25];

  it("lands every edge on a whole device pixel", () => {
    for (const dpr of [1, 2, 3, ...FRACTIONAL]) {
      for (const pxSize of [1, 4, 16, 64]) {
        for (const x of [0, 7, 100, 413]) {
          const r = livePixelRect(x, x + 3, pxSize, dpr);
          for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
        }
      }
    }
  });

  it("leaves no seam between neighbouring pixels", () => {
    for (const dpr of [1, 2, 3, ...FRACTIONAL]) {
      for (const pxSize of [1, 4, 16, 64]) {
        for (let i = 0; i < 8; i++) {
          const here = livePixelRect(100 + i * pxSize, 250 + i * pxSize, pxSize, dpr);
          const right = livePixelRect(100 + (i + 1) * pxSize, 250 + i * pxSize, pxSize, dpr);
          const below = livePixelRect(100 + i * pxSize, 250 + (i + 1) * pxSize, pxSize, dpr);
          expect(here.x + here.w).toBe(right.x);
          expect(here.y + here.h).toBe(below.y);
        }
      }
    }
  });

  it("scales a world pixel to its device size", () => {
    expect(livePixelRect(100, 250, 16, 3)).toEqual({ x: 300, y: 750, w: 48, h: 48 });
  });
});
