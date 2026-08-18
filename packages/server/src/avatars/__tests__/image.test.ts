import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AVATAR_SIZE, normalizeAvatar } from "../image.js";

describe("normalizeAvatar", () => {
  it("center-crops and emits a metadata-free square WebP", async () => {
    const input = await sharp({
      create: { width: 600, height: 300, channels: 3, background: "#2563eb" },
    })
      .jpeg()
      .withMetadata({ orientation: 1 })
      .toBuffer();

    const output = await normalizeAvatar(input);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(AVATAR_SIZE);
    expect(metadata.height).toBe(AVATAR_SIZE);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects data that is not an image", async () => {
    await expect(normalizeAvatar(Buffer.from("not an image"))).rejects.toThrow();
  });

  it("rejects unsupported image formats", async () => {
    const gif = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "red" },
    })
      .gif()
      .toBuffer();
    await expect(normalizeAvatar(gif)).rejects.toThrow("JPEG, PNG, or WebP");
  });
});
