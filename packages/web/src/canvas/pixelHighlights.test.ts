import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_MS,
  PixelHighlights,
  highlightAlpha,
  highlightRingWidth,
} from "./pixelHighlights.js";

describe("highlightAlpha", () => {
  it("holds at full strength before fading", () => {
    expect(highlightAlpha(0)).toBe(1);
    expect(highlightAlpha(HIGHLIGHT_MS * 0.2)).toBe(1);
    expect(highlightAlpha(HIGHLIGHT_MS * 0.6)).toBeLessThan(1);
  });

  it("never draws a mark that has expired, or one dated in the future", () => {
    expect(highlightAlpha(HIGHLIGHT_MS)).toBe(0);
    expect(highlightAlpha(HIGHLIGHT_MS * 4)).toBe(0);
    // Clock skew between the server-driven stream and Date.now().
    expect(highlightAlpha(-50)).toBe(0);
  });

  it("decreases monotonically", () => {
    let previous = 1;
    for (let age = 0; age < HIGHLIGHT_MS; age += 50) {
      const alpha = highlightAlpha(age);
      expect(alpha).toBeLessThanOrEqual(previous);
      previous = alpha;
    }
  });
});

describe("highlightRingWidth", () => {
  it("stays visible at native zoom, where a world pixel is one screen pixel", () => {
    expect(highlightRingWidth(1)).toBe(1);
  });

  it("grows with zoom but stops before it swamps the pixel", () => {
    expect(highlightRingWidth(16)).toBe(2);
    expect(highlightRingWidth(64)).toBe(3);
    expect(highlightRingWidth(1024)).toBe(3);
  });
});

describe("PixelHighlights", () => {
  it("highlights other people's paint", () => {
    const h = new PixelHighlights();
    expect(h.record(10, 20, 7, 1_000)).toBe(true);
    expect(h.size).toBe(1);
    expect([...h.values()]).toEqual([{ x: 10, y: 20, at: 1_000 }]);
  });

  it("stays silent when your own optimistic paint echoes back", () => {
    const h = new PixelHighlights();
    h.markSelf(10, 20, 7, 1_000);
    expect(h.record(10, 20, 7, 1_400)).toBe(false);
    expect(h.size).toBe(0);
  });

  it("suppresses that echo once, not every later paint of the pixel", () => {
    const h = new PixelHighlights();
    h.markSelf(10, 20, 7, 1_000);
    expect(h.record(10, 20, 7, 1_400)).toBe(false);
    expect(h.record(10, 20, 7, 2_000)).toBe(true);
  });

  it("highlights someone painting over you in the colour you did not use", () => {
    const h = new PixelHighlights();
    h.markSelf(10, 20, 7, 1_000);
    expect(h.record(10, 20, 9, 1_400)).toBe(true);
  });

  it("gives up on an echo that never arrives", () => {
    const h = new PixelHighlights();
    h.markSelf(10, 20, 7, 1_000);
    expect(h.record(10, 20, 7, 1_000 + 60_000)).toBe(true);
  });

  it("stops suppressing a paint the server refused", () => {
    const h = new PixelHighlights();
    h.markSelf(10, 20, 7, 1_000);
    h.forgetSelf(10, 20);
    expect(h.record(10, 20, 7, 1_200)).toBe(true);
  });

  it("drops marks once they have finished fading", () => {
    const h = new PixelHighlights();
    h.record(10, 20, 7, 1_000);
    h.record(11, 20, 7, 1_000 + HIGHLIGHT_MS);
    h.prune(1_000 + HIGHLIGHT_MS);
    expect([...h.values()]).toEqual([{ x: 11, y: 20, at: 1_000 + HIGHLIGHT_MS }]);
  });

  it("stays bounded when a backgrounded tab never draws", () => {
    const h = new PixelHighlights();
    // No prune() in between: nothing is calling requestAnimationFrame.
    for (let i = 0; i < 20_000; i++) h.record(i, 0, 7, 1_000 + i * 10);
    expect(h.size).toBeLessThanOrEqual(4_096);
  });
});
