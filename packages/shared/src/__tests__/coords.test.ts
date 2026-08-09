import { describe, expect, it } from "vitest";
import {
  METRES_PER_PIXEL_EQUATOR,
  TILES_PER_AXIS,
  TOTAL_TILES,
  WORLD_SIZE,
  Z_PIXEL,
} from "../config.js";
import {
  pixelIndexInTile,
  pixelToLatLng,
  latLngToPixel,
  latToY,
  lngToX,
  subKeysForBbox,
  tileAncestry,
  tileBbox,
  tileIdOf,
  tileIdToXY,
  xToLng,
  yToLat,
} from "../coords.js";

describe("grid constants", () => {
  it("is 1,048,576 pixels per axis at z12", () => {
    expect(WORLD_SIZE).toBe(1_048_576);
    expect(TILES_PER_AXIS).toBe(4096);
    expect(TOTAL_TILES).toBe(16_777_216);
  });

  it("is ~38.22 m/pixel at the equator", () => {
    expect(METRES_PER_PIXEL_EQUATOR).toBeCloseTo(38.2185, 3);
  });
});

describe("latLngToPixel", () => {
  it("puts Null Island at the exact centre of the grid", () => {
    // This is the landmark's anchor. If it ever moves, the seed is wrong.
    expect(latLngToPixel({ lat: 0, lng: 0 })).toEqual({ x: 524288, y: 524288 });
  });

  it("puts the antimeridian and the poles at the corners", () => {
    expect(lngToX(-180)).toBe(0);
    expect(lngToX(179.9999999)).toBe(WORLD_SIZE - 1);
    expect(latToY(85.05112877980659)).toBe(0);
    expect(latToY(-85.05112877980659)).toBe(WORLD_SIZE - 1);
  });

  it("clamps beyond the Mercator latitude limit rather than producing NaN", () => {
    expect(latToY(90)).toBe(0);
    expect(latToY(-90)).toBe(WORLD_SIZE - 1);
    expect(Number.isNaN(latToY(90))).toBe(false);
  });

  it("wraps longitude across the antimeridian", () => {
    expect(lngToX(181)).toBe(lngToX(-179));
    expect(lngToX(-181)).toBe(lngToX(179));
  });

  it("round-trips within one pixel", () => {
    const places: Array<[number, number]> = [
      [29.3759, 47.9774], // Kuwait City
      [51.5074, -0.1278], // London
      [-33.8688, 151.2093], // Sydney
      [64.1466, -21.9426], // Reykjavik
      [-54.8019, -68.302], // Ushuaia
    ];
    for (const [lat, lng] of places) {
      const pixel = latLngToPixel({ lat, lng });
      const back = pixelToLatLng(pixel);
      expect(latLngToPixel(back)).toEqual(pixel);
    }
  });

  it("is monotonic in both axes", () => {
    expect(lngToX(10)).toBeGreaterThan(lngToX(-10));
    // y grows southward in Mercator
    expect(latToY(-10)).toBeGreaterThan(latToY(10));
  });

  it("never emits an out-of-range pixel", () => {
    for (let i = 0; i < 500; i++) {
      const lat = Math.random() * 180 - 90;
      const lng = Math.random() * 360 - 180;
      const { x, y } = latLngToPixel({ lat, lng });
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(WORLD_SIZE);
      expect(y).toBeLessThan(WORLD_SIZE);
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });

  it("agrees with the inverse projection", () => {
    expect(xToLng(0)).toBeCloseTo(-180, 9);
    expect(xToLng(WORLD_SIZE / 2)).toBeCloseTo(0, 9);
    expect(yToLat(WORLD_SIZE / 2)).toBeCloseTo(0, 9);
  });
});

describe("tiles", () => {
  it("matches the Postgres generated-column expression", () => {
    // DB: (x >> 8) * 4096 + (y >> 8)
    const cases: Array<[number, number]> = [
      [0, 0],
      [255, 255],
      [256, 0],
      [524288, 524288],
      [1048575, 1048575],
    ];
    for (const [x, y] of cases) {
      expect(tileIdOf(x, y)).toBe(Math.floor(x / 256) * 4096 + Math.floor(y / 256));
    }
  });

  it("round-trips tile ids", () => {
    const id = tileIdOf(524288, 524288);
    const { tx, ty } = tileIdToXY(id);
    expect(tx).toBe(2048);
    expect(ty).toBe(2048);
  });

  it("covers exactly 256x256 pixels per z12 tile", () => {
    const b = tileBbox(2048, 2048);
    expect(b).toEqual({ x0: 524288, y0: 524288, x1: 524543, y1: 524543 });
  });

  it("indexes pixels inside a tile without collision", () => {
    expect(pixelIndexInTile(524288, 524288)).toBe(0);
    expect(pixelIndexInTile(524289, 524288)).toBe(1);
    expect(pixelIndexInTile(524288, 524289)).toBe(256);
    expect(pixelIndexInTile(524543, 524543)).toBe(65535);
  });

  it("produces a 13-deep dirty chain, leaf first, ending at 0/0/0", () => {
    const chain = tileAncestry(524288, 524288);
    expect(chain).toHaveLength(Z_PIXEL + 1);
    expect(chain[0]).toEqual({ z: 12, x: 2048, y: 2048 });
    expect(chain[chain.length - 1]).toEqual({ z: 0, x: 0, y: 0 });
    // each step is the parent of the last
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.x).toBe(chain[i - 1]!.x >> 1);
      expect(chain[i]!.y).toBe(chain[i - 1]!.y >> 1);
    }
  });

  it("covers a 1080p-ish z12 viewport with ~4 subscription tiles", () => {
    // 1920x1080 pixels at z12 starting at the landmark
    const keys = subKeysForBbox({ x0: 524288, y0: 524288, x1: 524288 + 1919, y1: 524288 + 1079 }, 10);
    expect(keys.length).toBeLessThanOrEqual(6);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
