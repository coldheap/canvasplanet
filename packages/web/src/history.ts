import { HISTORY_BUCKET_MS, HISTORY_MAX_AGE_MS } from "@worldcanvas/shared";

export function normalizeHistoryAt(at: number, now = Date.now()): number {
  const bounded = Math.max(now - HISTORY_MAX_AGE_MS, Math.min(at, now));
  return Math.floor(bounded / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
}
