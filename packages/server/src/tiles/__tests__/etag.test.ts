import { describe, expect, it } from "vitest";
import { tileEtag } from "../etag.js";

describe("tileEtag", () => {
  it("changes when equal-length tile contents change", () => {
    const before = Buffer.from([1, 2, 3, 4]);
    const after = Buffer.from([1, 2, 3, 5]);

    expect(after.length).toBe(before.length);
    expect(tileEtag("12-1-2", after)).not.toBe(tileEtag("12-1-2", before));
  });

  it("is stable for the same content", () => {
    expect(tileEtag("12-1-2", Buffer.from("png"))).toBe(
      tileEtag("12-1-2", Buffer.from("png")),
    );
  });
});
