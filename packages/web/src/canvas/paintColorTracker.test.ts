import { describe, expect, it } from "vitest";
import { PaintColorTracker } from "./paintColorTracker.js";

describe("PaintColorTracker", () => {
  it("suppresses repeated requests for the same optimistic colour", () => {
    const tracker = new PaintColorTracker();

    expect(tracker.begin(10, 20, 4)).not.toBeNull();
    expect(tracker.begin(10, 20, 4)).toBeNull();
  });

  it("suppresses a colour already observed from the server", () => {
    const tracker = new PaintColorTracker();
    tracker.observe(10, 20, 4);

    expect(tracker.begin(10, 20, 4)).toBeNull();
    expect(tracker.begin(10, 20, 5)).not.toBeNull();
  });

  it("restores the previous colour after a refused paint", () => {
    const tracker = new PaintColorTracker();
    tracker.observe(10, 20, 4);
    const attempt = tracker.begin(10, 20, 5)!;

    expect(tracker.rollback(attempt)).toBe(true);
    expect(tracker.begin(10, 20, 4)).toBeNull();
  });

  it("does not roll back a newer server observation", () => {
    const tracker = new PaintColorTracker();
    const attempt = tracker.begin(10, 20, 4)!;
    tracker.observe(10, 20, 5);

    expect(tracker.rollback(attempt)).toBe(false);
    expect(tracker.begin(10, 20, 5)).toBeNull();
  });

  it("ignores a slow observation after a newer optimistic paint", () => {
    const tracker = new PaintColorTracker();
    const revision = tracker.revision(10, 20);
    tracker.begin(10, 20, 4);

    expect(tracker.observeIfRevision(10, 20, revision, null)).toBe(false);
    expect(tracker.begin(10, 20, 4)).toBeNull();
  });
});
