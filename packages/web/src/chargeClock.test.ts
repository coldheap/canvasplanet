import { describe, expect, it } from "vitest";
import { isNewerChargeSnapshot, localChargeDeadline } from "./chargeClock.js";

describe("localChargeDeadline", () => {
  it("preserves the server's remaining duration when the browser clock is ahead", () => {
    expect(localChargeDeadline(1_001_000, 1_000_000, 9_000_000)).toBe(9_001_000);
  });

  it("preserves the server's remaining duration when the browser clock is behind", () => {
    expect(localChargeDeadline(9_001_000, 9_000_000, 1_000_000)).toBe(1_001_000);
  });

  it("keeps a full bank without a deadline", () => {
    expect(localChargeDeadline(null, 1_000_000, 9_000_000)).toBeNull();
  });
});

describe("isNewerChargeSnapshot", () => {
  it("rejects an older paint response even when it arrives later", () => {
    expect(isNewerChargeSnapshot(14, 9_000, 29, 8_000)).toBe(false);
  });

  it("accepts a later recharge snapshot at the same paint version", () => {
    expect(isNewerChargeSnapshot(29, 9_000, 29, 8_000)).toBe(true);
  });

  it("ignores a duplicate snapshot so local regeneration is not rolled back", () => {
    expect(isNewerChargeSnapshot(29, 8_000, 29, 8_000)).toBe(false);
  });
});
