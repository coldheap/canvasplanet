-- Alliances / teams (ROADMAP.md §4.1) — named groups with a colour and their
-- own leaderboard beside countries. Country rivalry is the built-in hook;
-- this lets communities that are not a country organise too.
--
-- Mirrors the countries/country_stats/sessions.last_country_id shape
-- exactly: one alliance per session (last one you painted for, same rule as
-- country), a denormalised stats table updated inside the paint transaction,
-- and alliance_id carried on pixels/pixel_events so "held" can be corrected
-- on overpaint the same way country held is.

BEGIN;

CREATE TABLE alliances (
  id          SMALLSERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  color       SMALLINT NOT NULL,   -- palette index, packages/shared/src/palette.ts
  created_by  BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ          -- soft delete, same pattern as templates/staff
);

CREATE TABLE alliance_stats (
  alliance_id SMALLINT PRIMARY KEY REFERENCES alliances(id),
  cumulative  BIGINT NOT NULL DEFAULT 0,
  held        BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE sessions ADD COLUMN alliance_id SMALLINT REFERENCES alliances(id);
-- Join/leave has no natural "events" table to count against the way reports
-- or templates do (you don't repeatedly join the same alliance, you switch),
-- so abuse is capped with a cooldown timestamp instead of a rolling count.
ALTER TABLE sessions ADD COLUMN alliance_changed_at TIMESTAMPTZ;
CREATE INDEX sessions_alliance_idx ON sessions (alliance_id) WHERE alliance_id IS NOT NULL;

-- Needed so a change of alliance ownership can be detected on overpaint,
-- the same way pixels.country_id lets the paint transaction find
-- prevCountryId. Without this, "held" could only ever climb.
ALTER TABLE pixels ADD COLUMN alliance_id SMALLINT REFERENCES alliances(id);
ALTER TABLE pixel_events ADD COLUMN alliance_id SMALLINT REFERENCES alliances(id);
CREATE INDEX pixels_alliance_idx ON pixels (alliance_id) WHERE alliance_id IS NOT NULL;

COMMIT;
