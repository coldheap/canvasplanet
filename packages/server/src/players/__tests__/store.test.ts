import { describe, expect, it } from "vitest";
import { PlayerStore } from "../store.js";

// Exercises only the pure in-memory arithmetic — applyPaint/rows/rankOf/tick
// never touch the database, so this needs no Postgres. load() does and is
// covered by verify/accounts.mjs instead.
function fresh(): PlayerStore {
  return new PlayerStore();
}

describe("PlayerStore.applyPaint", () => {
  it("is a no-op for a session with no linked account", () => {
    const s = fresh();
    s.applyPaint(null, null);
    expect(s.rows()).toEqual([]);
  });

  it("increments cumulative and held on a first paint", () => {
    const s = fresh();
    s.applyPaint(1, null);
    expect(s.rows()).toEqual([[1, "", 1, 1]]);
  });

  it("increments cumulative but not held on a same-owner repaint", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(1, 1);
    expect(s.rows()).toEqual([[1, "", 2, 1]]);
  });

  it("moves held from the previous player to the new one on overpaint", () => {
    const s = fresh();
    s.applyPaint(1, null); // player 1 paints an empty pixel
    s.applyPaint(2, 1); // player 2 overpaints it
    expect(s.rows().find((r) => r[0] === 1)).toEqual([1, "", 1, 0]);
    expect(s.rows().find((r) => r[0] === 2)).toEqual([2, "", 1, 1]);
  });

  it("never lets held go negative", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(2, 1);
    s.applyPaint(3, 1); // player 1 already lost this pixel once
    expect(s.rows().find((r) => r[0] === 1)?.[3]).toBe(0);
  });

  it("does not touch user_stats when an anonymous session overpaints a member's pixel", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(null, 1); // a session with no account repaints it
    expect(s.rows().find((r) => r[0] === 1)).toEqual([1, "", 1, 0]);
  });
});

describe("PlayerStore.register", () => {
  it("seeds the display name so a first paint before the next load() still renders it", () => {
    const s = fresh();
    s.register(1, "Alice");
    s.applyPaint(1, null);
    expect(s.rows()).toEqual([[1, "Alice", 1, 1]]);
  });

  it("does not overwrite stats already loaded for that id", () => {
    const s = fresh();
    s.applyPaint(1, null); // simulates a paint already reflected in the map
    s.register(1, "Alice"); // a duplicate/late registration must not reset it
    expect(s.rows()).toEqual([[1, "", 1, 1]]);
  });

  it("does not itself mark the store dirty — nothing rank-worthy changed yet", () => {
    const s = fresh();
    s.register(1, "Alice");
    expect(s.tick()).toBeNull();
  });

  it("does not appear in rows() until it has actually painted", () => {
    const s = fresh();
    s.register(1, "Alice");
    expect(s.rows()).toEqual([]);
  });
});

describe("PlayerStore.rows/rankOf", () => {
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

describe("PlayerStore.tick", () => {
  it("returns null when nothing changed, and a frame exactly once per change", () => {
    const s = fresh();
    expect(s.tick()).toBeNull();
    s.applyPaint(1, null);
    expect(s.tick()).toEqual({ t: "plb", rows: [[1, "", 1, 1]] });
    expect(s.tick()).toBeNull();
  });
});
