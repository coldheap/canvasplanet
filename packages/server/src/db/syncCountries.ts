/**
 * Keep the relational country rows aligned with the ids baked into the geo
 * index. Production runs this before accepting traffic so restoring a schema
 * without re-running the expensive geo bake cannot make every land paint fail
 * its foreign-key checks.
 */
import { pathToFileURL } from "node:url";
import { buildCountryIndex, COUNTRY_FILE, loadGeoJson } from "../geo/source.js";
import { pool } from "./pool.js";

export async function syncCountries(): Promise<number> {
  const { rows } = buildCountryIndex(await loadGeoJson(COUNTRY_FILE));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO countries (id, iso_a2, iso_a3, name, flag)
       SELECT * FROM UNNEST($1::smallint[], $2::text[], $3::text[], $4::text[], $5::text[])
       ON CONFLICT (id) DO UPDATE
         SET iso_a2 = EXCLUDED.iso_a2,
             iso_a3 = EXCLUDED.iso_a3,
             name = EXCLUDED.name,
             flag = EXCLUDED.flag`,
      [
        rows.map((row) => row.id),
        rows.map((row) => row.iso2),
        rows.map((row) => row.iso3),
        rows.map((row) => row.name),
        rows.map((row) => row.flag),
      ],
    );
    await client.query(
      `INSERT INTO country_stats (country_id)
       SELECT id FROM countries
       ON CONFLICT DO NOTHING`,
    );
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  syncCountries()
    .then((count) => console.log(`[countries] synced ${count} land countries + ocean`))
    .then(() => pool.end())
    .catch((error) => {
      console.error("[countries] sync failed", error);
      process.exit(1);
    });
}
