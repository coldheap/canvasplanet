import { describe, expect, it } from "vitest";
import {
  METRES_PER_PIXEL_EQUATOR,
  GRID_CENTER,
  SUB_ZOOM,
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
  it("is 65,536 pixels per axis at z8", () => {
    expect(WORLD_SIZE).toBe(65_536);
    expect(TILES_PER_AXIS).toBe(256);
    expect(TOTAL_TILES).toBe(65_536);
  });

  it("is ~611.5 m/pixel at the equator", () => {
    expect(METRES_PER_PIXEL_EQUATOR).toBeCloseTo(611.496, 3);
  });
});

describe("latLngToPixel", () => {
  it("puts Null Island at the exact centre of the grid", () => {
    // This is the landmark's anchor. If it ever moves, the seed is wrong.
    expect(latLngToPixel({ lat: 0, lng: 0 })).toEqual({ x: GRID_CENTER, y: GRID_CENTER });
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
      const roundTrip = latLngToPixel(back);
      expect(Math.abs(roundTrip.x - pixel.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(roundTrip.y - pixel.y)).toBeLessThanOrEqual(1);
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
    // DB: (x >> 8) * TILES_PER_AXIS + (y >> 8)
    const cases: Array<[number, number]> = [
      [0, 0],
      [255, 255],
      [256, 0],
      [GRID_CENTER, GRID_CENTER],
      [WORLD_SIZE - 1, WORLD_SIZE - 1],
    ];
    for (const [x, y] of cases) {
      expect(tileIdOf(x, y)).toBe(Math.floor(x / 256) * TILES_PER_AXIS + Math.floor(y / 256));
    }
  });

  it("round-trips tile ids", () => {
    const id = tileIdOf(GRID_CENTER, GRID_CENTER);
    const { tx, ty } = tileIdToXY(id);
    expect(tx).toBe(TILES_PER_AXIS / 2);
    expect(ty).toBe(TILES_PER_AXIS / 2);
  });

  it("covers exactly 256x256 pixels per native tile", () => {
    const b = tileBbox(TILES_PER_AXIS / 2, TILES_PER_AXIS / 2);
    expect(b).toEqual({ x0: GRID_CENTER, y0: GRID_CENTER, x1: GRID_CENTER + 255, y1: GRID_CENTER + 255 });
  });

  it("indexes pixels inside a tile without collision", () => {
    expect(pixelIndexInTile(GRID_CENTER, GRID_CENTER)).toBe(0);
    expect(pixelIndexInTile(GRID_CENTER + 1, GRID_CENTER)).toBe(1);
    expect(pixelIndexInTile(GRID_CENTER, GRID_CENTER + 1)).toBe(256);
    expect(pixelIndexInTile(GRID_CENTER + 255, GRID_CENTER + 255)).toBe(65535);
  });

  it("produces a Z_PIXEL+1-deep dirty chain, leaf first, ending at 0/0/0", () => {
    const chain = tileAncestry(GRID_CENTER, GRID_CENTER);
    expect(chain).toHaveLength(Z_PIXEL + 1);
    expect(chain[0]).toEqual({ z: Z_PIXEL, x: TILES_PER_AXIS / 2, y: TILES_PER_AXIS / 2 });
    expect(chain[chain.length - 1]).toEqual({ z: 0, x: 0, y: 0 });
    // each step is the parent of the last
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.x).toBe(chain[i - 1]!.x >> 1);
      expect(chain[i]!.y).toBe(chain[i - 1]!.y >> 1);
    }
  });

  it("covers a 1080p-ish native viewport with a small subscription set", () => {
    const keys = subKeysForBbox({ x0: GRID_CENTER, y0: GRID_CENTER, x1: GRID_CENTER + 1919, y1: GRID_CENTER + 1079 }, SUB_ZOOM);
    expect(keys.length).toBeLessThanOrEqual(6);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
