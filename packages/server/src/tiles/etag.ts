import { createHash } from "node:crypto";

/**
 * A strong validator for a rendered tile.
 *
 * PNG byte length is not a content identity: many different sparse pixel
 * tiles compress to exactly the same size. Using the length as an ETag lets
 * a browser answer a refresh with an older image even after the tile worker
 * has rendered new paint.
 */
export function tileEtag(prefix: string, tile: Buffer): string {
  const digest = createHash("sha256").update(tile).digest("base64url");
  return `"${prefix}-${digest}"`;
}
