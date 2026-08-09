import { describe, expect, it } from "vitest";
import { rankActiveCountries } from "../hub.js";

describe("rankActiveCountries", () => {
  it("aggregates country buckets across the rolling window", () => {
    expect(
      rankActiveCountries([
        [[1, 3], [2, 1]],
        [[2, 5], [3, 2]],
        [[1, 4]],
      ]),
    ).toEqual([[1, 7], [2, 6], [3, 2]]);
  });

  it("limits the broadcast ranking", () => {
    expect(rankActiveCountries([[[1, 1], [2, 3], [3, 2]]], 2)).toEqual([[2, 3], [3, 2]]);
  });
});
