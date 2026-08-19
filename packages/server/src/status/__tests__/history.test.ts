import { describe, expect, it } from "vitest";
import { buildDailyHistory, type StatusHistoryRow } from "../history.js";

function row(
  checkedAt: string,
  overrides: Partial<Omit<StatusHistoryRow, "checked_at">> = {},
): StatusHistoryRow {
  return {
    checked_at: new Date(checkedAt),
    ok: true,
    db_ok: true,
    db_latency_ms: 20,
    tile_queue_depth: 0,
    ws_degraded: 0,
    ...overrides,
  };
}

describe("buildDailyHistory", () => {
  it("builds ordered UTC days with explicit gaps and exact component ratios", () => {
    const result = buildDailyHistory(
      3,
      [
        row("2026-08-16T23:59:00.000Z"),
        row("2026-08-18T01:00:00.000Z"),
        row("2026-08-18T02:00:00.000Z", { ws_degraded: 1 }),
        row("2026-08-18T03:00:00.000Z", {
          ok: false,
          db_ok: false,
          db_latency_ms: 5_000,
          tile_queue_depth: -1,
        }),
        row("2026-08-19T00:30:00.000Z"),
      ],
      new Date("2026-08-19T12:00:00.000Z"),
    );

    expect(result.days).toBe(3);
    expect(result.since).toBe("2026-08-18T01:00:00.000Z");
    expect(result.history.map((day) => day.date)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ]);

    expect(result.history[0]).toMatchObject({
      overall: "nodata",
      uptimeRatio: null,
      samples: 0,
      componentUptimeRatio: { canvas: null, realtime: null, database: null },
    });

    expect(result.history[1]).toMatchObject({
      overall: "down",
      uptimeRatio: 2 / 3,
      samples: 3,
      components: { canvas: "down", realtime: "degraded", database: "down" },
      componentUptimeRatio: { canvas: 2 / 3, realtime: 1, database: 2 / 3 },
    });

    expect(result.history[2]).toMatchObject({
      overall: "operational",
      uptimeRatio: 1,
      samples: 1,
      componentUptimeRatio: { canvas: 1, realtime: 1, database: 1 },
    });
  });

  it("uses UTC calendar boundaries instead of the local timezone", () => {
    const result = buildDailyHistory(
      1,
      [row("2026-08-19T00:01:00.000Z")],
      new Date("2026-08-19T23:59:59.000Z"),
    );

    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ date: "2026-08-19", samples: 1 });
  });
});
