-- Player accounts (ROADMAP.md §5.1) — email/password now, Discord OAuth as a
-- fast-follow. Deliberately separate from `sessions`, not a rename of it:
-- sessions keeps doing the rate-limit/ban/charge job it does today, and
-- `sessions.user_id` is the only link between the two, set at login/signup on
-- whichever session cookie the browser currently holds. Anonymous play is
-- completely unaffected — this adds a claimable identity on top, it does not
-- gate paint eligibility.
--
-- Mirrors the alliances precedent (0006_alliances.sql) closely: a
-- denormalised *_stats table updated inside the paint transaction, and a
-- nullable attribution column on pixels/pixel_events so an overpaint can find
-- the previous owning user the same way it already finds the previous
-- country/alliance.

BEGIN;

-- CITEXT gives case-insensitive UNIQUE for free (a plain UNIQUE index on
-- lower(x) would work too, but then every query needs the same lower()
-- wrapper to hit it — CITEXT makes "unique, case-insensitive" the type's
-- job instead of every call site's).
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id                BIGSERIAL PRIMARY KEY,
  email             CITEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  display_name      CITEXT UNIQUE NOT NULL,
  email_verified_at TIMESTAMPTZ,          -- NULL = signup pending verification
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Long-lived login cookie, same token_hash/expires_at shape as staff_sessions
-- — not a reuse of the anonymous session cookie, which churns on its own
-- SESSION_TTL_DAYS schedule independent of whether someone is logged in.
CREATE TABLE user_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

-- One-shot tokens for both the initial verification link and a resend. Old
-- rows are not cleaned up inline (same "sweep, don't block the hot path"
-- reasoning as export/queue.ts) — a low-volume table, fine to prune later.
CREATE TABLE email_verifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);

CREATE TABLE user_stats (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id),
  cumulative BIGINT NOT NULL DEFAULT 0,
  held       BIGINT NOT NULL DEFAULT 0
);

-- The link: nullable, so the vast majority of sessions (never logged in)
-- never touch anything below. Deliberately not merged into `sessions` — see
-- the file header.
ALTER TABLE sessions ADD COLUMN user_id BIGINT REFERENCES users(id);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE pixels ADD COLUMN user_id BIGINT REFERENCES users(id);
ALTER TABLE pixel_events ADD COLUMN user_id BIGINT REFERENCES users(id);
CREATE INDEX pixels_user_idx ON pixels (user_id) WHERE user_id IS NOT NULL;

COMMIT;
