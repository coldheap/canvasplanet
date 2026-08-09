/**
 * Behavioural bot scoring — SIGNALS ONLY in v1. Deliberately not enforcing.
 *
 * Enforcement is deferred to v1.1 (PLAN.md §8), but the signals are recorded
 * from day one so that when the model is built there is real data to build it
 * against. Turning this on later without historical data would mean guessing
 * at thresholds against live users.
 *
 * The signals are the things a human cannot help doing and a naive bot cannot
 * be bothered to fake:
 *
 *   - click-interval variance: humans are noisy, bots are metronomic
 *   - pointermove before click: real cursors travel, synthetic clicks teleport
 *   - paint order: humans wander, bots raster-scan left-to-right top-to-bottom
 *   - zoom/pan entropy: humans look around, bots never move the map
 *
 * When enforcement lands, a high score should SHADOW-throttle: the paint
 * returns 200, the pixel lands slowly or not at all. An operator who gets a
 * clean error learns exactly what tripped the detector and adapts; one whose
 * bot merely seems slow usually does not.
 */

export interface PaintSignal {
  sessionId: number;
  x: number;
  y: number;
  at: number;
  /** Client-reported; advisory only, never trusted for anything but scoring. */
  hadPointerMove?: boolean;
}

interface SessionTrace {
  intervals: number[];
  lastAt: number;
  lastPixel: { x: number; y: number } | null;
  sequentialRuns: number;
  noPointerMove: number;
  total: number;
}

const traces = new Map<number, SessionTrace>();
const MAX_TRACES = 20_000;

export function record(sig: PaintSignal): void {
  let t = traces.get(sig.sessionId);
  if (!t) {
    if (traces.size >= MAX_TRACES) traces.delete(traces.keys().next().value!);
    t = { intervals: [], lastAt: sig.at, lastPixel: null, sequentialRuns: 0, noPointerMove: 0, total: 0 };
    traces.set(sig.sessionId, t);
  }

  if (t.total > 0) t.intervals.push(sig.at - t.lastAt);
  if (t.intervals.length > 50) t.intervals.shift();

  // Adjacent in raster order is the signature of a scripted fill.
  if (t.lastPixel && sig.y === t.lastPixel.y && sig.x === t.lastPixel.x + 1) t.sequentialRuns++;

  if (sig.hadPointerMove === false) t.noPointerMove++;

  t.lastAt = sig.at;
  t.lastPixel = { x: sig.x, y: sig.y };
  t.total++;
}

/** 0..100. Recorded, logged, and currently ignored by the paint path. */
export function score(sessionId: number): number {
  const t = traces.get(sessionId);
  if (!t || t.total < 10) return 0;

  let s = 0;

  const mean = t.intervals.reduce((a, b) => a + b, 0) / t.intervals.length;
  const variance = t.intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / t.intervals.length;
  if (Math.sqrt(variance) < 50) s += 30; // metronomic

  if (t.noPointerMove / t.total > 0.9) s += 25; // teleporting cursor
  if (t.sequentialRuns / t.total > 0.7) s += 20; // raster scan
  if (t.intervals.length > 30 && mean < 200) s += 15; // superhuman rate

  return Math.min(100, s);
}

export function forget(sessionId: number): void {
  traces.delete(sessionId);
}

export function stats() {
  return { tracked: traces.size };
}
