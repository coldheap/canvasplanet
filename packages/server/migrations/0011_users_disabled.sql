-- Admin-facing Users tab (ROADMAP.md §5.1 deferred piece): mods need a way to
-- disable a player account, the same "disabled_at, cut live sessions" shape
-- staff.disabled_at (0001_init.sql) and alliances.disabled_at (0006_alliances.sql)
-- already use. Not present in 0009_users.sql because there was nothing to
-- moderate yet at zero signup volume.

BEGIN;

ALTER TABLE users ADD COLUMN disabled_at TIMESTAMPTZ;

COMMIT;
