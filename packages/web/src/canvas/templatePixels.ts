import { TRANSPARENT_INDEX } from "@worldcanvas/shared";

export interface TemplatePlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** One palette index per pixel, TRANSPARENT_INDEX for "skip". */
  data: Uint8Array;
}

/** Palette colour requested by a template at a world pixel. */
export function templateColorAt(
  placement: TemplatePlacement | null,
  x: number,
  y: number,
): number | null {
  if (
    !placement ||
    x < placement.x ||
    y < placement.y ||
    x >= placement.x + placement.w ||
    y >= placement.y + placement.h
  ) {
    return null;
  }

  const color = placement.data[(y - placement.y) * placement.w + (x - placement.x)];
  return color === undefined || color === TRANSPARENT_INDEX ? null : color;
}
