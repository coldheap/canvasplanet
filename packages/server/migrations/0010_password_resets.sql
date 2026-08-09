-- Password reset (ROADMAP.md §5.1 follow-up) — same one-shot hashed token
-- shape as email_verifications (0009_users.sql), a separate table because a
-- reset link is a stronger capability (a live one hands over the account
-- outright) with its own shorter TTL, not a variant of the verify flow.

BEGIN;

CREATE TABLE password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

COMMIT;
