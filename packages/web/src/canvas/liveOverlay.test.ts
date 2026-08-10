import { PALETTE_RGB, TILE_SIZE } from "@worldcanvas/shared";
import { describe, expect, it } from "vitest";
import { livePixelScreenSize } from "./livePixels.js";
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
