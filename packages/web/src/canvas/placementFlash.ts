import { GRID_ZOOM } from "@worldcanvas/shared";

export const PLACEMENT_FLASH_MIN_ZOOM = GRID_ZOOM;
/** Expand a quarter-pixel on every edge: 1.5x the painted pixel overall. */
export const PLACEMENT_FLASH_PADDING = 0.25;
export const PLACEMENT_FLASH_MS = 650;
export const REDUCED_PLACEMENT_FLASH_MS = 300;

/** Motion preference shared by the flat-map and globe placement flashes. */
export function placementFlashPresentation(): { duration: number; reduced: boolean } {
  const root = document.documentElement;
  const reduced =
    root.classList.contains("wc-motion-reduce") ||
    (!root.classList.contains("wc-motion-full") && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  return {
    duration: reduced ? REDUCED_PLACEMENT_FLASH_MS : PLACEMENT_FLASH_MS,
    reduced,
  };
}
