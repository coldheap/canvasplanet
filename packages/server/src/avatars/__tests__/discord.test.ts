import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVATAR_SIZE } from "../image.js";
import { discordAvatarUrl, fetchDiscordAvatar } from "../discord.js";

const HASH = "a".repeat(32);

async function png(width = 512, height = 512): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#5865f2" } })
    .png()
    .toBuffer();
}

function respondWith(body: Buffer, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue(
    new Response(new Uint8Array(body), { status: 200, headers }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discordAvatarUrl", () => {
  it("asks the CDN for a still PNG at the size we store", () => {
    const url = new URL(discordAvatarUrl("1234", `a_${HASH}`));
    expect(url.origin).toBe("https://cdn.discordapp.com");
    expect(url.pathname).toBe(`/avatars/1234/a_${HASH}.png`);
    expect(url.searchParams.get("size")).toBe(String(AVATAR_SIZE));
  });
});

describe("fetchDiscordAvatar", () => {
  it("normalizes the fetched image the same way an upload is", async () => {
    const fetchMock = respondWith(await png());
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchDiscordAvatar("1234", HASH);
    const metadata = await sharp(out!).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(AVATAR_SIZE);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns null without a request when the account has no picture", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchDiscordAvatar("1234", null)).toBeNull();
    expect(await fetchDiscordAvatar("1234", undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The hash lands in a URL this server then fetches, so a malformed one is
  // refused before the request rather than passed through.
  it("refuses a hash that is not a Discord avatar hash", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const bad of ["../../etc/passwd", `${HASH}/../evil`, "zz", `${HASH}${HASH}`]) {
      expect(await fetchDiscordAvatar("1234", bad)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws instead of buffering an oversized response", async () => {
    vi.stubGlobal("fetch", respondWith(Buffer.alloc(8), { "content-length": String(4 * 1024 * 1024) }));
    await expect(fetchDiscordAvatar("1234", HASH)).rejects.toThrow("too large");
  });

  it("throws when the CDN says no", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(fetchDiscordAvatar("1234", HASH)).rejects.toThrow("HTTP 404");
  });
});
