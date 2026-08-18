import sharp from "sharp";

export const AVATAR_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;
const AVATAR_MAX_INPUT_PIXELS = 16_777_216;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

/** Decode untrusted input and emit the one format/size the rest of the app
 * serves. Re-encoding also removes EXIF and other user-supplied metadata. */
export async function normalizeAvatar(input: Buffer): Promise<Buffer> {
  const source = sharp(input, {
    failOn: "error",
    limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
    pages: 1,
  });
  const metadata = await source.metadata();
  if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format)) {
    throw new Error("profile picture must be a JPEG, PNG, or WebP image");
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new Error("animated profile pictures are not supported");
  }

  return source
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}
