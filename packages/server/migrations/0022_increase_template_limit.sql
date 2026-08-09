-- Large desktop artwork needs more room than the original 512px template cap.
-- Keep the database constraint in lockstep with shared/src/config.ts.

BEGIN;

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_w_h_check;
ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_check;
ALTER TABLE templates ADD CONSTRAINT templates_dimensions_check
  CHECK (w > 0 AND h > 0 AND w <= 4096 AND h <= 4096);

COMMIT;
