-- User-uploaded profile pictures. The normalized WebP lives in Postgres so
-- it follows the same backup/restore path as the account it belongs to.
-- A random revision makes every replacement a new cache key without putting
-- image bytes on the user row read by authentication requests.

BEGIN;

CREATE TABLE user_avatars (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision   UUID UNIQUE NOT NULL,
  image      BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (octet_length(image) <= 524288)
);

COMMIT;
