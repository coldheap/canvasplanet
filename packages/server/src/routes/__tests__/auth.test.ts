import { describe, expect, it } from "vitest";
import { normalizeSignup } from "../auth.js";

describe("normalizeSignup", () => {
  const valid = { email: "Player@Example.com", password: "correcthorsebattery", displayName: "Painter One" };

  it("accepts a valid signup and lowercases/trims the email", () => {
    const result = normalizeSignup(valid);
    expect(result).toEqual({
      email: "player@example.com",
      password: "correcthorsebattery",
      displayName: "Painter One",
    });
  });

  it("trims the display name", () => {
    const result = normalizeSignup({ ...valid, displayName: "  Painter One  " });
    expect("error" in result ? undefined : result.displayName).toBe("Painter One");
  });

  it.each([
    ["missing @", "not-an-email"],
    ["missing domain", "player@"],
    ["missing tld", "player@example"],
    ["empty", ""],
  ])("rejects an invalid email (%s)", (_label, email) => {
    const result = normalizeSignup({ ...valid, email });
    expect("error" in result).toBe(true);
  });

  it("rejects a password shorter than the minimum", () => {
    const result = normalizeSignup({ ...valid, password: "short1" });
    expect("error" in result).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(25)],
    ["disallowed character", "painter<script>"],
  ])("rejects a bad display name (%s)", (_label, displayName) => {
    const result = normalizeSignup({ ...valid, displayName });
    expect("error" in result).toBe(true);
  });

  it("accepts a display name at each length boundary", () => {
    expect("error" in normalizeSignup({ ...valid, displayName: "abc" })).toBe(false);
    expect("error" in normalizeSignup({ ...valid, displayName: "a".repeat(24) })).toBe(false);
  });
});
