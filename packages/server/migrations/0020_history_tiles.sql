-- History mode reconstructs one native tile at a selected timestamp. Lead
-- with the tile coordinates so each request stays inside one small index
-- range even after pixel_events has accumulated years of world-wide paints.

BEGIN;

CREATE INDEX IF NOT EXISTS pixel_events_history_tile_idx
  ON pixel_events ((x >> 8), (y >> 8), x, y, created_at DESC, id DESC);

COMMIT;
