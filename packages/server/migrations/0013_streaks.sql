-- Streaks (ROADMAP.md Phase 6) — cosmetic-only for now, by explicit decision:
-- a milestone charge bonus was considered and deliberately deferred, not
-- forgotten.
--
-- Three columns on user_stats, updated inside the same paint transaction as
-- the existing gain_user CTE (paint/service.ts), guarded on the same
-- `user_id IS NOT NULL` condition every other per-user stat here already
-- uses. UTC day boundary, matching how pixel_events timestamps already work.

BEGIN;

ALTER TABLE user_stats
  ADD COLUMN last_paint_date DATE,
  ADD COLUMN streak_days INT NOT NULL DEFAULT 0,
  ADD COLUMN best_streak INT NOT NULL DEFAULT 0;

COMMIT;
