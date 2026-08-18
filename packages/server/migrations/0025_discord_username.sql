-- The Discord handle behind a linked account, refreshed on every Discord
-- login. Purely for staff (the admin Users tab): a Discord-only account may
-- have no email at all, which left support and ban appeals with nothing but
-- a display name the player can change. Nothing joins on this and Discord
-- usernames are mutable, so no UNIQUE and no index -- discord_id remains the
-- identity column.

BEGIN;

ALTER TABLE users ADD COLUMN discord_username TEXT;

COMMIT;
