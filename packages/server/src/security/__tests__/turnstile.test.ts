import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/pool.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../../env.js", () => ({
  env: {
    turnstile: {
      enabled: true,
      sitekey: "test-sitekey",
      secret: "test-secret",
      hostnames: ["canvasplanet.net"],
    },
  },
}));

import { verify } from "../turnstile.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Turnstile verification", () => {
  it("accepts only a successful paint token for an approved hostname", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ success: true, action: "paint", hostname: "canvasplanet.net" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify("valid-token", "203.0.113.1")).toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect((request.body as URLSearchParams).get("response")).toBe("valid-token");
    expect((request.body as URLSearchParams).get("remoteip")).toBe("203.0.113.1");
  });

  it.each([
    { success: false, action: "paint", hostname: "canvasplanet.net" },
    { success: true, action: "signup", hostname: "canvasplanet.net" },
    { success: true, action: "paint", hostname: "attacker.example" },
  ])("rejects an invalid response: %o", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
    expect(await verify("invalid-token", "203.0.113.1")).toBe(false);
  });

  it("rejects malformed tokens without contacting Cloudflare", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await verify("", "203.0.113.1")).toBe(false);
    expect(await verify("x".repeat(2049), "203.0.113.1")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Cloudflare returns an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 500)));
    expect(await verify("token", "203.0.113.1")).toBe(false);
  });
});
