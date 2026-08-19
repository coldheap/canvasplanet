import { describe, expect, it } from "vitest";
import { RequestRateLimiter } from "../requestRateLimit.js";

describe("RequestRateLimiter", () => {
  it("allows the configured burst, then returns an accurate retry", () => {
    const limiter = new RequestRateLimiter(3, 2_000, 100);

    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(true);
    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(true);
    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(true);
    expect(limiter.take("203.0.113.1", 10_000)).toEqual({
      allowed: false,
      retryAfterMs: 2_000,
    });
  });

  it("refills fractionally without allowing early requests", () => {
    const limiter = new RequestRateLimiter(1, 2_000, 100);

    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(true);
    expect(limiter.take("203.0.113.1", 11_000)).toEqual({
      allowed: false,
      retryAfterMs: 1_000,
    });
    expect(limiter.take("203.0.113.1", 12_000).allowed).toBe(true);
  });

  it("keeps separate budgets per IP", () => {
    const limiter = new RequestRateLimiter(1, 2_000, 100);

    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(true);
    expect(limiter.take("203.0.113.2", 10_000).allowed).toBe(true);
    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(false);
  });

  it("evicts the least recently used key at the memory bound", () => {
    const limiter = new RequestRateLimiter(1, 60_000, 2);

    limiter.take("203.0.113.1", 10_000);
    limiter.take("203.0.113.2", 10_000);
    limiter.take("203.0.113.2", 10_000); // touch .2, so .1 is oldest
    limiter.take("203.0.113.3", 10_000);

    expect(limiter.take("203.0.113.1", 10_000).allowed).toBe(true);
  });
});
