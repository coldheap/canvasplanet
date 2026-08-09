/**
 * The dirty-tile worker.
 *
 * Paint marks tiles dirty and returns immediately; this drains the queue on a
 * fixed interval. The debounce is the entire point: a tile taking 100 paints
 * in two seconds re-renders once, not 100 times. Clients see no lag because
 * the WS overlay canvas covers the gap.
 *
 * Drains z12 first so parents downsample from already-fresh children.
 */

import { CF_PURGE_BATCH, TILE_WORKER_BATCH } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";
import { env } from "../env.js";
import { evict, tileUrl, writeTile } from "./cache.js";
import { renderTile } from "./renderer.js";

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastDrain = { tiles: 0, ms: 0 };

/** A drain taking longer than this is assumed wedged, not slow. */
const DRAIN_WATCHDOG_MS = 60_000;
let drainStartedAt = 0;

export function startTileWorker(): void {
  timer = setInterval(() => {
    // Skip rather than queue if the previous drain is still going — under a
    // paint flood we want to fall behind gracefully, not pile up overlapping
    // renders of the same tiles.
    if (running) {
      // ...but "still going" must not mean "forever". A single wedged drain
      // used to disable the worker permanently and silently: `running` stayed
      // true, every later tick skipped, and the canvas quietly stopped
      // updating with nothing in the logs. Recover, and say so loudly.
      if (Date.now() - drainStartedAt > DRAIN_WATCHDOG_MS) {
        console.error(
          `[tiles] drain wedged for ${((Date.now() - drainStartedAt) / 1000).toFixed(0)}s — resetting`,
        );
        running = false;
      }
      return;
    }
    void drain();
  }, env.tileWorkerIntervalMs);
}

export function stopTileWorker(): void {
  if (timer) clearInterval(timer);
}

async function drain(): Promise<void> {
  running = true;
  const started = Date.now();
  drainStartedAt = started;
  try {
    // Leaf-first (z DESC) so a parent downsamples from already-fresh
    // children. Note the trade-off: if z12 tiles ever arrive faster than the
    // batch can drain them, lower zooms starve and the world view stops
    // updating. The propagation chain adds only ~1/3 again on top of the leaf
    // rate (each level is a quarter of the one below), so the headroom is
    // wide — but if the queue depth on the admin dashboard climbs and stays
    // up, this ordering is the reason the zoomed-out view looks frozen.
    const { rows } = await pool.query<{ z: number; x: number; y: number }>(
      `DELETE FROM tile_dirty
        WHERE (z, x, y) IN (
          SELECT z, x, y FROM tile_dirty
           ORDER BY z DESC, marked_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING z, x, y`,
      [TILE_WORKER_BATCH],
    );
    if (rows.length === 0) return;

    const urls: string[] = [];
    // Parents of everything rendered this pass. The paint path deliberately
    // records only the z12 tile — writing the whole 13-deep ancestry on every
    // paint was 13 index insertions and their WAL on the request path, to
    // record something derivable. Collecting parents here instead means a
    // thousand paints sharing a tile mark its parent once, not a thousand
    // times.
    const parents = new Map<string, { z: number; x: number; y: number }>();

    for (const { z, x, y } of rows) {
      // Yield to the event loop between tiles.
      //
      // The API, the WebSocket hub and this worker all share one thread, and
      // PNG encoding is synchronous CPU work. Rendering a batch back to back
      // blocks the loop for as long as the whole batch takes, and every
      // paint request that arrives meanwhile simply waits — which showed up
      // as a fine median with a p99 in the hundreds of milliseconds and
      // occasional multi-second spikes.
      //
      // Yielding caps the blocking at a single tile (~1-5ms). The real fix is
      // a worker thread; this is the one-line version that removes most of
      // the tail.
      await new Promise((resolve) => setImmediate(resolve));

      try {
        const buf = await renderTile(z, x, y, "color");
        await writeTile(z, x, y, buf, "color");
        evict(z, x, y, "color");
        urls.push(tileUrl(z, x, y));

        // Same tile, the density render. Without this the heat pyramid's
        // parent levels never get fresh children — peekTile only reads the
        // cache, so an un-rendered heat leaf leaves every ancestor above it
        // permanently missing that quadrant instead of merely stale.
        if (env.heatmapWorkerEnabled) {
          const heatBuf = await renderTile(z, x, y, "heat");
          await writeTile(z, x, y, heatBuf, "heat");
          evict(z, x, y, "heat");
          urls.push(tileUrl(z, x, y).replace("/tiles/", "/tiles/heat/"));
        }

        if (z > 0) parents.set(`${z - 1}/${x >> 1}/${y >> 1}`, { z: z - 1, x: x >> 1, y: y >> 1 });
      } catch (err) {
        console.error(`[tiles] render failed ${z}/${x}/${y}`, err);
        // Re-mark so the tile is retried rather than silently left stale.
        await pool
          .query(`INSERT INTO tile_dirty (z,x,y) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [z, x, y])
          .catch(() => {});
      }
    }

    // Enqueue the parents. Each tick lifts the chain one level, so a paint
    // reaches the world view in about a dozen ticks — coarse zoom levels are
    // not watched pixel-by-pixel, and the z12 tile the painter is actually
    // looking at was already refreshed in this pass.
    if (parents.size > 0) {
      const list = [...parents.values()];
      await pool.query(
        `INSERT INTO tile_dirty (z, x, y)
         SELECT * FROM UNNEST($1::smallint[], $2::int[], $3::int[])
         ON CONFLICT (z, x, y) DO NOTHING`,
        [list.map((t) => t.z), list.map((t) => t.x), list.map((t) => t.y)],
      );
    }

    await purgeCloudflare(urls);
    lastDrain = { tiles: rows.length, ms: Date.now() - started };
  } catch (err) {
    console.error("[tiles] drain failed", err);
  } finally {
    running = false;
  }
}

/**
 * Cloudflare accepts 30 URLs per purge call on the free plan. A purge failure
 * is logged and swallowed — a stale edge tile self-corrects within the
 * s-maxage window, and it must never fail a paint.
 */
async function purgeCloudflare(urls: string[]): Promise<void> {
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
      if (!res.ok) console.warn(`[tiles] CF purge ${res.status}`);
    } catch (err) {
      console.warn("[tiles] CF purge failed", err);
    }
  }
}

export async function queueDepth(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM tile_dirty`);
  return rows[0]?.n ?? 0;
}

export function workerStats() {
  return { running, lastDrain };
}
