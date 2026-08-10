import type { EventStateDTO } from "@worldcanvas/shared";
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
