import { describe, expect, it } from "vitest";
import { censorChatMessage } from "../filter.js";

describe("censorChatMessage", () => {
  it("censors blocked words and phrases without discarding the message", () => {
    expect(censorChatMessage("well, fuck that and kill yourself"))
      .toBe("well, ***** that and *****");
  });

  it("handles separators, leetspeak, case and diacritics", () => {
    expect(censorChatMessage("F.U.C.K n1ggér")).toBe("***** *****");
  });

  it("handles stretched spelling and mixed-script homoglyphs", () => {
    expect(censorChatMessage("fuuuuck nіggеr")).toBe("***** *****");
  });

  it("does not censor blocked text embedded inside an innocent word", () => {
    expect(censorChatMessage("classic assignment and button class"))
      .toBe("classic assignment and button class");
  });

  it("preserves emoji and non-Latin text outside a censored span", () => {
    expect(censorChatMessage("hello 🌍, asshole! مرحبا")).toBe("hello 🌍, *****! مرحبا");
  });

  it("can censor a maximum-length message even when replacements make it longer", () => {
    const input = Array.from({ length: 100 }, () => "fag").join(" ");
    expect([...input].length).toBe(399);
    expect(censorChatMessage(input)).toBe(Array.from({ length: 100 }, () => "*****").join(" "));
  });
});
