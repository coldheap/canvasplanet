-- CanvasPlanet v1 — initial schema.
-- See PLAN.md §3 for the reasoning behind each table.

BEGIN;

-- ===========================================================================
-- Countries
-- ===========================================================================

CREATE TABLE countries (
  id      SMALLINT PRIMARY KEY,
  iso_a2  CHAR(2)  NOT NULL,
  iso_a3  CHAR(3),
  name    TEXT     NOT NULL,
  flag    TEXT
);

-- id 0 is reserved for ocean / unattributed pixels so that country_id can be
-- NOT NULL everywhere and the paint path never branches on null.
INSERT INTO countries (id, iso_a2, iso_a3, name, flag)
VALUES (0, 'XX', 'XXX', 'International Waters', '🌊');

CREATE TABLE country_stats (
  country_id SMALLINT PRIMARY KEY REFERENCES countries(id),
  cumulative BIGINT NOT NULL DEFAULT 0,   -- every paint ever; monotonic
  held       BIGINT NOT NULL DEFAULT 0    -- pixels currently owned; zero-sum
);
INSERT INTO country_stats (country_id) VALUES (0);

-- ===========================================================================
-- Sessions — anonymous identity and the charge ledger
-- ===========================================================================

CREATE TABLE sessions (
  id                 BIGSERIAL PRIMARY KEY,
  token_hash         BYTEA NOT NULL UNIQUE,        -- sha256(cookie value)
  charges            SMALLINT NOT NULL DEFAULT 30,
  charges_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                 INET,
  asn                INTEGER,
  ua_hash            BYTEA,
  turnstile_ok       BOOLEAN NOT NULL DEFAULT false,
  last_country_id    SMALLINT REFERENCES countries(id),
  banned_until       TIMESTAMPTZ,
  total_paints       INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_ip_idx        ON sessions (ip);
CREATE INDEX sessions_last_seen_idx ON sessions (last_seen_at);

-- ===========================================================================
-- The canvas
-- ===========================================================================

CREATE TABLE pixels (
  x           INTEGER  NOT NULL,
  y           INTEGER  NOT NULL,
  -- Matches coords.ts tileIdOf(). Keep the two in lockstep.
  tile_id     BIGINT   GENERATED ALWAYS AS ((x >> 8) * 4096 + (y >> 8)) STORED,
  color       SMALLINT NOT NULL,
  country_id  SMALLINT NOT NULL REFERENCES countries(id),
  session_id  BIGINT,
  staff_id    INTEGER,
  paint_count INTEGER  NOT NULL DEFAULT 1,
  painted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (x, y)
);

-- Every tile render is exactly one index range scan on this.
CREATE INDEX pixels_tile_idx ON pixels (tile_id) INCLUDE (x, y, color);
CREATE INDEX pixels_country_idx ON pixels (country_id);

-- ===========================================================================
-- History — append-only, partitioned monthly
-- ===========================================================================

CREATE TABLE pixel_events (
  id         BIGSERIAL,
  x          INTEGER  NOT NULL,
  y          INTEGER  NOT NULL,
  color      SMALLINT NOT NULL,
  prev_color SMALLINT,               -- NULL = the pixel was unpainted
  country_id SMALLINT NOT NULL REFERENCES countries(id),
  session_id BIGINT,
  staff_id   INTEGER,
  ip         INET,
  cost       SMALLINT NOT NULL,
  batch_id   UUID,                   -- groups admin stamps and reverts
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Bootstrap partitions. `scripts/ensure-partitions.ts` (run from cron) keeps
-- one month ahead. A missing partition is an insert error, so this matters.
CREATE TABLE pixel_events_default PARTITION OF pixel_events DEFAULT;

-- BRIN is the right index for a strictly append-ordered timestamp column:
-- ~100x smaller than a btree, and time-range revert queries only need
-- block-level pruning.
CREATE INDEX pixel_events_created_brin ON pixel_events USING BRIN (created_at);
CREATE INDEX pixel_events_session_idx  ON pixel_events (session_id, created_at DESC);
CREATE INDEX pixel_events_xy_idx     ON pixel_events (x, y, id DESC);
CREATE INDEX pixel_events_batch_idx    ON pixel_events (batch_id) WHERE batch_id IS NOT NULL;

-- ===========================================================================
-- Rate limiting
-- ===========================================================================

CREATE TABLE ip_budget (
  ip            INET PRIMARY KEY,
  tokens        REAL NOT NULL DEFAULT 120,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  new_sessions  INTEGER NOT NULL DEFAULT 0,
  flagged_asn   BOOLEAN NOT NULL DEFAULT false
);

-- ===========================================================================
-- Staff, moderation, protection
-- ===========================================================================

CREATE TYPE staff_role AS ENUM ('mod', 'admin');

CREATE TABLE staff (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- argon2id
  role          staff_role NOT NULL,
  disabled_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  id         BIGSERIAL PRIMARY KEY,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token_hash BYTEA UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_expiry_idx ON staff_sessions (expires_at);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  staff_id   INTEGER REFERENCES staff(id),
  action     TEXT NOT NULL,
  params     JSONB NOT NULL DEFAULT '{}'::jsonb,
  affected   INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

CREATE TABLE protected_regions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  x0         INTEGER NOT NULL,
  y0         INTEGER NOT NULL,
  x1         INTEGER NOT NULL,
  y1         INTEGER NOT NULL,
  created_by INTEGER REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (x1 >= x0 AND y1 >= y0)
);

CREATE TABLE bans (
  id         BIGSERIAL PRIMARY KEY,
  ip         INET,
  session_id BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
  until      TIMESTAMPTZ,              -- NULL = permanent
  reason     TEXT,
  staff_id   INTEGER REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ip IS NOT NULL OR session_id IS NOT NULL)
);
CREATE INDEX bans_ip_idx      ON bans (ip)         WHERE ip IS NOT NULL;
CREATE INDEX bans_session_idx ON bans (session_id) WHERE session_id IS NOT NULL;

-- ===========================================================================
-- Templates and tile invalidation
-- ===========================================================================

CREATE TABLE templates (
  id         UUID PRIMARY KEY,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  w          INTEGER NOT NULL,
  h          INTEGER NOT NULL,
  data       BYTEA NOT NULL,          -- one byte per pixel; 255 = transparent
  created_by BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  views      INTEGER NOT NULL DEFAULT 0,
  removed_at TIMESTAMPTZ,             -- soft delete, set from the admin panel
  CHECK (w > 0 AND h > 0 AND w <= 512 AND h <= 512)
);

CREATE TABLE tile_dirty (
  z         SMALLINT NOT NULL,
  x         INTEGER  NOT NULL,
  y         INTEGER  NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (z, x, y)
);
-- Worker drains leaf-first so parents downsample from fresh children.
CREATE INDEX tile_dirty_order_idx ON tile_dirty (z DESC, marked_at);

-- ===========================================================================
-- Global switches
-- ===========================================================================

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
INSERT INTO settings (key, value) VALUES ('frozen', 'false'::jsonb);

COMMIT;
