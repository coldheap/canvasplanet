-- Restore the native paint grid from Web Mercator z8 to z12. At z8 one
-- logical paint covered roughly 611 m at the equator and became a 16x16
-- screen block at z12. The z12 grid makes a native paint roughly 38 m and
-- aligns it with one screen pixel at the minimum paint zoom.
--
-- The two grids do not have a lossless one-pixel-to-one-pixel conversion:
-- preserving the geographic footprint of each z8 pixel would create 256
-- z12 pixels and inflate every event and ownership count. As with the z12 ->
-- z8 migration, reset only pixel/grid-derived data and preserve identities,
-- sessions, accounts, alliances, and countries.

BEGIN;

TRUNCATE
  pixels,
  pixel_events,
  tile_dirty,
  templates,
  template_reports,
  area_reports,
  protected_regions,
  corruption_events,
  timelapse_exports;

DROP INDEX pixels_tile_idx;
ALTER TABLE pixels DROP COLUMN tile_id;
-- Matches coords.ts's tileIdOf(): 4096 native tiles per axis at Z_PIXEL=12.
ALTER TABLE pixels ADD COLUMN tile_id BIGINT GENERATED ALWAYS AS ((x >> 8) * 4096 + (y >> 8)) STORED;
CREATE INDEX pixels_tile_idx ON pixels (tile_id) INCLUDE (x, y, color);

UPDATE country_stats SET cumulative = 0, held = 0;
UPDATE alliance_stats SET cumulative = 0, held = 0;
UPDATE user_stats SET cumulative = 0, held = 0, last_paint_date = NULL, streak_days = 0, best_streak = 0;
UPDATE sessions SET total_paints = 0;

COMMIT;
