-- Persistent global chat and its moderation trail. Messages and reports are
-- soft-deleted/resolved so staff actions never destroy the evidence they were
-- based on. There is intentionally no retention job: chat is paginated by id
-- and remains available for later moderation.

BEGIN;

CREATE TABLE chat_messages (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  original_body TEXT NOT NULL,
  display_body  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  deleted_by    BIGINT REFERENCES users(id),
  delete_reason TEXT,
  CHECK (char_length(original_body) BETWEEN 1 AND 400),
  -- Censoring a short term with five asterisks can make the display form a
  -- little longer than the 400-character original.
  CHECK (char_length(display_body) BETWEEN 1 AND 1000)
);
CREATE INDEX chat_messages_user_created_idx ON chat_messages (user_id, created_at DESC);

CREATE TABLE chat_reports (
  id             BIGSERIAL PRIMARY KEY,
  message_id     BIGINT NOT NULL REFERENCES chat_messages(id),
  reporter_id    BIGINT NOT NULL REFERENCES users(id),
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  resolved_by    BIGINT REFERENCES users(id),
  resolution     TEXT,
  UNIQUE (message_id, reporter_id),
  CHECK (reason IS NULL OR char_length(reason) <= 400)
);
CREATE INDEX chat_reports_open_idx ON chat_reports (created_at) WHERE resolved_at IS NULL;

CREATE TABLE chat_mutes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  until_at    TIMESTAMPTZ, -- NULL means permanent
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT NOT NULL REFERENCES users(id),
  revoked_at  TIMESTAMPTZ,
  revoked_by  BIGINT REFERENCES users(id),
  CHECK (reason IS NULL OR char_length(reason) <= 400)
);
CREATE INDEX chat_mutes_active_user_idx ON chat_mutes (user_id, created_at DESC)
  WHERE revoked_at IS NULL;

COMMIT;
