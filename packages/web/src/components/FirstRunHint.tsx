/**
 * The three things a first-time visitor cannot work out from the canvas.
 *
 * Someone arriving for the first time sees a world map, a lightning bar and
 * nothing else. That the map is paintable at all, that a pixel has a price,
 * and that the price doubles for an overpaint or a colour that does not suit
 * land or sea are all discoverable only by spending charges and guessing at
 * why the number moved by four instead of two.
 *
 * Deliberately not a modal. An interstitial in front of the canvas is the
 * fastest way to lose the person it is meant to help — this sits above the
 * colour picker, leaves the map live behind it, and goes away for good the
 * moment they place their first pixel.
 */

import { Zap, Pointer, Coins, X } from "lucide-react";
import { COST_BASE, COST_MAX } from "@canvasplanet/shared";

const STORAGE_KEY = "cp_intro_seen";

/**
 * Whether to offer it at all. `paintsSoFar` is the session's paint count from
 * bootstrap: someone who has painted before does not need this even if they
 * have since cleared their storage, and someone reading the canvas on a
 * second device does not need it twice.
 */
export function shouldShowFirstRunHint(paintsSoFar: number): boolean {
  if (paintsSoFar > 0) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === null;
  } catch {
    // Storage disabled: showing it every visit would be worse than never.
    return false;
  }
}

export function rememberFirstRunHint(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Nothing to do — it simply will not be remembered.
  }
}

export function FirstRunHint({ touch, onDismiss }: { touch: boolean; onDismiss: () => void }) {
  return (
    <aside className="cp-intro cp-card" role="note" aria-label="How to paint">
      <button className="cp-intro-close" aria-label="Dismiss" onClick={onDismiss}>
        <X size={14} />
      </button>

      <p className="cp-intro-lead">
        <Pointer size={15} aria-hidden />
        Pick a colour, then {touch ? "tap" : "click"} the map.
      </p>

      <ul className="cp-intro-rows">
        <li>
          <Coins size={14} aria-hidden />
          <span>
            {COST_BASE} charges a pixel — {COST_MAX} over someone else&rsquo;s, or when the colour
            does not match land or sea.
          </span>
        </li>
        <li>
          <Zap size={14} aria-hidden />
          <span>Charges come back on their own, one a second.</span>
        </li>
      </ul>

      <button className="cp-btn cp-intro-go" onClick={onDismiss}>
        Start painting
      </button>
    </aside>
  );
}
