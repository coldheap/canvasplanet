/**
 * Pure corruption-zone bookkeeping (ROADMAP.md Phase 7), split out from
 * events/engine.ts so the actual tug-of-war arithmetic — corruption %,
 * defender credit, win/lose — is testable without a database, the same way
 * economy.ts's regenerate/spend are pure while paint/service.ts (the I/O
 * around them) is not.
 */

import { EVENT_WIN_THRESHOLD, EVENT_ZONE_SIZE, type Bbox, type EventStateDTO } from "@worldcanvas/shared";

const ZONE_AREA = EVENT_ZONE_SIZE * EVENT_ZONE_SIZE;

export class ActiveEventState {
  /** "x,y" keys currently showing the bot's colour — corruptionPct's numerator. */
  readonly corrupted = new Set<string>();
  /** Distinct sessions that have landed at least one defending paint. */
  readonly defenders = new Set<number>();

  constructor(
    readonly id: number,
    readonly bbox: Bbox,
    readonly botColor: number,
    readonly startedAt: number,
    readonly endsAt: number,
    readonly batchId: string,
  ) {}

  /** True if (x,y) falls inside this event's zone. */
  contains(x: number, y: number): boolean {
    return x >= this.bbox.x0 && x <= this.bbox.x1 && y >= this.bbox.y0 && y <= this.bbox.y1;
  }

  /**
   * Corruption membership is tracked from actual visual state, not "who
   * undid what": a zone pixel currently showing the bot colour counts as
   * corrupted regardless of who last painted it there. Defender credit is
   * literal per the roadmap spec — any session painting a different colour
   * inside the zone, whether or not that pixel had been corrupted yet.
   */
  notePaint(x: number, y: number, color: number, sessionId: number | null): void {
    const key = `${x},${y}`;
    if (color === this.botColor) {
      this.corrupted.add(key);
    } else {
      this.corrupted.delete(key);
      if (sessionId !== null) this.defenders.add(sessionId);
    }
  }

  corruptionPct(): number {
    return this.corrupted.size / ZONE_AREA;
  }

  /** Judged at the timer's end: defenders win iff corruption stayed under
   *  EVENT_WIN_THRESHOLD. */
  result(): "defended" | "corrupted" {
    return this.corruptionPct() < EVENT_WIN_THRESHOLD ? "defended" : "corrupted";
  }

  toDTO(): EventStateDTO {
    return {
      id: this.id,
      bbox: this.bbox,
      botColor: this.botColor,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      corruptionPct: this.corruptionPct(),
      defenders: this.defenders.size,
    };
  }
}
