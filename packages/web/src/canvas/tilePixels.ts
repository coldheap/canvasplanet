import { PALETTE_RGB, TILE_SIZE } from "@canvasplanet/shared";

/** True only when a native PNG has baked the pending palette colour. */
export function tilePixelMatches(
  rgba: Uint8ClampedArray,
  x: number,
  y: number,
  color: number,
): boolean {
  const rgb = PALETTE_RGB[color];
  if (!rgb) return false;
  const offset = (y * TILE_SIZE + x) * 4;
  return (
    rgba[offset] === rgb[0] &&
    rgba[offset + 1] === rgb[1] &&
    rgba[offset + 2] === rgb[2] &&
    rgba[offset + 3] === 255
  );
}
