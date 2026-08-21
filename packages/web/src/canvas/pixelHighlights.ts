/**
 * "Highlight new pixels" — the fading ring the live overlay draws around paint
 * that has just landed, so a busy area announces itself instead of quietly
 * changing while you look somewhere else.
 *
 * The bookkeeping lives here rather than in LiveOverlay because it answers a
 * question the overlay cannot: *whose* paint is this? The hub broadcasts a
 * flushed tile batch to every subscriber of that tile, the painter included,
 * and the frame carries no author (see server/src/ws/hub.ts). So your own
 * paint arrives back over the same socket as everyone else's, and ringing it
 * would make every stroke strobe under your own cursor.
 *
 * The fix is to remember what you painted optimistically and let the echo
 * cancel it out. `markSelf` records the local paint; the matching `record`
 * consumes that entry and draws nothing. Entries expire, so a stranger
 * painting the same pixel a minute later is still highlighted.
 */

import { WORLD_SIZE } from "@canvasplanet/shared";

/** How long a ring stays on screen. Long enough to catch out of the corner of
 *  your eye, short enough that a hot region is not permanently outlined. */
export const HIGHLIGHT_MS = 1_500;
/** Fraction of that spent at full strength before the fade begins. */
const HOLD = 0.25;
/**
 * How long an optimistic paint waits for its echo. The round trip is
 * normally well under a second; this only has to outlast a slow commit plus
 * the hub's flush interval, and being generous costs one small map entry.
 */
const SELF_ECHO_MS = 20_000;
/**
 * Ceiling on tracked marks. A backgrounded tab stops getting animation
 * frames, so nothing prunes while the socket keeps delivering — without a cap
 * a night spent in another tab would grow this map without limit.
 */
const MAX_MARKS = 4_096;

export interface PixelMark {
  x: number;
  y: number;
  at: number;
}

/**
 * Ring opacity for a mark of the given age: full for the first quarter of its
 * life, then easing away.
 *
 * Deliberately not branched on `prefers-reduced-motion`. Nothing here moves —
 * it is a stationary shape changing opacity, which is the accessible
 * substitute for motion rather than a case of it. Replacing the fade with a
 * hard on/off blink to "respect" the setting would be the more jarring of the
 * two.
 */
export function highlightAlpha(age: number, duration = HIGHLIGHT_MS): number {
  if (age < 0 || age >= duration) return 0;
  const t = age / duration;
  if (t <= HOLD) return 1;
  const gone = (t - HOLD) / (1 - HOLD);
  return 1 - gone * gone;
}

/**
 * Half-thickness of the ring in CSS pixels, in terms of the on-screen size of
 * one world pixel. The ring is drawn as a dark stroke with a red core over
 * it, so the marker as a whole is twice this.
 *
 * It grows with zoom but not proportionally: at z12 a world pixel is one
 * screen pixel, and a ring that scaled with it would be invisible at exactly
 * the zoom where you most need to be told something changed.
 */
export function highlightRingWidth(pxSize: number): number {
  return Math.max(1, Math.min(3, Math.round(pxSize / 8)));
}

export class PixelHighlights {
  private marks = new Map<number, PixelMark>();
  private self = new Map<number, { color: number; at: number }>();

  /** An optimistic local paint, so its echo does not ring your own cursor. */
  markSelf(x: number, y: number, color: number, now = Date.now()): void {
    this.self.set(key(x, y), { color, at: now });
  }

  /** The server refused that paint, so no echo is coming — drop the claim,
   *  or the next person to paint here inherits the suppression. */
  forgetSelf(x: number, y: number): void {
    this.self.delete(key(x, y));
  }

  /**
   * A pixel off the live stream. Returns whether it was highlighted, which is
   * false for your own paint coming back to you.
   */
  record(x: number, y: number, color: number, now = Date.now()): boolean {
    const k = key(x, y);
    const mine = this.self.get(k);
    if (mine && mine.color === color && now - mine.at < SELF_ECHO_MS) {
      this.self.delete(k);
      return false;
    }
    if (this.marks.size >= MAX_MARKS) this.prune(now);
    this.marks.set(k, { x, y, at: now });
    return true;
  }

  /** Drop marks that have finished fading, and self-claims whose echo never
   *  arrived (a dropped frame, or a paint that failed after being sent). */
  prune(now = Date.now()): void {
    for (const [k, mark] of this.marks) {
      if (now - mark.at >= HIGHLIGHT_MS) this.marks.delete(k);
    }
    for (const [k, mine] of this.self) {
      if (now - mine.at >= SELF_ECHO_MS) this.self.delete(k);
    }
  }

  clear(): void {
    this.marks.clear();
    this.self.clear();
  }

  values(): IterableIterator<PixelMark> {
    return this.marks.values();
  }

  /** Whether a pixel is currently ringed. The overlay asks about the four
   *  neighbours of every mark: a shared edge between two new pixels is an
   *  interior edge of one new region, and drawing it is what turned a painted
   *  block into a red mesh with the paint invisible underneath. */
  has(x: number, y: number): boolean {
    return this.marks.has(key(x, y));
  }

  /** Any tracked pixel, for use as the frame's projection anchor. */
  anchor(): PixelMark | undefined {
    return this.marks.values().next().value;
  }

  get size(): number {
    return this.marks.size;
  }
}

/** Pack a pixel into one collision-free integer key for the configured world. */
function key(x: number, y: number): number {
  return x * WORLD_SIZE + y;
}
