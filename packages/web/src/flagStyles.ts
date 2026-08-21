/**
 * The country-flag stylesheet, loaded once and never during startup.
 *
 * flag-icons ships a rule per country — around 400 KB of CSS. Nothing on
 * screen needs it until a panel that lists countries is open, and parsing it
 * is real main-thread work, so loading it eagerly just competes with the
 * app's first render for the same thread. It used to be scheduled on an idle
 * callback with a 1.5s timeout, which on a mid-range phone fired in the
 * middle of exactly that render.
 *
 * So the app asks for it explicitly once it is interactive, and even then
 * only when the browser is idle.
 */
let started = false;

export function loadFlagStyles(): void {
  if (started) return;
  started = true;

  const load = () => void import("flag-icons/css/flag-icons.min.css");
  const idle = (window as Window & {
    requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;

  // The timeout is a backstop for a tab that never goes idle; by the time it
  // can fire, the canvas is already up.
  if (idle) idle(load, { timeout: 4_000 });
  else window.setTimeout(load, 1_000);
}
