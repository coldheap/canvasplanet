import { describe, expect, it, vi } from "vitest";
import { hub, rankActiveCountries } from "../hub.js";

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

describe("connection-scoped messages", () => {
  it("does not send a new connection's snapshot to sibling tabs", () => {
    const first = { OPEN: 1, readyState: 1, send: vi.fn() };
    const sibling = { OPEN: 1, readyState: 1, send: vi.fn() };
    const firstConn = hub.add(first as never, 17);
    const siblingConn = hub.add(sibling as never, 17);

    try {
      hub.sendToConnection(firstConn, { t: "charges", bank: 3, max: 60, nextAt: 1_000 });
      expect(first.send).toHaveBeenCalledOnce();
      expect(sibling.send).not.toHaveBeenCalled();
    } finally {
      hub.remove(firstConn);
      hub.remove(siblingConn);
    }
  });
});
