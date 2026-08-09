import { describe, expect, it } from "vitest";
import { GRID_CENTER, LANDMARK, MIN_PAINT_ZOOM, WORLD_SIZE } from "../config.js";
import { bboxArea, bboxContains, bboxOverlaps, canPaintAtZoom, findProtecting, inPaintBounds } from "../gating.js";
import type { Region } from "../gating.js";

describe("paint bounds", () => {
  it("is worldwide by default", () => {
    expect(inPaintBounds(0, 0)).toBe(true);
    expect(inPaintBounds(WORLD_SIZE - 1, WORLD_SIZE - 1)).toBe(true);
  });

  it("rejects anything off the grid", () => {
    expect(inPaintBounds(-1, 0)).toBe(false);
    expect(inPaintBounds(0, WORLD_SIZE)).toBe(false);
    expect(inPaintBounds(1.5, 0)).toBe(false);
    expect(inPaintBounds(NaN, 0)).toBe(false);
  });
});

describe("the landmark", () => {
  it("is centred on Null Island and is 256x128", () => {
    expect(LANDMARK.x0).toBe(GRID_CENTER - 128);
    expect(LANDMARK.y0).toBe(GRID_CENTER - 64);
    expect(LANDMARK.x1).toBe(GRID_CENTER + 127);
    expect(LANDMARK.y1).toBe(GRID_CENTER + 63);
    expect(bboxArea(LANDMARK)).toBe(256 * 128);
  });

  it("contains the exact centre pixel", () => {
    expect(bboxContains(LANDMARK, GRID_CENTER, GRID_CENTER)).toBe(true);
  });

  it("protects its interior and nothing outside it", () => {
    const regions: Region[] = [{ id: 1, ...LANDMARK }];
    expect(findProtecting(regions, GRID_CENTER, GRID_CENTER)?.name).toBe("landmark");
    expect(findProtecting(regions, LANDMARK.x0 - 1, GRID_CENTER)).toBeNull();
    expect(findProtecting(regions, LANDMARK.x1 + 1, GRID_CENTER)).toBeNull();
    expect(findProtecting(regions, GRID_CENTER, LANDMARK.y0 - 1)).toBeNull();
    expect(findProtecting(regions, GRID_CENTER, LANDMARK.y1 + 1)).toBeNull();
  });
});

describe("bbox helpers", () => {
  it("detects overlap and non-overlap including edge contact", () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(bboxOverlaps(a, { x0: 10, y0: 10, x1: 20, y1: 20 })).toBe(true);
    expect(bboxOverlaps(a, { x0: 11, y0: 0, x1: 20, y1: 10 })).toBe(false);
  });

  it("counts a single pixel as area 1", () => {
    expect(bboxArea({ x0: 5, y0: 5, x1: 5, y1: 5 })).toBe(1);
  });
});

describe("zoom gate", () => {
  it("unlocks painting only at MIN_PAINT_ZOOM and above", () => {
    expect(canPaintAtZoom(MIN_PAINT_ZOOM - 1)).toBe(false);
    expect(canPaintAtZoom(MIN_PAINT_ZOOM)).toBe(true);
    expect(canPaintAtZoom(18)).toBe(true);
  });
});
