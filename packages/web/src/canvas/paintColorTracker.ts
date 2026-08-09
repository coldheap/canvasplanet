import { WORLD_SIZE } from "@worldcanvas/shared";

export interface PaintColorAttempt {
  readonly key: number;
  readonly revision: number;
  readonly color: number;
  readonly hadPrevious: boolean;
  readonly previous: number | null;
}

/**
 * Small client-side index of colours we have actually observed or just
 * requested. It is deliberately separate from PixelInfo: live paint frames
 * contain a colour but not the terrain/country metadata needed to construct
 * a complete PixelInfo object.
 */
export class PaintColorTracker {
  private readonly colors = new Map<number, number | null>();
  private readonly revisions = new Map<number, number>();

  /** Record a server observation and invalidate any older optimistic attempt. */
  observe(x: number, y: number, color: number | null): void {
    const key = pixelKey(x, y);
    this.colors.set(key, color);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

  /** Revision used to keep a slow pixel-info response from replacing newer paint. */
  revision(x: number, y: number): number {
    return this.revisions.get(pixelKey(x, y)) ?? 0;
  }

  observeIfRevision(x: number, y: number, revision: number, color: number | null): boolean {
    if (this.revision(x, y) !== revision) return false;
    this.observe(x, y, color);
    return true;
  }

  /**
   * Optimistically record a requested colour. Returns null when the pixel is
   * already known to have that colour, so callers can avoid a pointless API
   * request and temporary charge deduction.
   */
  begin(x: number, y: number, color: number): PaintColorAttempt | null {
    const key = pixelKey(x, y);
    if (this.colors.get(key) === color && this.colors.has(key)) return null;

    const revision = (this.revisions.get(key) ?? 0) + 1;
    const attempt: PaintColorAttempt = {
      key,
      revision,
      color,
      hadPrevious: this.colors.has(key),
      previous: this.colors.get(key) ?? null,
    };
    this.colors.set(key, color);
    this.revisions.set(key, revision);
    return attempt;
  }

  /** Restore the prior colour only if nothing newer has touched this pixel. */
  rollback(attempt: PaintColorAttempt): boolean {
    if (this.revisions.get(attempt.key) !== attempt.revision) return false;
    if (attempt.hadPrevious) this.colors.set(attempt.key, attempt.previous);
    else this.colors.delete(attempt.key);
    this.revisions.set(attempt.key, attempt.revision + 1);
    return true;
  }
}

function pixelKey(x: number, y: number): number {
  return x * WORLD_SIZE + y;
}
