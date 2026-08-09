import { HISTORY_BUCKET_MS, HISTORY_MAX_AGE_MS } from "@worldcanvas/shared";
import { describe, expect, it } from "vitest";
import { normalizeHistoryAt } from "../history.js";

describe("normalizeHistoryAt", () => {
  const now = Date.UTC(2026, 7, 9, 12, 3, 12);

  it("snaps selections down to immutable five-minute buckets", () => {
    expect(normalizeHistoryAt(now - 12_345, now) % HISTORY_BUCKET_MS).toBe(0);
  });

  it("does not allow future history selections", () => {
    expect(normalizeHistoryAt(now + HISTORY_BUCKET_MS, now)).toBe(
      Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS,
    );
  });

  it("clamps old selections to the public history window", () => {
    const oldestBucket = Math.floor((now - HISTORY_MAX_AGE_MS) / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
    expect(normalizeHistoryAt(0, now)).toBe(oldestBucket);
  });
});
