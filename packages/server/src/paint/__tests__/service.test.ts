import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  lookup: vi.fn(() => ({ countryId: 1, terrain: 1 })),
}));

vi.mock("../../db/pool.js", () => ({
  tx: async (run: (client: { query: typeof mocks.query }) => unknown) =>
    run({ query: mocks.query }),
}));
vi.mock("../../geo/index.js", () => ({
  geo: { lookup: mocks.lookup },
}));
vi.mock("../../security/asn.js", () => ({ isFlagged: () => false }));
vi.mock("../../state/policy.js", () => ({
  getProtectedRegions: () => [],
  isFrozen: () => false,
}));

import { paint } from "../service.js";

const NOW = 1_700_000_000_000;

function sessionRow(charges = 60) {
  return {
    charges,
    charges_updated_at: new Date(NOW),
    banned_until: null,
    asn: null,
    alliance_id: 2,
    user_id: 3,
    event_bonus_until: null,
    explicitly_banned: false,
  };
}

function pixelRow(color: number | null) {
  return color === null
    ? []
    : [{ color, country_id: 1, alliance_id: 2, user_id: 3 }];
}

describe("paint identical colour", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.lookup.mockReset();
    mocks.lookup.mockReturnValue({ countryId: 1, terrain: 1 });
    mocks.query
      .mockResolvedValueOnce({
        rows: [sessionRow()],
      })
      .mockResolvedValueOnce({
        rows: [{ color: 7, country_id: 1, alliance_id: 2, user_id: 3 }],
      });
  });

  it("is a silent zero-cost no-op with no database writes", async () => {
    const result = await paint({
      sessionId: 10,
      ip: "127.0.0.1",
      originCountryId: null,
      x: 100,
      y: 100,
      color: 7,
      staff: null,
    });

    expect(result).toMatchObject({ ok: true, changed: false, cost: 0, bank: 60 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toContain(
      "INSERT INTO",
    );
  });
});

describe("paint charge rules", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.query.mockReset();
    mocks.lookup.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      case: "unclaimed land with a land colour",
      terrain: 1,
      currentColor: null,
      newColor: 20,
      cost: 2,
    },
    {
      case: "unclaimed land with a water colour",
      terrain: 1,
      currentColor: null,
      newColor: 29,
      cost: 4,
    },
    {
      case: "claimed land with another land colour",
      terrain: 1,
      currentColor: 20,
      newColor: 0,
      cost: 4,
    },
    {
      case: "claimed water with another water colour",
      terrain: 0,
      currentColor: 29,
      newColor: 28,
      cost: 4,
    },
    {
      case: "restoring a claimed land pixel",
      terrain: 1,
      currentColor: 29,
      newColor: 20,
      cost: 2,
    },
    {
      case: "restoring a claimed water pixel",
      terrain: 0,
      currentColor: 20,
      newColor: 29,
      cost: 2,
    },
  ])("deducts and records $cost charges for $case", async ({ terrain, currentColor, newColor, cost }) => {
    mocks.lookup.mockReturnValue({ countryId: terrain, terrain });
    mocks.query
      .mockResolvedValueOnce({ rows: [sessionRow()] })
      .mockResolvedValueOnce({ rows: pixelRow(currentColor) })
      .mockResolvedValueOnce({ rows: [{ tokens: 120, refused: false, retry_ms: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await paint({
      sessionId: 10,
      ip: "127.0.0.1",
      originCountryId: null,
      x: 100,
      y: 100,
      color: newColor,
      staff: null,
    });

    expect(result).toMatchObject({ ok: true, changed: true, cost, bank: 60 - cost });

    const ipBudgetParams = mocks.query.mock.calls[2]?.[1];
    expect(ipBudgetParams?.[2]).toBe(cost);
    const paintWriteParams = mocks.query.mock.calls[3]?.[1];
    expect(paintWriteParams?.[8]).toBe(cost);
    expect(paintWriteParams?.[12]).toBe(60 - cost);
  });

  it.each([
    {
      case: "an unclaimed terrain-correct pixel",
      currentColor: null,
      newColor: 20,
      cost: 2,
      retryAfterMs: 60_000,
    },
    {
      case: "a claimed terrain-correct pixel",
      currentColor: 20,
      newColor: 0,
      cost: 4,
      retryAfterMs: 120_000,
    },
  ])("reports the full wait until $case is affordable", async ({
    currentColor,
    newColor,
    cost,
    retryAfterMs,
  }) => {
    mocks.lookup.mockReturnValue({ countryId: 1, terrain: 1 });
    mocks.query
      .mockResolvedValueOnce({ rows: [sessionRow(0)] })
      .mockResolvedValueOnce({ rows: pixelRow(currentColor) });

    const result = await paint({
      sessionId: 10,
      ip: "127.0.0.1",
      originCountryId: null,
      x: 100,
      y: 100,
      color: newColor,
      staff: null,
    });

    expect(result).toEqual({
      ok: false,
      reason: "no_charges",
      retryAfterMs,
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(cost).toBe(retryAfterMs / 30_000);
  });
});
