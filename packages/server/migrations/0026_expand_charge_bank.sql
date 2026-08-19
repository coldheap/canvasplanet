-- New sessions start at the expanded 60-charge cap. Session creation passes
-- CHARGE_START explicitly, so this default is the database-side invariant for
-- direct inserts and operational tooling. Existing balances are intentionally
-- left alone and regenerate naturally under the new cap.

BEGIN;

ALTER TABLE sessions ALTER COLUMN charges SET DEFAULT 60;

COMMIT;
