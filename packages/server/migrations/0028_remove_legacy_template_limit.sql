-- Some databases applied migration 0022 before its legacy-constraint cleanup
-- was finalized. Re-running that migration is intentionally impossible, so
-- remove the original 512px cap forward while keeping the named 4096px check.

BEGIN;

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_check;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_w_h_check;

COMMIT;
