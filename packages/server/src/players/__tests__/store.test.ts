import { describe, expect, it } from "vitest";
import { PlayerStore } from "../store.js";

// Exercises only the pure in-memory arithmetic — applyPaint/rows/rankOf/tick
// never touch the database, so this needs no Postgres. load() does and is
// covered by verify/accounts.mjs instead.
function fresh(): PlayerStore {
  return new PlayerStore();
}

// Fixed UTC instants for the streak tests below, so "same day" / "next day" /
// "a gap" don't depend on when this suite happens to run.
const DAY1 = Date.UTC(2026, 0, 1, 12); // Jan 1, noon UTC
const DAY2 = Date.UTC(2026, 0, 2, 3); // Jan 2, early — still the next UTC day
const DAY3 = Date.UTC(2026, 0, 3, 23); // Jan 3, late — still just the next UTC day
const DAY5 = Date.UTC(2026, 0, 5, 12); // Jan 5 — a gap, day 4 skipped

describe("PlayerStore.applyPaint", () => {
  it("is a no-op for a session with no linked account", () => {
    const s = fresh();
    s.applyPaint(null, null);
    expect(s.rows()).toEqual([]);
  });

  it("increments cumulative and held on a first paint", () => {
    const s = fresh();
    s.applyPaint(1, null);
    expect(s.rows()).toEqual([[1, "", 1, 1, 1, null]]);
  });

  it("increments cumulative but not held on a same-owner repaint", () => {
    const s = fresh();
    s.applyPaint(1, null);
    s.applyPaint(1, 1);
    expect(s.rows()).toEqual([[1, "", 2, 1, 1, null]]);
  });

  it("moves held from the previous player to the new one on overpaint", () => {
    const s = fresh();
    s.applyPaint(1, null); // player 1 paints an empty pixel
    s.applyPaint(2, 1); // player 2 overpaints it
    expect(s.rows().find((r) => r[0] === 1)).toEqual([1, "", 1, 0, 1, null]);
    expect(s.rows().find((r) => r[0] === 2)).toEqual([2, "", 1, 1, 1, null]);
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
    expect(s.rows().find((r) => r[0] === 1)).toEqual([1, "", 1, 0, 1, null]);
  });
});

describe("PlayerStore.applyPaint streaks (ROADMAP.md Phase 6)", () => {
  it("starts a streak at 1 on a first-ever paint", () => {
    const s = fresh();
    s.applyPaint(1, null, DAY1);
    expect(s.rows()[0]![4]).toBe(1);
  });

  it("does not increment the streak for a second paint on the same UTC day", () => {
    const s = fresh();
    s.applyPaint(1, null, DAY1);
    s.applyPaint(1, 1, DAY1 + 3_600_000);
    expect(s.rows()[0]![4]).toBe(1);
  });

  it("increments the streak on the very next UTC day", () => {
    const s = fresh();
    s.applyPaint(1, null, DAY1);
    s.applyPaint(1, 1, DAY2);
    expect(s.rows()[0]![4]).toBe(2);
  });

  it("keeps climbing across consecutive UTC days", () => {
    const s = fresh();
    s.applyPaint(1, null, DAY1);
    s.applyPaint(1, 1, DAY2);
    s.applyPaint(1, 1, DAY3);
    expect(s.rows()[0]![4]).toBe(3);
  });

  it("resets to 1 after a gap day", () => {
    const s = fresh();
    s.applyPaint(1, null, DAY1);
    s.applyPaint(1, 1, DAY2);
    s.applyPaint(1, 1, DAY5); // day 4 skipped entirely
    expect(s.rows()[0]![4]).toBe(1);
  });

  it("tracks each player's streak independently", () => {
    const s = fresh();
    s.applyPaint(1, null, DAY1);
    s.applyPaint(1, 1, DAY2);
    s.applyPaint(2, null, DAY2); // player 2's first paint, a day later
    expect(s.rows().find((r) => r[0] === 1)?.[4]).toBe(2);
    expect(s.rows().find((r) => r[0] === 2)?.[4]).toBe(1);
  });
});

describe("PlayerStore.register", () => {
  it("seeds the display name so a first paint before the next load() still renders it", () => {
    const s = fresh();
    s.register(1, "Alice");
    s.applyPaint(1, null);
    expect(s.rows()).toEqual([[1, "Alice", 1, 1, 1, null]]);
  });

  it("does not overwrite stats already loaded for that id", () => {
    const s = fresh();
    s.applyPaint(1, null); // simulates a paint already reflected in the map
    s.register(1, "Alice"); // a duplicate/late registration must not reset it
    expect(s.rows()).toEqual([[1, "", 1, 1, 1, null]]);
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

describe("PlayerStore.setAvatar", () => {
  it("updates the public row and emits one leaderboard frame", () => {
    const s = fresh();
    s.register(1, "Alice");
    s.applyPaint(1, null, DAY1);
    s.tick();
    s.setAvatar(1, "55ea2ca4-9dc0-4fd7-baba-e19058d5a959");
    expect(s.tick()).toEqual({
      t: "plb",
      rows: [[1, "Alice", 1, 1, 1, "55ea2ca4-9dc0-4fd7-baba-e19058d5a959"]],
    });
    expect(s.tick()).toBeNull();
  });
});

describe("PlayerStore.tick", () => {
  it("returns null when nothing changed, and a frame exactly once per change", () => {
    const s = fresh();
    expect(s.tick()).toBeNull();
    s.applyPaint(1, null, DAY1);
    expect(s.tick()).toEqual({ t: "plb", rows: [[1, "", 1, 1, 1, null]] });
    expect(s.tick()).toBeNull();
  });
});
