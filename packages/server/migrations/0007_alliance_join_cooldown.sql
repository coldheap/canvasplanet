-- 0006_alliances.sql was already applied on some environments (this dev box
-- included) before alliance_changed_at was added to it. The migration
-- runner is forward-only and tracks by filename, so editing an already-
-- applied file does nothing there — this patches those environments up to
-- match what a fresh install now gets from 0006 in one shot.

BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS alliance_changed_at TIMESTAMPTZ;

COMMIT;
