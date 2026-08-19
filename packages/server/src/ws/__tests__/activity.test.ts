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
    const firstConn = hub.add(first as never, 17, "203.0.113.10");
    const siblingConn = hub.add(sibling as never, 17, "203.0.113.10");

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

describe("active player count", () => {
  it("counts one player per IP across tabs and separate sessions", () => {
    const socket = () => ({ OPEN: 1, readyState: 1, send: vi.fn() });
    const firstTab = hub.add(socket() as never, 31, "198.51.100.4");
    const secondBrowser = hub.add(socket() as never, 32, "198.51.100.4");
    const otherPlayer = hub.add(socket() as never, 33, "198.51.100.9");
    const embed = hub.add(socket() as never, null, null, false);

    try {
      expect(hub.activePlayerCount()).toBe(2);

      hub.remove(firstTab);
      expect(hub.activePlayerCount()).toBe(2);

      hub.remove(secondBrowser);
      expect(hub.activePlayerCount()).toBe(1);
    } finally {
      hub.remove(firstTab);
      hub.remove(secondBrowser);
      hub.remove(otherPlayer);
      hub.remove(embed);
    }
  });
});
