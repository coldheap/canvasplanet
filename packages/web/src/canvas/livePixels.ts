import { Z_PIXEL } from "@canvasplanet/shared";

/** Screen size of one native pixel; zero means use raster tiles only. */
export function livePixelScreenSize(zoom: number): number {
  return zoom < Z_PIXEL ? 0 : 2 ** (zoom - Z_PIXEL);
}
