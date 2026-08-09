/**
 * Runtime policy held in memory: protected regions and the global freeze.
 *
 * Both are read on every single paint, so neither may be a query. They are
 * cached here and refreshed whenever an admin mutates them — the admin panel
 * calls `reloadRegions()` / `setFrozen()` after writing to the DB.
 */

import { LANDMARK, type Region } from "@worldcanvas/shared";
import { pool } from "../db/pool.js";
import { hub } from "../ws/hub.js";

let regions: Region[] = [];
let frozen = false;

export function getProtectedRegions(): readonly Region[] {
  return regions;
}

export function isFrozen(): boolean {
  return frozen;
}

export async function loadPolicy(): Promise<void> {
  await reloadRegions();
  const { rows } = await pool.query<{ value: boolean }>(
    `SELECT value::text::boolean AS value FROM settings WHERE key = 'frozen'`,
  );
  frozen = rows[0]?.value ?? false;
  console.log(`[policy] ${regions.length} protected regions, frozen=${frozen}`);
}

export async function reloadRegions(): Promise<void> {
  const { rows } = await pool.query<Region>(
    `SELECT id, name, x0, y0, x1, y1 FROM protected_regions ORDER BY id`,
  );
  regions = rows;

  // The landmark is protected whether or not a row exists for it, so a
  // careless DELETE in the admin panel cannot expose it.
  if (!regions.some((r) => r.name === LANDMARK.name)) {
    regions.push({ id: -1, ...LANDMARK });
  }
}

export async function setFrozen(on: boolean): Promise<void> {
  await pool.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'frozen'`, [
    JSON.stringify(on),
  ]);
  frozen = on;
  hub.broadcast({ t: "freeze", on });
}
