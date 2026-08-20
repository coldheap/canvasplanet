/**
 * Convert a server-owned epoch deadline into this browser's clock domain.
 *
 * Server and device clocks are not guaranteed to agree. Comparing `nextAt`
 * directly with `Date.now()` can therefore make a partially full bank look
 * many recharge periods overdue and jump straight to full. Only the duration
 * between the two server timestamps is meaningful to the browser.
 */
export function localChargeDeadline(
  nextAt: number | null,
  serverNow: number,
  clientNow = Date.now(),
): number | null {
  if (nextAt === null) return null;
  if (!Number.isFinite(serverNow)) return nextAt;
  return clientNow + Math.max(0, nextAt - serverNow);
}

/** Reject a balance snapshot that was created before one already applied. */
export function isNewerChargeSnapshot(
  bankVersion: number,
  serverNow: number,
  currentVersion: number,
  currentServerNow: number,
): boolean {
  return (
    bankVersion > currentVersion ||
    (bankVersion === currentVersion && serverNow > currentServerNow)
  );
}
