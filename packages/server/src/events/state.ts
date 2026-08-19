/**
 * Pure corruption-zone bookkeeping (ROADMAP.md Phase 7), split out from
 * events/engine.ts so the actual tug-of-war arithmetic — corruption %,
 * defender credit, win/lose — is testable without a database, the same way
 * economy.ts's regenerate/spend are pure while paint/service.ts (the I/O
 * around them) is not.
 */

import {
  EVENT_BOT_PLAYER_PIXEL_COST,
  EVENT_ROLLBACK_PADDING,
  EVENT_WIN_THRESHOLD,
  EVENT_ZONE_SIZE,
  PAINT_BOUNDS,
  WORLD_SIZE,
  type Bbox,
  type EventStateDTO,
} from "@canvasplanet/shared";

const ZONE_AREA = EVENT_ZONE_SIZE * EVENT_ZONE_SIZE;

/** A server paint uses twice the normal tick budget when it takes a pixel
 * currently held by a player. Anonymous players still have a session id, so
 * this covers every ordinary player paint rather than only signed-in users. */
export function botPaintWorkCost(previousSessionId: number | null): number {
  return previousSessionId === null ? 1 : EVENT_BOT_PLAYER_PIXEL_COST;
}

/** The rollback reaches a few pixels beyond the visible contest rectangle,
 * clipped to the configured paintable world. */
export function eventRollbackBbox(bbox: Bbox): Bbox {
  const bounds = PAINT_BOUNDS ?? { x0: 0, y0: 0, x1: WORLD_SIZE - 1, y1: WORLD_SIZE - 1 };
  return {
    x0: Math.max(bounds.x0, bbox.x0 - EVENT_ROLLBACK_PADDING),
    y0: Math.max(bounds.y0, bbox.y0 - EVENT_ROLLBACK_PADDING),
    x1: Math.min(bounds.x1, bbox.x1 + EVENT_ROLLBACK_PADDING),
    y1: Math.min(bounds.y1, bbox.y1 + EVENT_ROLLBACK_PADDING),
  };
}

export class ActiveEventState {
  /** "x,y" keys currently showing the bot's colour — corruptionPct's numerator. */
  readonly corrupted = new Set<string>();
  /** Distinct sessions that have landed at least one defending paint. */
  readonly defenders = new Set<number>();
  private resolving = false;
  private resolvedResult: "defended" | "corrupted" | null = null;

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

  /** Includes the cleanup margin used to drain writes before rollback. */
  containsRollbackArea(x: number, y: number): boolean {
    const bbox = eventRollbackBbox(this.bbox);
    return x >= bbox.x0 && x <= bbox.x1 && y >= bbox.y0 && y <= bbox.y1;
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

  /** Stops presenting the deadline as an active 0:00 countdown. The result
   *  is filled in after any already-running bot paint has committed. */
  beginResolving(): void {
    this.resolving = true;
  }

  isResolving(): boolean {
    return this.resolving;
  }

  /** Freeze the outcome exactly once so cleanup retries cannot change it. */
  resolve(): "defended" | "corrupted" {
    this.resolving = true;
    this.resolvedResult ??= this.result();
    return this.resolvedResult;
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
      status: this.resolving ? "resolving" : "active",
      result: this.resolvedResult,
    };
  }
}
