import {
  PAINT_REQUEST_BURST,
  PAINT_REQUEST_MAX_IPS,
  PAINT_REQUEST_REFILL_MS,
} from "@canvasplanet/shared";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RequestLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Bounded per-key token bucket for rejecting request floods before I/O.
 *
 * Map insertion order doubles as an LRU list. Touching a key moves it to the
 * end, and admitting a new key at capacity evicts the least recently used
 * one. The limiter can therefore never become its own memory-exhaustion
 * vector during a distributed-source flood.
 */
export class RequestRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly maxKeys: number,
  ) {
    if (capacity < 1 || refillMs < 1 || maxKeys < 1) {
      throw new Error("request rate limiter values must be positive");
    }
  }

  take(key: string, now = Date.now()): RequestLimitResult {
    const existing = this.buckets.get(key);
    if (!existing) {
      this.makeRoom();
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return { allowed: true, retryAfterMs: 0 };
    }

    const elapsed = Math.max(0, now - existing.updatedAt);
    const tokens = Math.min(this.capacity, existing.tokens + elapsed / this.refillMs);
    const allowed = tokens >= 1;
    const next = {
      tokens: allowed ? tokens - 1 : tokens,
      updatedAt: now,
    };

    // Refresh LRU order without allocating a second index.
    this.buckets.delete(key);
    this.buckets.set(key, next);

    return {
      allowed,
      retryAfterMs: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) * this.refillMs)),
    };
  }

  private makeRoom(): void {
    if (this.buckets.size < this.maxKeys) return;
    const oldest = this.buckets.keys().next().value as string | undefined;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }
}

export const paintRequestRateLimiter = new RequestRateLimiter(
  PAINT_REQUEST_BURST,
  PAINT_REQUEST_REFILL_MS,
  PAINT_REQUEST_MAX_IPS,
);
