import { describe, expect, it } from "vitest";
import { LeaderboardStore } from "../store.js";

describe("country placement leaderboard", () => {
  it("ranks the painter countries by placements", () => {
    const store = new LeaderboardStore();
    store.applyPlacement(2);
    store.applyPlacement(1);
    store.applyPlacement(2);

    expect(store.rows()).toEqual([[2, 2, 0], [1, 1, 0]]);
    expect(store.rankOf(2)).toBe(1);
  });

  it("keeps unresolved and system paints in the world total without inventing a country", () => {
    const store = new LeaderboardStore();
    store.applyPlacement(null);
    store.applySystemPaint();

    expect(store.worldTotal()).toBe(2);
    expect(store.rows()).toEqual([]);
  });

  it("broadcasts one placement frame per change", () => {
    const store = new LeaderboardStore();
    expect(store.tick()).toBeNull();
    store.applyPlacement(4);
    expect(store.tick()).toEqual({ t: "lb", world: 1, rows: [[4, 1, 0]] });
    expect(store.tick()).toBeNull();
  });
});
