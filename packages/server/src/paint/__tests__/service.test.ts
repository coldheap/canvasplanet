import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/pool.js", () => ({
  tx: async (run: (client: { query: typeof mocks.query }) => unknown) =>
    run({ query: mocks.query }),
}));
vi.mock("../../geo/index.js", () => ({
  geo: { lookup: () => ({ countryId: 1, terrain: 1 }) },
}));
vi.mock("../../security/asn.js", () => ({ isFlagged: () => false }));
vi.mock("../../state/policy.js", () => ({
  getProtectedRegions: () => [],
  isFrozen: () => false,
}));

import { paint } from "../service.js";

describe("paint identical colour", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          charges: 30,
          charges_updated_at: new Date(0),
          banned_until: null,
          asn: null,
          alliance_id: 2,
          user_id: 3,
          event_bonus_until: null,
          explicitly_banned: false,
        }],
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

    expect(result).toMatchObject({ ok: true, changed: false, cost: 0, bank: 30 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toContain(
      "INSERT INTO",
    );
  });
});
