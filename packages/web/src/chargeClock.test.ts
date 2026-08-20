import { describe, expect, it } from "vitest";
import { localChargeDeadline } from "./chargeClock.js";

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
