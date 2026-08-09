import { describe, expect, it } from "vitest";
import { TOTAL_TILES, Z_PIXEL, latLngToPixel, tileIdOf } from "@worldcanvas/shared";
import type { Poly } from "@worldcanvas/shared";
import {
  HEADER_BYTES,
  MAGIC,
  MIXED_COUNTRY,
  TerrainBits,
  bake,
  pack2Bit,
  serialise,
  tileRect,
  unpack2Bit,
} from "../bake.js";
import { PolygonIndex } from "../polygonIndex.js";

/** A rectangle in lon/lat, as a GeoJSON-style ring. */
function box(minLon: number, minLat: number, maxLon: number, maxLat: number): Poly {
  return [
    [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ],
  ];
}

const tileOf = (lat: number, lon: number) => {
  const c = latLngToPixel({ lat, lng: lon });
  return tileIdOf(c.x, c.y);
};

describe("tileRect", () => {
  it("covers the whole world at z0", () => {
    const r = tileRect(0, 0, 0);
    expect(r.minX).toBeCloseTo(-180, 6);
    expect(r.maxX).toBeCloseTo(180, 6);
    expect(r.maxY).toBeCloseTo(85.0511287, 5);
    expect(r.minY).toBeCloseTo(-85.0511287, 5);
  });

  it("orders latitude correctly despite y growing southward", () => {
    const r = tileRect(2, 1, 1);
    expect(r.maxY).toBeGreaterThan(r.minY);
    expect(r.maxX).toBeGreaterThan(r.minX);
  });

  it("tiles the world without gaps at z1", () => {
    const left = tileRect(1, 0, 0);
    const right = tileRect(1, 1, 0);
    expect(left.maxX).toBeCloseTo(right.minX, 9);
  });
});

describe("2-bit packing", () => {
  it("round-trips every value", () => {
    const src = new Uint8Array([0, 1, 2, 3, 3, 2, 1, 0]);
    const packed = pack2Bit(src);
    expect(packed.length).toBe(2);
    for (let i = 0; i < src.length; i++) expect(unpack2Bit(packed, i)).toBe(src[i]);
  });

  it("compresses one byte per tile to two bits", () => {
    expect(pack2Bit(new Uint8Array(4096)).length).toBe(1024);
  });
});

describe("bake — full pipeline on synthetic geometry", () => {
  // A "continent" over the equator near the prime meridian, and a "sea"
  // well away from it. Both are large enough to contain interior tiles.
  const countryIdx = new PolygonIndex();
  countryIdx.add(42, [box(-10, -10, 10, 10)]);

  const waterIdx = new PolygonIndex();
  waterIdx.add(1, [box(100, -10, 140, 10)]);

  const result = bake(countryIdx, waterIdx);

  it("produces arrays sized for every z12 tile", () => {
    expect(result.countries.length).toBe(TOTAL_TILES);
    expect(result.terrain.length).toBe(TOTAL_TILES / 4);
  });

  it("attributes a tile deep inside the country", () => {
    expect(result.countries[tileOf(0, 0)]).toBe(42);
    expect(result.countries[tileOf(5, 5)]).toBe(42);
    expect(result.countries[tileOf(-5, -5)]).toBe(42);
  });

  it("leaves tiles far outside unattributed", () => {
    expect(result.countries[tileOf(0, 120)]).toBe(0);
    expect(result.countries[tileOf(60, -120)]).toBe(0);
  });

  it("marks the boundary MIXED so the runtime resolves it per-point", () => {
    // A tile straddling the edge at lon=10 cannot be uniform.
    const edge = tileOf(0, 10);
    expect(result.countries[edge]).toBe(MIXED_COUNTRY);
  });

  it("classifies terrain from the water index", () => {
    expect(unpack2Bit(result.terrain, tileOf(0, 120))).toBe(TerrainBits.Water);
    expect(unpack2Bit(result.terrain, tileOf(0, 0))).toBe(TerrainBits.Land);
    expect(unpack2Bit(result.terrain, tileOf(0, 100))).toBe(TerrainBits.Mixed);
  });

  it("keeps the MIXED fraction small — that is the whole design premise", () => {
    const { mixedTerrainTiles, landTiles, waterTiles } = result.stats;
    const total = mixedTerrainTiles + landTiles + waterTiles;
    expect(total).toBe(TOTAL_TILES);
    // With one rectangular sea the boundary is tiny; real coastlines are
    // fractal, but the plan budgets 1-2% and this must be well under it.
    expect(mixedTerrainTiles / total).toBeLessThan(0.01);
  });

  it("visits far fewer nodes than there are tiles", () => {
    // The quadtree descent is the reason the bake is minutes, not hours.
    expect(result.stats.nodesVisited).toBeLessThan(TOTAL_TILES / 100);
  });

  it("serialises with a readable header the loader will accept", () => {
    const buf = serialise(result);
    expect(buf.readUInt32LE(0)).toBe(MAGIC);
    expect(buf.readUInt32LE(8)).toBe(TOTAL_TILES);
    expect(buf.byteLength).toBe(
      HEADER_BYTES + result.countries.byteLength + result.terrain.byteLength,
    );
    // ~38 MB is the budget stated in the plan.
    expect(buf.byteLength / 1e6).toBeLessThan(45);
  });
});

describe("PolygonIndex", () => {
  it("finds the containing feature and misses outside", () => {
    const idx = new PolygonIndex();
    idx.add(7, [box(0, 0, 10, 10)]);
    expect(idx.lookup(5, 5)).toBe(7);
    expect(idx.lookup(50, 50)).toBeNull();
  });

  it("indexes a MultiPolygon as separate entries", () => {
    // One bbox spanning both islands would cover the ocean between them and
    // defeat the R-tree.
    const idx = new PolygonIndex();
    idx.add(9, [box(0, 0, 1, 1), box(100, 0, 101, 1)]);
    expect(idx.size).toBe(2);
    expect(idx.lookup(0.5, 0.5)).toBe(9);
    expect(idx.lookup(100.5, 0.5)).toBe(9);
    expect(idx.lookup(50, 0.5)).toBeNull();
  });

  it("reports overlapping features as mixed rather than picking one", () => {
    const idx = new PolygonIndex();
    idx.add(1, [box(0, 0, 10, 10)]);
    idx.add(2, [box(0, 0, 10, 10)]);
    expect(idx.classify({ minX: 2, minY: 2, maxX: 3, maxY: 3 })).toEqual({ mixed: true });
  });

  it("answers immediately when nothing is nearby", () => {
    const idx = new PolygonIndex();
    idx.add(1, [box(0, 0, 1, 1)]);
    expect(idx.classify({ minX: 50, minY: 50, maxX: 60, maxY: 60 })).toEqual({ uniform: null });
  });
});

describe("Z_PIXEL invariant", () => {
  it("the bake leaf level is the pixel grid level", () => {
    expect(Z_PIXEL).toBe(12);
  });
});
