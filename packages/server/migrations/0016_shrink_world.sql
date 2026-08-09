-- Shrink the world grid: Z_PIXEL 12 -> 8, WORLD_SIZE 1,048,576 -> 65,536 px
-- per axis (packages/shared/src/config.ts). A deliberate full reset, not a
-- coordinate migration — old (x,y) values have no sane mapping onto a 16x
-- smaller grid, so this wipes every table whose data is grid/pixel-derived
-- rather than trying to rescale it. Identity data (accounts, sessions,
-- staff, alliance/country entities themselves) is untouched; only the
-- canvas and everything counted from it resets to zero.
--
-- This can't be done by editing 0001_init.sql's `pixels.tile_id` generated
-- column in place — that migration has already run on every environment
-- that's ever booted this app, and the runner tracks applied filenames, not
-- content hashes (see project memory: editing an applied migration is a
-- silent no-op everywhere it already ran). A new migration is the only way
-- to change the formula.
--
-- Order matters: wipe first (nothing left to satisfy the old generated
-- column while it's redefined), then drop the index before the column it
-- depends on, then rebuild both.

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
-- Matches coords.ts's tileIdOf() — TILES_PER_AXIS is 256 at the new Z_PIXEL=8.
ALTER TABLE pixels ADD COLUMN tile_id BIGINT GENERATED ALWAYS AS ((x >> 8) * 256 + (y >> 8)) STORED;
CREATE INDEX pixels_tile_idx ON pixels (tile_id) INCLUDE (x, y, color);

UPDATE country_stats SET cumulative = 0, held = 0;
UPDATE alliance_stats SET cumulative = 0, held = 0;
UPDATE user_stats SET cumulative = 0, held = 0, last_paint_date = NULL, streak_days = 0, best_streak = 0;
UPDATE sessions SET total_paints = 0;

COMMIT;
