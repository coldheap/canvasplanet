import { describe, expect, it } from "vitest";
import { AllianceStore } from "../store.js";

// Exercises only the pure in-memory arithmetic — applyPaint/rows/rankOf/tick
// never touch the database, so this needs no Postgres. load()/reload() do
// and are covered by verify/alliances.mjs instead.
function fresh(): AllianceStore {
  return new AllianceStore();
}

describe("AllianceStore.applyPaint", () => {
  it("is a no-op for a session with no alliance", () => {
    const s = fresh();
    s.applyPaint(null, null);
    expect(s.rows()).toEqual([]);
  });

  it("increments cumulative and held on a first paint", () => {
    const s = fresh();
    s.applyPaint(1, null);
    expect(s.rows()).toEqual([[1, 1, 1]]);
  });

  it("increments cumulative but not held on a same-owner repaint", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(1, 1);
    expect(s.rows()).toEqual([[1, 2, 1]]);
  });

  it("moves held from the previous alliance to the new one on overpaint", () => {
    const s = fresh();
    s.applyPaint(1, null); // alliance 1 paints an empty pixel
    s.applyPaint(2, 1); // alliance 2 overpaints it
    expect(s.rows().find((r) => r[0] === 1)).toEqual([1, 1, 0]);
    expect(s.rows().find((r) => r[0] === 2)).toEqual([2, 1, 1]);
  });

  it("never lets held go negative", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(2, 1);
    s.applyPaint(3, 1); // alliance 1 already lost this pixel once
    expect(s.rows().find((r) => r[0] === 1)?.[2]).toBe(0);
  });

  it("does not touch alliance_stats when a non-member overpaints a member's pixel", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(null, 1); // a session with no alliance repaints it
    expect(s.rows().find((r) => r[0] === 1)).toEqual([1, 1, 0]);
  });
});

describe("AllianceStore.rows/rankOf", () => {
  it("ranks by cumulative, descending", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(2, null);
    s.applyPaint(2, 2);
    expect(s.rows().map((r) => r[0])).toEqual([2, 1]);
    expect(s.rankOf(2)).toBe(1);
    expect(s.rankOf(1)).toBe(2);
    expect(s.rankOf(999)).toBeNull();
  });
});

describe("AllianceStore.tick", () => {
  it("returns null when nothing changed, and a frame exactly once per change", () => {
    const s = fresh();
    expect(s.tick()).toBeNull();
    s.applyPaint(1, null);
    expect(s.tick()).toEqual({ t: "alb", rows: [[1, 1, 1]] });
    expect(s.tick()).toBeNull();
  });
});
