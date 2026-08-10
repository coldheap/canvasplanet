export const PLACEMENT_FLASH_MS = 750;
export const REDUCED_PLACEMENT_FLASH_MS = 400;

/** Build the decorative marker shared by the flat-map and globe renderers. */
export function createPlacementFlashElement(): { element: HTMLDivElement; duration: number } {
  const element = document.createElement("div");
  element.setAttribute("aria-hidden", "true");

  const root = document.documentElement;
  const reduceMotion =
    root.classList.contains("wc-motion-reduce") ||
    (!root.classList.contains("wc-motion-full") && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  element.className = reduceMotion ? "wc-placement-flash is-reduced" : "wc-placement-flash";
  return {
    element,
    duration: reduceMotion ? REDUCED_PLACEMENT_FLASH_MS : PLACEMENT_FLASH_MS,
  };
}
