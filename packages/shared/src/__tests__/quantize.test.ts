import { describe, expect, it } from "vitest";
import {
  PALETTE,
  PALETTE_OKLAB,
  PALETTE_RGB,
  TRANSPARENT_INDEX,
  nearestInOklab,
  nearestPaletteIndex,
  quantizeToPalette,
  srgbToOklab,
} from "../palette.js";

/** Build an RGBA buffer from a list of [r,g,b,a] pixels. */
function image(pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  });
  return out;
}

describe("Oklab palette cache", () => {
  it("has one entry per colour", () => {
    expect(PALETTE_OKLAB).toHaveLength(PALETTE.length);
  });

  it("matches converting on demand", () => {
    PALETTE_RGB.forEach(([r, g, b], i) => {
      const [L, a, bb] = srgbToOklab(r, g, b);
      expect(PALETTE_OKLAB[i]![0]).toBeCloseTo(L, 10);
      expect(PALETTE_OKLAB[i]![1]).toBeCloseTo(a, 10);
      expect(PALETTE_OKLAB[i]![2]).toBeCloseTo(bb, 10);
    });
  });

  it("maps every palette colour to itself", () => {
    // The sanity check that catches a broken colour conversion outright.
    PALETTE_RGB.forEach(([r, g, b], i) => {
      expect(nearestPaletteIndex(r, g, b)).toBe(i);
    });
  });

  it("agrees between the RGB and Oklab entry points", () => {
    const [L, a, b] = srgbToOklab(120, 60, 200);
    expect(nearestInOklab(L, a, b)).toBe(nearestPaletteIndex(120, 60, 200));
  });
});

describe("quantizeToPalette", () => {
  it("keeps transparent pixels unpainted", () => {
    const out = quantizeToPalette(image([[255, 0, 0, 0], [255, 0, 0, 255]]), 2, 1);
    expect(out[0]).toBe(TRANSPARENT_INDEX);
    expect(out[1]).not.toBe(TRANSPARENT_INDEX);
  });

  it("treats near-transparent as transparent, not as a dark colour", () => {
    // alpha 3 over black would otherwise quantize to a real colour nobody
    // asked for.
    expect(quantizeToPalette(image([[200, 30, 30, 3]]), 1, 1)[0]).toBe(TRANSPARENT_INDEX);
    expect(quantizeToPalette(image([[200, 30, 30, 200]]), 1, 1)[0]).not.toBe(TRANSPARENT_INDEX);
  });

  it("maps exact palette colours to themselves in both modes", () => {
    const px = PALETTE_RGB.map(([r, g, b]) => [r, g, b, 255] as [number, number, number, number]);
    const flat = quantizeToPalette(image(px), px.length, 1, "none");
    const dithered = quantizeToPalette(image(px), px.length, 1, "floyd");
    for (let i = 0; i < px.length; i++) {
      expect(flat[i]).toBe(i);
      // Dithering diffuses error, but an exact match has zero error, so a
      // solid run of palette colours must survive it untouched.
      expect(dithered[i]).toBe(i);
    }
  });

  it("produces a valid palette index for every opaque pixel", () => {
    const px: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 256; i++) {
      px.push([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255]);
    }
    for (const mode of ["none", "floyd"] as const) {
      const out = quantizeToPalette(image(px), 16, 16, mode);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(PALETTE.length);
      }
    }
  });

  it("dithering breaks up a flat mid-tone that flat quantization cannot", () => {
    // A colour between two palette entries: flat mode picks one everywhere,
    // dithering must mix at least two to approximate it.
    const px: Array<[number, number, number, number]> = Array.from({ length: 64 }, () => [
      128, 128, 128, 255,
    ]);
    const flat = new Set(quantizeToPalette(image(px), 8, 8, "none"));
    const dithered = new Set(quantizeToPalette(image(px), 8, 8, "floyd"));
    expect(flat.size).toBe(1);
    expect(dithered.size).toBeGreaterThan(1);
  });

  it("does not read past the image on the last row or column", () => {
    // Error diffusion writes to right and down neighbours; the edges are
    // where an off-by-one corrupts memory or throws.
    expect(() => quantizeToPalette(image([[10, 200, 90, 255]]), 1, 1, "floyd")).not.toThrow();
    const strip = Array.from({ length: 5 }, () => [10, 200, 90, 255] as [number, number, number, number]);
    expect(() => quantizeToPalette(image(strip), 5, 1, "floyd")).not.toThrow();
    expect(() => quantizeToPalette(image(strip), 1, 5, "floyd")).not.toThrow();
  });
});
