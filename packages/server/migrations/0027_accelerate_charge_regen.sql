-- Keep the IP-wide anti-abuse bucket aligned with the new one-charge-per-second
-- economy. Scaling existing balances preserves the same fraction of each
-- bucket rather than making active addresses start almost empty after deploy.

BEGIN;

ALTER TABLE ip_budget ALTER COLUMN tokens SET DEFAULT 3600;
UPDATE ip_budget SET tokens = LEAST(3600, tokens * 30);

COMMIT;
