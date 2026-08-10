import { describe, expect, it } from "vitest";
import { normalizeCountryHeader } from "../ipCountry.js";

describe("normalizeCountryHeader", () => {
  it("normalizes a Cloudflare ISO country code", () => {
    expect(normalizeCountryHeader(" lb ")).toBe("LB");
  });

  it.each([undefined, "", "LBN", "XX", "T1"])("rejects %j", (value) => {
    expect(normalizeCountryHeader(value)).toBeNull();
  });
});
