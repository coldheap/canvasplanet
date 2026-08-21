import type { EventStateDTO } from "@canvasplanet/shared";
import { describe, expect, it } from "vitest";
import { eventBannerText } from "./EventBanner.js";

const active: EventStateDTO = {
  id: 1,
  bbox: { x0: 0, y0: 0, x1: 47, y1: 47 },
  botColor: 0,
  startedAt: 0,
  endsAt: 90_000,
  corruptionPct: 0.25,
  defenders: 2,
  status: "active",
  result: null,
};

describe("eventBannerText", () => {
  it("states both end conditions and the live countdown", () => {
    expect(eventBannerText(active, 30_000)).toBe(
      "Corruption event — 25% corrupted · Win below 50% · Lose at 50% or more · 1:00 left",
    );
  });

  it("shows the frozen victory while rollback runs", () => {
    expect(eventBannerText({ ...active, status: "resolving", result: "defended" })).toBe(
      "Victory — Zone defended at 25% corruption. Restoring canvas…",
    );
  });

  it("shows the frozen defeat while rollback runs", () => {
    expect(
      eventBannerText({ ...active, corruptionPct: 0.5, status: "resolving", result: "corrupted" }),
    ).toBe("Defeat — Zone lost at 50% corruption. Restoring canvas…");
  });
});

/* The phone banner sits in a strip a third the width of the desktop one, so
 * it trades the threshold clauses for the marker on the bar. What it must
 * not trade away is the live countdown or the current percentage. */
describe("eventBannerText, compact", () => {
  it("keeps the percentage and the countdown, drops the thresholds", () => {
    expect(eventBannerText(active, 30_000, true)).toBe("Corruption 25% · 1:00 left");
  });

  it("shortens each resolved outcome without losing which one it is", () => {
    expect(eventBannerText({ ...active, status: "resolving", result: null }, 0, true)).toBe(
      "Finalizing at 25%…",
    );
    expect(eventBannerText({ ...active, status: "resolving", result: "defended" }, 0, true)).toBe(
      "Victory — defended at 25%",
    );
    expect(
      eventBannerText({ ...active, corruptionPct: 0.5, status: "resolving", result: "corrupted" }, 0, true),
    ).toBe("Defeat — lost at 50%");
  });

  it("stays shorter than the desktop wording in every state", () => {
    for (const e of [
      active,
      { ...active, status: "resolving", result: null } as const,
      { ...active, status: "resolving", result: "defended" } as const,
      { ...active, status: "resolving", result: "corrupted" } as const,
    ]) {
      expect(eventBannerText(e, 30_000, true).length).toBeLessThan(
        eventBannerText(e, 30_000, false).length,
      );
    }
  });
});
