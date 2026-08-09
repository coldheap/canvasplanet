-- Discord OAuth (ROADMAP.md §5.1 fast-follow). A Discord-only account has no
-- password to set at signup time, and Discord may not return a verified
-- email at all (some accounts have none), so both columns that were NOT NULL
-- for the email/password path have to give way here. CITEXT/UNIQUE both
-- still work with NULL — Postgres never treats two NULLs as equal, so
-- multiple password-less or email-less accounts coexist fine.

BEGIN;

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN discord_id TEXT UNIQUE;

COMMIT;
