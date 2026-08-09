import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../db/pool.js";
import { transferHeld } from "../ownership.js";

function fakeClient() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { client: { query } as unknown as Client, query };
}

describe("transferHeld", () => {
  it("does no counter work when ownership is unchanged", async () => {
    const { client, query } = fakeClient();
    const owner = { countryId: 2, allianceId: 3, userId: 4 };
    await transferHeld(client, owner, owner);
    expect(query).not.toHaveBeenCalled();
  });

  it("moves country, alliance and player held counters together", async () => {
    const { client, query } = fakeClient();
    await transferHeld(
      client,
      { countryId: 1, allianceId: 2, userId: 3 },
      { countryId: 4, allianceId: null, userId: null },
    );

    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("UPDATE country_stats SET held");
    expect(sql).toContain("INSERT INTO country_stats");
    expect(sql).toContain("UPDATE alliance_stats SET held");
    expect(sql).toContain("UPDATE user_stats SET held");
    expect(query).toHaveBeenCalledTimes(4);
  });
});
