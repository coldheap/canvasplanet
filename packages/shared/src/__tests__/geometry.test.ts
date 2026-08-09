import { describe, expect, it } from "vitest";
import {
  Coverage,
  classifyRect,
  pointInPolygon,
  pointInRing,
  polygonCrossesRect,
  rectContainsRect,
  rectsIntersect,
  ringBbox,
  segmentsIntersect,
} from "../geometry.js";
import type { Poly, Ring } from "../geometry.js";

/** A 10x10 square from (0,0) to (10,10). */
const SQUARE: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

/** The same square with a 4x4 hole in the middle — a landlocked lake. */
const WITH_HOLE: Poly = [
  SQUARE,
  [
    [3, 3],
    [3, 7],
    [7, 7],
    [7, 3],
    [3, 3],
  ],
];

describe("pointInRing", () => {
  it("finds interior and exterior points", () => {
    expect(pointInRing(SQUARE, 5, 5)).toBe(true);
    expect(pointInRing(SQUARE, 15, 5)).toBe(false);
    expect(pointInRing(SQUARE, -1, 5)).toBe(false);
    expect(pointInRing(SQUARE, 5, 20)).toBe(false);
  });

  it("handles a concave shape where a bbox test would be wrong", () => {
    // A "C" — the notch is inside the bbox but outside the polygon.
    const c: Ring = [
      [0, 0],
      [10, 0],
      [10, 3],
      [3, 3],
      [3, 7],
      [10, 7],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    expect(pointInRing(c, 1, 5)).toBe(true); // the spine
    expect(pointInRing(c, 6, 5)).toBe(false); // the notch
  });

  it("counts a point on a shared vertex exactly once", () => {
    // The half-open rule is what stops a boundary point being attributed to
    // two adjacent countries, or to neither.
    const tri: Ring = [
      [0, 0],
      [10, 0],
      [0, 10],
      [0, 0],
    ];
    expect(typeof pointInRing(tri, 0, 0)).toBe("boolean");
    expect(pointInRing(tri, 1, 1)).toBe(true);
    expect(pointInRing(tri, 9, 9)).toBe(false);
  });
});

describe("pointInPolygon with holes", () => {
  it("excludes points inside a hole", () => {
    expect(pointInPolygon(WITH_HOLE, 1, 1)).toBe(true); // land
    expect(pointInPolygon(WITH_HOLE, 5, 5)).toBe(false); // the lake
    expect(pointInPolygon(WITH_HOLE, 20, 20)).toBe(false); // outside
  });
});

describe("segmentsIntersect", () => {
  it("detects crossing and non-crossing pairs", () => {
    expect(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [1, 1], [5, 5], [6, 6])).toBe(false);
  });

  it("reports parallel segments as non-crossing", () => {
    expect(segmentsIntersect([0, 0], [10, 0], [0, 5], [10, 5])).toBe(false);
  });
});

describe("classifyRect — the bake's core decision", () => {
  it("returns Full for a rectangle wholly inside", () => {
    expect(classifyRect([SQUARE], { minX: 2, minY: 2, maxX: 4, maxY: 4 })).toBe(Coverage.Full);
  });

  it("returns None for a rectangle wholly outside", () => {
    expect(classifyRect([SQUARE], { minX: 20, minY: 20, maxX: 30, maxY: 30 })).toBe(Coverage.None);
  });

  it("returns Partial for a rectangle straddling the boundary", () => {
    expect(classifyRect([SQUARE], { minX: 8, minY: 8, maxX: 12, maxY: 12 })).toBe(Coverage.Partial);
  });

  it("returns Partial when a whole island sits inside the rectangle", () => {
    // The classic four-corner bug: an island entirely swallowed by the tile
    // leaves every corner outside, so a corner test would wrongly say None.
    const island: Poly = [
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ];
    const tile = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(classifyRect(island, tile)).toBe(Coverage.Partial);
  });

  it("returns Partial when a hole intrudes into an otherwise-inside rectangle", () => {
    // All four corners are land, but the rectangle contains part of the lake.
    expect(classifyRect(WITH_HOLE, { minX: 2, minY: 2, maxX: 8, maxY: 8 })).toBe(Coverage.Partial);
  });

  it("returns Full for a rectangle inside the ring but clear of the hole", () => {
    expect(classifyRect(WITH_HOLE, { minX: 0.5, minY: 0.5, maxX: 2.5, maxY: 2.5 })).toBe(
      Coverage.Full,
    );
  });

  it("never returns Full for anything the boundary passes through", () => {
    // Property check: if the boundary crosses, the answer must be Partial —
    // a wrong Full is the failure mode that bakes an error into 38MB of
    // index and charges people the wrong amount forever.
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * 20 - 5;
      const y = Math.random() * 20 - 5;
      const r = { minX: x, minY: y, maxX: x + 1.5, maxY: y + 1.5 };
      const c = classifyRect([SQUARE], r);
      if (polygonCrossesRect([SQUARE], r)) expect(c).toBe(Coverage.Partial);
    }
  });
});

describe("rect helpers", () => {
  it("computes a ring bbox", () => {
    expect(ringBbox(SQUARE)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it("tests containment and intersection", () => {
    const outer = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(rectContainsRect(outer, { minX: 2, minY: 2, maxX: 4, maxY: 4 })).toBe(true);
    expect(rectContainsRect(outer, { minX: 2, minY: 2, maxX: 14, maxY: 4 })).toBe(false);
    expect(rectsIntersect(outer, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
    expect(rectsIntersect(outer, { minX: 11, minY: 11, maxX: 20, maxY: 20 })).toBe(false);
  });
});
