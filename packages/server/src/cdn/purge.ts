/**
 * Cloudflare edge purge.
 *
 * This used to live inside tiles/worker.ts, which was fine while tiles were
 * the only thing cached at the edge. They are not: avatars are served with
 * `s-maxage=604800` (routes/avatars.ts), so a moderator removing an abusive
 * picture only stopped the ORIGIN from serving it — Cloudflare kept handing
 * out the same bytes for up to a week. A removal that does not purge is a
 * moderation gesture, not a moderation tool.
 *
 * The batching and the swallow-on-failure behaviour are unchanged from the
 * tile version: Cloudflare accepts 30 URLs per call on the free plan, and a
 * purge failure is logged rather than raised, because a stale edge object
 * self-corrects within its s-maxage window and this must never fail the
 * operation that triggered it.
 */

import { CF_PURGE_BATCH } from "@canvasplanet/shared";
import { env } from "../env.js";

/**
 * @param label prefixes the log line so a failed purge is attributable to
 *   the subsystem that asked for it ("tiles", "avatar") rather than to a
 *   generic CDN helper nothing owns.
 */
export async function purgeCloudflare(urls: string[], label: string): Promise<void> {
  if (!env.cf.enabled || urls.length === 0) return;
  for (let i = 0; i < urls.length; i += CF_PURGE_BATCH) {
    const batch = urls.slice(i, i + CF_PURGE_BATCH);
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.cf.zoneId}/purge_cache`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.cf.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ files: batch }),
        },
      );
      if (!res.ok) console.warn(`[${label}] CF purge ${res.status}`);
    } catch (err) {
      console.warn(`[${label}] CF purge failed`, err);
    }
  }
}

/** The public URL Cloudflare has cached for one avatar revision — must match
 *  the route shape in routes/avatars.ts exactly or the purge is a no-op. */
export function avatarUrl(userId: number, revision: string): string {
  return `${env.publicUrl}/avatars/${userId}/${revision}.webp`;
}
