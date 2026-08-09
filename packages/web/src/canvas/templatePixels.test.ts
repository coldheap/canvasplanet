import { TRANSPARENT_INDEX } from "@worldcanvas/shared";
import { describe, expect, it } from "vitest";
import { templateColorAt, type TemplatePlacement } from "./templatePixels.js";

const placement: TemplatePlacement = {
  x: 10,
  y: 20,
  w: 2,
  h: 2,
  data: Uint8Array.of(29, TRANSPARENT_INDEX, 7, 4),
};

describe("templateColorAt", () => {
  it("returns the palette colour under the pointer", () => {
    expect(templateColorAt(placement, 10, 20)).toBe(29);
    expect(templateColorAt(placement, 10, 21)).toBe(7);
    expect(templateColorAt(placement, 11, 21)).toBe(4);
  });

  it("ignores transparent and out-of-bounds pixels", () => {
    expect(templateColorAt(placement, 11, 20)).toBeNull();
    expect(templateColorAt(placement, 9, 20)).toBeNull();
    expect(templateColorAt(placement, 12, 21)).toBeNull();
    expect(templateColorAt(null, 10, 20)).toBeNull();
  });
});
