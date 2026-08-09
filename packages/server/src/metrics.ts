/**
 * Event-loop lag.
 *
 * The API, the WebSocket hub and the tile worker all share one thread, so
 * anything that blocks it shows up as latency on every request regardless of
 * how fast that request's own work is. A healthy median with a bad p99 is the
 * classic signature, and without this metric it is indistinguishable from a
 * slow database.
 *
 * Measured by scheduling a timer and recording how late it actually fires.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

/** Rolling window, reset each time it is read by the dashboard. */
export function eventLoopLag(): { meanMs: number; p50Ms: number; p99Ms: number; maxMs: number } {
  const toMs = (ns: number) => Math.round((ns / 1e6) * 100) / 100;
  const out = {
    meanMs: toMs(histogram.mean),
    p50Ms: toMs(histogram.percentile(50)),
    p99Ms: toMs(histogram.percentile(99)),
    maxMs: toMs(histogram.max),
  };
  return out;
}

export function resetEventLoopLag(): void {
  histogram.reset();
}

/**
 * Time an async operation and keep a rolling mean. Used to attribute tile
 * work between the database and the CPU-bound encode, which is the thing
 * this codebase can actually act on.
 */
export class Timing {
  private total = 0;
  private count = 0;
  private max = 0;

  async measure<T>(fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      const ms = performance.now() - started;
      this.total += ms;
      this.count++;
      if (ms > this.max) this.max = ms;
    }
  }

  measureSync<T>(fn: () => T): T {
    const started = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - started;
      this.total += ms;
      this.count++;
      if (ms > this.max) this.max = ms;
    }
  }

  stats(): { n: number; meanMs: number; maxMs: number } {
    return {
      n: this.count,
      meanMs: this.count ? Math.round((this.total / this.count) * 100) / 100 : 0,
      maxMs: Math.round(this.max * 100) / 100,
    };
  }

  reset(): void {
    this.total = 0;
    this.count = 0;
    this.max = 0;
  }
}

/** Where tile time actually goes: querying pixels vs encoding the PNG. */
export const tileQueryTime = new Timing();
export const tileEncodeTime = new Timing();
