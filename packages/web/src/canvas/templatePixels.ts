import { TRANSPARENT_INDEX, WORLD_SIZE } from "@canvasplanet/shared";

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

/** Top-left origin that puts a template's centre on the picked world pixel. */
export function centeredTemplateOrigin(
  center: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(WORLD_SIZE - width, center.x - Math.floor(width / 2))),
    y: Math.max(0, Math.min(WORLD_SIZE - height, center.y - Math.floor(height / 2))),
  };
}
