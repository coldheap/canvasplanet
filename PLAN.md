# CanvasPlanet — v1 Build Plan

A persistent, live pixel-art canvas layered on a real world map. Anonymous
users paint one pixel at a time from a charge bank; nothing ever resets; a live
leaderboard tracks pixels per country.

This document is the contract. Every constant in it lives in
`packages/shared/src/config.ts` so it can be tuned in one place.

---

## 0. Resolved decisions

Everything below was decided during planning. Where a decision contradicts the
original MVP prompt, the reason is noted.

| # | Decision | Value |
|---|---|---|
| 1 | Pixel grid | Web Mercator **zoom 12** — 1,048,576 × 1,048,576 pixels, **~38.22 m/px** at the equator |
| 2 | Cooldown | **Charge bank**: +1 per 30s, cap 60, spendable in bursts |
| 3 | New session | Starts with a **full bank of 60** |
| 4 | History | `pixels` (current state) **+ append-only `pixel_events`** |
| 5 | Cost table | base **2**, overpaint **4**, terrain-violating **4**, restore **2** |
| 6 | Leaderboard | **Both** all-time cumulative and currently-held, toggled in the panel |
| 7 | Leaderboard UX | World total + top 10 + **your country pinned**, expandable to full list |
| 8 | Render path | **Server-rendered PNG tiles** + WS delta overlay |
| 9 | Map library | **Leaflet + OSM raster** |
| 10 | Ocean | Paintable, attributed to **International Waters** |
| 11 | Terrain rule | Water-family color on land, or land-family color on sea, = violation |
| 12 | Palette | **32 colors, 5 tagged water**, other 27 land |
| 13 | Geo data | **NE 1:10m admin_0** for country, **OSM water polygons** for terrain |
| 14 | WS fan-out | **Viewport subscriptions** (z10 tiles) + global leaderboard tick |
| 15 | Paint zoom | **z12 and in only**; below that, view-only with a hint |
| 16 | First view | **Seeded protected landmark at Null Island** (0°, 0°) |
| 17 | Protection | **DB-backed protected regions**, admin-editable live |
| 18 | Hosting | **Single VPS, Docker Compose, Cloudflare in front** |
| 19 | Tile cache | **Dirty-mark + debounced re-render**, batched CF purge |
| 20 | IP ceiling | **IP-wide token bucket, 120 charges/hour** (60 base-cost placements) |
| 21 | Staff | **Real accounts**, roles `mod` and `admin` |
| 22 | Anti-bot | **Cloudflare WAF + Turnstile on first paint** and **datacenter/VPN ASN gating** |
| 23 | Admin tools | Regions, revert, ban, freeze + stats, image stamp — all **in-app panel** |
| 24 | User features | Pixel inspector, activity feed, timelapse scrubber, country pages, **template overlay + converter, shareable** |
| 25 | Testing | **Vitest** on pure logic + **k6** load script |
| 26 | Repo | **pnpm workspace**: `shared` / `server` / `web` |
| 27 | Sequencing | **Vertical slice first**, then harden |

### Deviations from the original MVP prompt

- **Accounts** were out of scope. Staff accounts are now in scope. End users
  remain fully anonymous — this is a moderation tool, not a user feature.
- **Content moderation** was a flagged gap. It is now built (revert, ban,
  freeze, protected regions, audit log).
- **Anti-bot** was "basic rate limiting". It is now a first-class subsystem —
  you named bots, DDoS and proxies as the biggest risk.
- **Pixel art tools** (templates/overlays) were out of scope. The template
  overlay is now in v1, deliberately: shipping a good sanctioned overlay is
  the cheapest way to reduce demand for third-party scripts that also automate
  *painting*.
- **Undo / eyedropper** remain out of scope. So do monetization, mobile apps,
  and the Discord bot (v2).

---

## 1. Coordinate system

The single most important thing to get right, because it is the only decision
that can retroactively corrupt stored data.

```
Z_PIXEL   = 12
TILE_SIZE = 256
WORLD     = TILE_SIZE * 2^Z_PIXEL = 1,048,576 pixels per axis
```

Web Mercator, identical to Leaflet's `CRS.EPSG3857` at z12:

```
x = floor( (lon + 180) / 360 * WORLD )
y = floor( (1 - ln(tan(lat_r) + sec(lat_r)) / PI) / 2 * WORLD )
```

Properties that follow, and that the tests assert:

- `(0°, 0°)` → **`(524288, 524288)`** — the exact centre of the grid.
- Equator resolution: `40,075,016.686 m / 1,048,576` = **38.2185 m/pixel**.
- Valid latitude range is clamped to ±85.05112878° (Mercator limit).
- A z12 **tile** maps 1:1 onto a 256×256 block of pixels:
  `tile(tx, ty)` covers `x ∈ [tx·256, tx·256+255]`, same for y.
- `tileId = (x >> 8) * 4096 + (y >> 8)` — a single `BIGINT` usable as a
  clustering key and a WS subscription key.

Coordinates are stored as plain `INT`. Never store lat/lng — it is derived.

### Zoom policy

| Zoom | Behaviour |
|---|---|
| 0–11 | View only. Palette collapses to a "Zoom in to paint" hint. No per-pixel WS stream. |
| 12 | 1 pixel = 1 screen pixel. Painting unlocked. |
| 13–18 | 1 pixel = `2^(z-12)` screen pixels. Grid outline auto-on at z≥14. |
| >18 | Blocked. `maxZoom: 18`. |

---

## 2. Palette and the terrain rule

32 colors, indices `0..31`, stored as `SMALLINT`. Indices `27..31` are the
**water family**; `0..26` are the **land family**. There is no neutral family
— black outlines at sea therefore cost 4. That is a deliberate, tunable
consequence of the 32/5 split; `COLOR_FAMILY` in shared config is the one
place to change it.

```
terrainOf(pixel)  -> 'land' | 'water'      (from the geo index, §4)
familyOf(color)  -> 'land' | 'water'      (from the palette table)

isViolation = familyOf(color) !== terrainOf(pixel)
```

### Cost table

```
cost(pixel, newColor):
  wasPainted  = pixel.color != null
  wasViolating = wasPainted && isViolation(pixel.color, pixel.terrain)
  nowViolating = isViolation(newColor, pixel.terrain)

  if (wasViolating && !nowViolating)  return 2      // RESTORE — always cheap
  return max(wasPainted ? 4 : 2, nowViolating ? 4 : 2)
```

Which yields exactly:

| pixel state | new color | cost |
|---|---|---|
| empty | terrain-correct | **2** |
| empty | violating | **4** |
| painted, correct | terrain-correct | **4** |
| painted, correct | violating | **4** |
| painted, **violating** | terrain-correct | **2** ← restore |
| painted, violating | violating | 4 |

Note the modifiers **do not stack** — the maximum any single paint can cost is
4. This is the resolution of "base 2 / overpaint 4 / violating 4 / restore 2",
which as a flat table left the overlap undefined.

Staff with `mod` or `admin` role bypass cost entirely (unlimited pixels), but
their paints are still written to `pixel_events` with their `staff_id`.

---

## 3. Database schema

PostgreSQL 16. Full DDL lives in
`packages/server/migrations/0001_init.sql`; this is the shape and the why.

### `pixels` — current canvas state, one row per painted pixel

```sql
CREATE TABLE pixels (
  x            INTEGER  NOT NULL,
  y            INTEGER  NOT NULL,
  tile_id      BIGINT   GENERATED ALWAYS AS ((x >> 8) * 4096 + (y >> 8)) STORED,
  color        SMALLINT NOT NULL,
  country_id   SMALLINT NOT NULL REFERENCES countries(id),
  session_id   BIGINT,
  staff_id     INTEGER,
  paint_count  INTEGER  NOT NULL DEFAULT 1,
  painted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (x, y)
);
CREATE INDEX pixels_tile_idx ON pixels (tile_id) INCLUDE (x, y, color);
```

The `tile_id` index is what makes tile rendering a single index range scan
instead of a 2D bbox scan. Every z12 tile render is exactly one query.

Sparse by design: unpainted pixels have no row. At 100M painted pixels this
table is roughly 6 GB including indexes.

### `pixel_events` — append-only history

```sql
CREATE TABLE pixel_events (
  id          BIGSERIAL,
  x           INTEGER  NOT NULL,
  y           INTEGER  NOT NULL,
  color       SMALLINT NOT NULL,
  prev_color  SMALLINT,               -- NULL = pixel was unpainted
  country_id  SMALLINT NOT NULL,
  session_id  BIGINT,
  staff_id    INTEGER,
  ip          INET,
  cost        SMALLINT NOT NULL,
  batch_id    UUID,                   -- admin stamp / revert grouping
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
```

Monthly partitions, created ahead of time by `pnpm db:partitions` (run from
cron). This table only grows — partitioning is what keeps revert queries and
the eventual archival job sane on a canvas that never resets.

A missing partition is not a hard failure: rows land in DEFAULT. That is
worse than it sounds, because DEFAULT then grows without bound and drags
every revert and timelapse query with it, silently. The script therefore
covers one month back as well as several forward, and rescues anything
already stranded — detaching DEFAULT, creating the partition, moving the rows
through the parent and re-attaching, in one transaction so a crash cannot
leave the table with no default partition and start rejecting inserts.

```cron
# first of the month, 03:00
0 3 1 * * cd /srv/canvasplanet && pnpm db:partitions >> /var/log/cp-partitions.log 2>&1
```

`prev_color` is what makes revert possible without replaying from zero.

Indexes: `(created_at)` BRIN, `(session_id, created_at)`, `(x, y, id DESC)`,
`(batch_id)`.

### `sessions` — anonymous identity + charge ledger

```sql
CREATE TABLE sessions (
  id                 BIGSERIAL PRIMARY KEY,
  token_hash         BYTEA NOT NULL UNIQUE,     -- sha256 of cookie value
  charges            SMALLINT NOT NULL DEFAULT 60,
  charges_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                 INET,
  asn                INTEGER,
  ua_hash            BYTEA,
  turnstile_ok       BOOLEAN NOT NULL DEFAULT false,
  last_country_id    SMALLINT,                  -- powers "your country" pin
  banned_until       TIMESTAMPTZ,
  total_paints       INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Charges are server-authoritative and computed, never trusted from the
client.** The client's displayed bank is advisory only. Regeneration is lazy —
there is no timer job:

```
elapsed  = now - charges_updated_at
regen    = floor(elapsed / 30s)
charges' = min(60, charges + regen)
updated' = charges_updated_at + regen * 30s     -- keeps partial progress
```

This runs inside the same transaction as the paint, under
`SELECT ... FOR UPDATE`, so two concurrent paints cannot double-spend.

### `ip_budget` — token bucket, 120 charges/hour per IP

```sql
CREATE TABLE ip_budget (
  ip            INET PRIMARY KEY,
  tokens        REAL NOT NULL DEFAULT 120,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  new_sessions  INTEGER NOT NULL DEFAULT 0
);
```

Same lazy-refill maths as charges: +1 token per 30s, cap 120. Because a single
human regenerates at exactly 120 charges/hour, a legitimate solo user never touches
this ceiling; a cookie-wipe farm hits it within minutes. This is the
containment for the "fresh session = 60 free charges" decision.

### Countries and stats

```sql
CREATE TABLE countries (
  id SMALLINT PRIMARY KEY, iso_a2 CHAR(2), iso_a3 CHAR(3),
  name TEXT NOT NULL, flag TEXT
);
-- id 0 is reserved: 'XX' / International Waters

CREATE TABLE country_stats (
  country_id SMALLINT PRIMARY KEY REFERENCES countries(id),
  cumulative BIGINT NOT NULL DEFAULT 0,   -- monotonic, never decreases
  held       BIGINT NOT NULL DEFAULT 0    -- zero-sum, can decrease
);
```

Both counters are denormalised and updated in the paint transaction — never
aggregated on read. `cumulative += 1` always; `held += 1` for the new country
and `held -= 1` for the previous owner on an overpaint.

### Staff, moderation, protection

```sql
CREATE TYPE staff_role AS ENUM ('mod', 'admin');

CREATE TABLE staff (
  id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,          -- argon2id
  role staff_role NOT NULL,
  disabled_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE staff_sessions (
  id BIGSERIAL PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff(id),
  token_hash BYTEA UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY, staff_id INTEGER REFERENCES staff(id),
  action TEXT NOT NULL, params JSONB NOT NULL,
  affected INTEGER, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE protected_regions (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL,
  x0 INTEGER, y0 INTEGER, x1 INTEGER, y1 INTEGER,
  created_by INTEGER REFERENCES staff(id), created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE bans (
  id BIGSERIAL PRIMARY KEY, ip INET, session_id BIGINT,
  until TIMESTAMPTZ, reason TEXT, staff_id INTEGER REFERENCES staff(id)
);
```

`protected_regions` is cached in server memory and refreshed on write, so the
paint path costs a rectangle test against a handful of boxes, not a query.

### Templates and tile dirt

```sql
CREATE TABLE templates (
  id UUID PRIMARY KEY, x INTEGER, y INTEGER, w INTEGER, h INTEGER,
  data BYTEA NOT NULL,                  -- quantized palette indices, 1 byte/pixel
  created_by BIGINT, created_at TIMESTAMPTZ DEFAULT now(),
  views INTEGER DEFAULT 0
);
CREATE TABLE tile_dirty (
  z SMALLINT, x INTEGER, y INTEGER, marked_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (z, x, y)
);
```

---

## 4. Geo attribution — country and terrain

Two questions per paint: *which country* and *land or water*. Both must answer
in well under a millisecond, on a grid of 1.1 × 10¹² pixels.

**A per-pixel prebaked array is not possible.** One byte per pixel is 1.1 TB;
even one bit is 137 GB. The workable structure is a **per-tile index** with a
vector fallback.

### Build step — `pnpm geo:bake`

Inputs, downloaded and converted by `pnpm geo:fetch`. Both ship as zipped
shapefiles; conversion is pure JS (the `shapefile` package) rather than
shelling out to `ogr2ogr`, so the bake is reproducible on a bare VPS and on
Windows with no GDAL install:

| source | download | as GeoJSON | features |
|---|---|---|---|
| Natural Earth 1:10m admin_0 | 4.7 MB | 25 MB | 258 countries / 4,274 polygons |
| OSM **simplified** water polygons | 22.6 MB | 60 MB | 14,367 polygons |

The water set is EPSG:3857, so `geo:fetch` reprojects it to lon/lat on the
way through — all the geometry in `shared` works in degrees.

The *simplified* water set is deliberate: the full-detail one is 861 MB, and
at 38 m per pixel we classify roughly 9.8 km native tiles, so full detail costs two
orders of magnitude more download and memory to resolve features below a
single pixel. It is still far more accurate than Natural Earth's coastlines,
which was the whole reason for using OSM here.

Output — `data/geo-index.bin`, ~38 MB, for all 16,777,216 z12 tiles:

```
countries : Uint16Array(16_777_216)   // country id, or 0xFFFF = MIXED   (33.5 MB)
terrain   : Uint8Array(4_194_304)     // 2 bits/tile: 0=water 1=land 2=MIXED (4.2 MB)
```

A tile is uniform if all four of its corners *and* its bbox fall wholly inside
one polygon — checked with an rbush R-tree over the source geometry.

### Runtime — `packages/server/src/geo/index.ts`

```
lookup(x, y) -> { countryId, terrain }

  tile = (x >> 8) * 4096 + (y >> 8)

  countryId = countries[tile]
  if (countryId === MIXED) countryId = pointInPolygon(lon, lat, countryTree)

  terrain = terrainBits[tile]
  if (terrain === MIXED) terrain = tileMask(tile)[ (y & 255) * 256 + (x & 255) ]
```

### Measured, not estimated

The bake has been run against Natural Earth 1:10m (258 countries, 4,274
polygons) and OSM simplified water polygons (14,367 polygons):

| | |
|---|---|
| Index size | **37.7 MB** (as budgeted) |
| Bake time | **~4.5 min**, 5.3M quadtree nodes visited |
| Uniform land | 40.34% |
| Uniform water | 51.32% |
| **MIXED terrain** | **8.34%** |
| MIXED country | 1.41% |

**8.34% is above the 1–2% originally assumed**, because simplified OSM
coastline geometry is more fragmented than a naive estimate suggests.
That has one important consequence:

`tileMask` must resolve terrain **per pixel, not per tile**. Rasterising a
whole 256×256 tile on first touch costs 65,536 point-in-polygon queries —
seconds of latency on a request budgeted in milliseconds — and at 63.43% that
is a common path, not a rare one. So each pixel is computed once and memoised
into a per-tile byte array (`0` unknown, `1` land, `2` water), allocated only
for tiles somebody actually paints on. One PIP per new pixel, free thereafter.

Cost: ~38 MB resident, O(1) for ~92% of terrain lookups, one memoised PIP for
the rest. Country lookup remains O(1) for ~99% of paints.

---

## 5. Tile pipeline

### Rendering

- **z12** — `SELECT x, y, color FROM pixels WHERE tile_id = $1`, blit into a
  256×256 RGBA buffer using the palette, encode PNG. Unpainted pixels stay
  fully transparent so the OSM basemap shows through.
- **z0–z11** — build by **mipmap downsample from the four child tiles**,
  averaging RGBA *including alpha*. A parent whose children are mostly empty
  comes out mostly transparent, which reads correctly as "sparse" when zoomed
  out. Children are rendered recursively if missing.

An all-empty tile renders once to a shared 1×1 transparent PNG and is served
from a constant — most of the world, most of the time.

### Never render a parent's children on demand

`renderParentTile` reads its four children from the cache **only**; a missing
child counts as empty.

The obvious alternative — render missing children so a cold request returns a
complete picture — is a trap that was in this codebase and had to be removed.
A parent rendering its children recursively descends the whole pyramid, so a
single cold request for `/tiles/0/0/0.png` is 4¹² = **16.7 million tile
renders**. It never returns. On a public URL it is a one-request denial of
service, and it silently wedged the tile worker: one drain picked up a
low-zoom tile, hung forever, and because the worker skips a tick while a
drain is in flight, it never ran again — with nothing in the logs.

Two defences, both required:

- Parents read children from cache only (`peekTile`, not `readTile`). A cold
  z0 request now returns in ~100 ms instead of never.
- The worker has a watchdog: a drain in flight for more than 60 s is assumed
  wedged, logged loudly, and reset. "Quietly stopped working" is the failure
  mode that costs the most to diagnose.

Correctness is preserved by propagation, not recursion: the worker marks a
tile's parent whenever it renders it, so a paint climbs one zoom level per
tick and reaches the world view in about 24 seconds. Verified end to end —
all 13 levels rendered from a single paint.

### Cache and invalidation

Three layers:

1. **Cloudflare edge** — `Cache-Control: public, max-age=0, s-maxage=86400`.
   This is where the vast majority of tile traffic is absorbed.
2. **Disk** — `/var/tilecache/{z}/{x}/{y}.png`, served by Fastify with an
   ETag.
3. **In-process LRU** of the hottest ~500 encoded buffers.

On paint:

```
paint at (x,y)
  -> mark tile_dirty for z=12 tile and every parent up to z=0   (13 rows, upsert)
  -> return 200 immediately

tile worker, every 2s:
  take up to N dirty tiles (parents last, so children are fresh first)
  re-render -> write disk -> drop from LRU
  batch CF purge (30 URLs per API call)
  delete from tile_dirty
```

Debouncing is the point: a tile taking 100 paints in two seconds re-renders
**once**. Between the paint and the re-render, clients see the pixel
immediately via the WS overlay canvas (§6), so the visible latency is ~0
regardless.

---

## 6. Realtime protocol

One WebSocket at `/ws`. JSON, because at v1 volumes the encoding is not the
bottleneck and debuggability is worth more.

### Client → server

```jsonc
{ "t": "sub", "tiles": ["10/512/511", "10/513/511"] }  // z10 tiles in viewport
{ "t": "ping" }
```

Subscriptions are at **z10** granularity — one z10 tile covers 4×4 z12 tiles
(1024×1024 pixels), so a 1080p viewport at z12 spans about 2×2 of them. Below
z10 the client sends no subscription and receives no per-pixel stream; it
could not resolve individual pixels anyway.

### Server → client

```jsonc
// batched every 100ms, only for subscribed tiles
{ "t": "px", "p": [[524288, 524288, 14], [524289, 524288, 3]] }

// every 1s, to everyone, deltas only
{ "t": "lb", "world": 4182993, "rows": [[81, 412003, 88120], ...] }

// on change, to the owning session only
{ "t": "charges", "bank": 54, "max": 60, "nextAt": 1754500000000 }

// every 1s, to everyone — the activity ticker
{ "t": "pulse", "pps": 41, "recent": [81, 414, 76, 81] }

{ "t": "freeze", "on": true }
{ "t": "region", "op": "add", "region": { ... } }
```

`Hub` keeps `Map<tileKey, Set<Socket>>` plus a global set. Paint publishes to
one tile key; the leaderboard and pulse publish to the global set on a timer.

### Handshake ordering (load-bearing)

The `/ws` route handler **must attach its `message` listener synchronously,
before any `await`.** `@fastify/websocket` completes the handshake before
invoking the handler, so the client's `open` fires immediately and it sends
its subscription at once. Resolving the session first (a database round trip)
leaves a window with no listener attached — and `ws` drops those events rather
than buffering them. The subscription vanishes and that client silently never
receives a pixel again.

The handler therefore attaches the listener first, queues anything that
arrives (bounded at 16 messages), resolves the session, then drains the queue.
This was a real bug, caught by `verify/realtime.mjs`; it reproduced only when
the database lookup was slow enough, which is exactly the kind of race that
reaches production intact.

### Backpressure

If a socket's `bufferedAmount` exceeds 1 MB, drop its pixel frames (never its
leaderboard frames) until it drains, and flag it for a full tile refresh. A
slow client degrades to "tiles only", it does not stall the hub.

---

## 7. HTTP API

### Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/bootstrap` | Creates/returns session cookie. Returns charges, palette, config, protected regions, leaderboard snapshot, landmark position. One round trip to a usable app. |
| `POST` | `/api/paint` | `{ x, y, color, turnstileToken? }` → `{ ok, charges, cost, countryId }` |
| `GET` | `/tiles/:z/:x/:y.png` | The canvas |
| `GET` | `/api/pixel/:x/:y` | Inspector: color, country, painted_at, paint_count |
| `GET` | `/api/leaderboard?mode=cumulative\|held` | Full ~200-row list |
| `GET` | `/api/country/:iso` | Country page: totals, rank, hotspot, subdivisions |
| `GET` | `/api/timelapse` | `x0,y0,x1,y1,from,to,frames` → frame deltas |
| `POST` | `/api/templates` | Publish a template → `{ id }` |
| `GET` | `/api/templates/:id` | Load a shared template |

### Paint rejection codes

| Code | Meaning |
|---|---|
| `400` | Out of grid bounds, bad color index |
| `403` | Session or IP banned |
| `422` | Outside `PAINT_BOUNDS` (the world-scope config gate) |
| `423` | Pixel is inside a protected region, **or** the canvas is frozen |
| `429` | Insufficient charges, or IP budget exhausted — body carries `retryAfterMs` |
| `428` | Turnstile required (first paint, or flagged ASN) |

### Staff / admin

All under `/api/admin/*`, all requiring a staff session cookie, all writing to
`audit_log`. `mod` and `admin` differ only in which routes they may call.

| Route | mod | admin |
|---|:-:|:-:|
| `POST /api/staff/login`, `/logout` | ✓ | ✓ |
| `GET /api/admin/stats` (live dashboard) | ✓ | ✓ |
| `GET /api/admin/inspect/:x/:y` (session + IP behind a pixel) | ✓ | ✓ |
| `POST /api/admin/revert` (`bbox` \| `session` \| `since`, `preview` flag) | ✓ | ✓ |
| `POST /api/admin/ban` (`ip` \| `session`, duration) | ✓ | ✓ |
| `POST /api/admin/regions` / `DELETE /api/admin/regions/:id` | ✗ | ✓ |
| `POST /api/admin/freeze` | ✗ | ✓ |
| `POST /api/admin/stamp` | ✗ | ✓ |
| `POST /api/admin/staff` (create/disable staff) | ✗ | ✓ |
| `GET /api/admin/audit` | ✗ | ✓ |

**Revert** is a single transaction: select the matching `pixel_events` newest
first, and for each `(x,y)` restore `prev_color` from its *oldest* matching
event (or delete the row if `prev_color IS NULL`), fix `country_stats.held`,
and mark tiles dirty. `preview: true` returns the affected count without
writing. Every revert is itself recorded with a `batch_id`, so a revert can be
reverted.

---

## 8. Anti-abuse architecture

Layered, cheapest first. You named bots, DDoS and proxies as the top risk;
this is the whole answer.

### Layer 0 — Cloudflare (free tier)

- Orange-cloud the origin; the VPS IP is never published.
- WAF rate limit: `/api/paint` > 60 req/min per IP → managed challenge.
- WAF: block known-bot user agents and empty-UA requests on `/api/*`.
- `/tiles/*` edge-cached — the heaviest route never reaches the origin under
  a flood.
- `/ws` passthrough (Cloudflare proxies WebSockets on free tier).
- Bot Fight Mode on.

### Layer 1 — Turnstile on first paint

A session's first `POST /api/paint` returns `428` with a sitekey. The client
renders an invisible Turnstile widget, retries with the token, the server
verifies against `siteverify`, sets `sessions.turnstile_ok = true`, and never
challenges that session again. Cost to a real user: usually zero interaction.

### Layer 2 — ASN gating

`security/asn.ts` resolves the client IP to its ASN at session creation and
checks it against a curated datacenter/VPN list. A flagged ASN does not
block — it **forces Turnstile** and halves the IP budget to 60/hr. This kills
cheap cloud fan-out without hard-blocking legitimate VPN users.

Built and measured: **411,961 ranges** from `@ip-location-db` (CC0, fetched by
`pnpm geo:fetch`), loaded into sorted typed arrays at boot and binary
searched in **under 0.1 ms** per lookup. No network call is made on the
request path — session creation happens on every cold visit, and an outbound
lookup there would be both a latency floor and a dependency that can take the
whole site down.

The flagged list is explicit ASN numbers, not keyword matching on the AS
name: "Hosting" appears in plenty of consumer ISP names, and a false positive
means a real user gets a permanent Turnstile and half the pixel budget for no
reason.

Two known gaps, both accepted for v1:

- **IPv6 is not covered.** The dataset is v4 only, so a v6 client is
  unflagged rather than wrongly flagged. An attacker on native IPv6 skips
  this layer — which is why it is layer 2 of four, not the whole defence.
- **Residential proxies still get through.** This is the reason the revert
  tooling exists.

### Layer 2b — do not trust the client-IP header blindly

The IP the rate limiter counts against comes from `CF-Connecting-IP` only
when `TRUST_CF_CONNECTING_IP=true`, i.e. only when a proxy that *overwrites*
that header is known to be in front. Reading it unconditionally means anyone
who can reach the origin directly sends a fresh forged address per request
and the entire IP ceiling — the containment for the full 60-charge starting
bank — silently evaporates. Keeping the origin IP unpublished is not the same
as keeping it unreachable.

### Layer 3 — server-authoritative state

Not optional and not a "feature" — the charge bank, the cost calculation, the
terrain lookup and the protected-region test all execute server-side inside
the paint transaction. A forged or replayed client can never mint charges,
underpay, or paint a protected pixel. The client UI is a display of server
truth.

### Layer 4 — the human backstop

Revert by area/session/time, ban by IP/session, global freeze, and the audit
log. When a determined attacker with residential proxies gets through the
first three layers — and one eventually will — this is what you use at 3am.

**Deferred to v1.1, hook points left in place:** behavioural scoring
(click-interval variance, pointermove-before-click, raster paint order) and
proof-of-work on the paint token. `security/score.ts` collects the signals and
records them from day one so the model has data to be built against; it does
not yet enforce.

---

## 9. Frontend

Vite + React 18 + Leaflet, no framework beyond that.

```
<MapCanvas>            Leaflet map, OSM base TileLayer,
                       /tiles TileLayer, live-delta overlay canvas,
                       grid overlay, cursor pixel highlight
<PalettePanel>         32 swatches, water family visually grouped,
                       collapses to "Zoom in to paint" below z12
<ChargeBar>            bank / 60, next-charge countdown, cost preview
                       under the cursor ("this pixel costs 4")
<LeaderboardPanel>     world total, [All-time | Held] toggle, top 10,
                       your country pinned, expand to full list
<ActivityFeed>         paints/sec + rolling flag ticker
<PixelInspector>       click a pixel: color, country, age, overpaint count
<TemplateOverlay>      drop image -> quantize -> place -> lock -> paint,
                       progress counter, next-pixel highlight, share link
<TimelapsePlayer>      draw bbox -> scrub -> replay
<SettingsPanel>        grid, coord readout, sound, charge-full notification,
                       share-this-view link, dark map, reduced motion
<AdminPanel>           tab appears when a staff session is present
```

### Live-delta overlay

The `/tiles` TileLayer is the source of truth but lags by up to ~2s behind a
paint. A transparent canvas sits above it holding pixels received over WS since
the last tile refresh. When a tile's PNG reloads, its pixels are cleared from
the overlay. Net effect: your own paint and everyone else's appear instantly,
and the tile layer catches up invisibly.

### Optimistic paint

Click → draw locally, decrement the displayed bank, send. On `2xx`, reconcile
the bank from the server's response. On any error, remove the local pixel,
restore the bank, and toast the reason. The server is always right.

### URL state

`#12/524288/524288` drives and reflects map position, so "share this view"
is a string copy and deep links work.

### Template overlay + converter

Entirely client-side quantization: nearest-neighbour in Oklab against the 32
palette entries, optional Floyd–Steinberg dithering, before/after preview.
Placement is drag-to-position with a lock. Progress is computed by diffing the
template against the tiles already on screen. Publishing `POST /api/templates`
stores the quantized index array (1 byte/pixel) — never the source image — and
returns a `/t/:id` link.

> Shareable templates are a moderation surface: anyone can publish a template
> of anything. Mitigation for v1 is that templates are unlisted (no directory,
> no search — link only), size-capped at 512×512, rate-limited per session, and
> deletable from the admin panel. This is a known, accepted residual risk.

---

## 10. Deployment

```
Cloudflare (DNS proxied, WAF, edge cache, Turnstile)
    │
    ▼
VPS ── Caddy (TLS, static SPA, /api + /ws + /tiles reverse proxy)
        ├── app       node 20, fastify + ws + tile worker
        └── postgres  16, volume ./pgdata
       volumes: ./tilecache  ./data (geo-index.bin)
```

Single `docker-compose.yml`. One process for the API, the WS hub and the tile
worker — deliberately, because the in-memory hub and the on-disk tile cache
both assume a single instance. Scaling out means adding Redis for pub/sub and
moving the tile cache to object storage; that is a v2 decision and the code is
structured so `ws/hub.ts` and `tiles/cache.ts` are the only two files that
change.

Backups: nightly `pg_dump` to off-box storage. The tile cache is derived state
and is never backed up — it rebuilds on demand.

Environment (`.env`): `DATABASE_URL`, `SESSION_SECRET`, `CF_API_TOKEN`,
`CF_ZONE_ID`, `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET`, `PUBLIC_URL`.

---

## 11. Milestones

Vertical slice first — one pixel travelling the whole real stack before
anything is widened.

**M0 — Scaffold.** pnpm workspace, TS configs, compose up with Postgres,
migration runner, health check. *Done when `pnpm dev` serves an empty map.*

**M1 — Thin slice.** `coords.ts` + tests, `pixels` table, `POST /api/paint`
with no economy, z12 tile render (no cache), WS broadcast to all, click to
paint. *Done when two browsers see each other's pixel within 1s.*

**M2 — Tiles for real.** Full z0–z12 pyramid, mipmap parents, disk cache,
dirty queue + debounced worker, CF purge, live-delta overlay. *Done when the
whole world renders at z3 and zooming is smooth.*

**M3 — Economy.** Sessions, cookie, charge bank + lazy regen, geo bake step,
country + terrain lookup, cost table, IP token bucket, protected regions,
landmark seed, charge UI. *Done when the cost table's six cases all hold in
the browser and `economy.test.ts` is green.*

**M4 — Leaderboard.** `country_stats`, both counters in the paint
transaction, 1 Hz WS tick, the panel with the pinned row, activity feed,
pixel inspector, country pages. *Done when the number climbs while you watch.*

**M5 — Staff and defence.** Staff accounts + argon2 + roles, admin panel with
all five tools, audit log, revert engine, Turnstile, ASN gating, CF WAF rules.
*Done when you can revert your own vandalism from a phone.*

**M6 — Widen and prove.** Template overlay + converter + share links,
timelapse scrubber, settings panel, responsive layout, k6 load test, restart
persistence check. *Done when §12 is fully ticked.*

---

## 12. Definition of done

- [ ] Map loads, pans, zooms; existing painted pixels render correctly at
      every zoom from 3 to 18
- [ ] Color select + click-to-paint works; charge bank decrements by the
      **correct cost** for all six cases in §2
- [ ] Charges regenerate at 1/30s to a cap of 60 across a server restart
- [ ] New pixels appear for every other connected client within ~1s
- [ ] Leaderboard updates live, both modes, without leaving the map view
- [ ] Painted pixels survive a server restart *and* a full tile-cache wipe
- [ ] Painting is blocked below z12 and inside protected regions
- [ ] The landmark renders at Null Island and cannot be painted over
- [ ] Ocean paints attribute to International Waters and appear on the board
- [ ] Turnstile fires exactly once per session, on the first paint
- [ ] A mod can revert a 50×50 vandalised area from a phone in under a minute
- [ ] Every admin action appears in the audit log with the staff id
- [x] **k6 abuse run: 1 IP, 200 fresh cookies** — every session past the cap
      correctly refused with 429 (2,949 paints against a 3,600/hr ceiling)
- [x] **k6: 50 concurrent clients** — **zero double-spends**, zero unexpected
      failures across 5,293 requests
- [ ] **p99 paint < 200 ms** — ⚠️ **not met under the retuned economy.** See
      below.

### Paint path: what was removed, and what it bought

Profiling first, by sampling `pg_stat_activity` during a load run. The result
killed the obvious hypothesis: **there were no lock waits at all.** The
`country_stats` hot row — the thing that looked most like a bottleneck — was
not one. The samples showed CPU, `Client: ClientRead`, and `IO: WALWrite`,
which points at commit volume and app-side work instead.

Acting on that, five reductions, all countable rather than inferred:

| Change | Before | After |
|---|---|---|
| Session lookup on every request | `UPDATE ... RETURNING` — its own write txn and WAL flush | `SELECT`, with `last_seen_at` refreshed out of band at most every 5 min |
| `tile_dirty` rows per paint | 13 (the whole ancestry) | **1** — the worker derives parents when it renders |
| Paint write statements | 6 sequential | **1 CTE** |
| IP budget | read-modify-write, 2 statements | **1** statement |
| Tile worker | encoded a batch of up to 256 PNGs back to back | yields the event loop between tiles |

The last one matters more than it looks: the API, the WebSocket hub and the
tile worker share one thread, and `PNG.sync.write` is synchronous CPU work. A
batch blocked the loop for its whole duration and every paint arriving
meanwhile simply queued — a healthy median with a p99 in the hundreds of
milliseconds is the signature. Yielding caps the block at one tile. The
proper fix is a worker thread.

**Measured effect:** median ~27 ms and p90 ~55 ms, consistently, versus 17 ms
and 63 ms before — and p95 improved from ~95 ms to ~70–95 ms. **p99 remains
inconclusive.** Across seven identical runs it read 147, 175, 254, 317, 558,
588 and 720 ms. The run-to-run variance on this development box is larger
than the effect being measured, so no p99 claim is made here in either
direction.

### Where the remaining tail is NOT

Instrumentation was added (`metrics.ts`, surfaced on the admin dashboard) to
stop this being guesswork. Sampled during a 50-VU run at ~74 paints/s:

| | |
|---|---|
| Tile DB query | mean **1.8 ms**, max 7.7 ms |
| Tile PNG encode | mean **6.7 ms**, max 28 ms |
| Event-loop lag | mean 11.7 ms, p50 10.8 ms, **p99 24.8 ms** |
| Event-loop lag max | **862 ms** — one rare stall |
| Tile queue depth | 0 (the worker keeps up) |

So the remaining p99 is **not** the database, **not** PNG encoding, and
**not** sustained event-loop blocking. It is a rare multi-hundred-millisecond
stall that the p99 of the loop delay itself does not see.

Two hypotheses were tested and **both rejected**:

- **`country_stats` lock contention** — `pg_stat_activity` sampling under load
  showed zero lock waits.
- **A large V8 heap deferring GC** — the server had been running with
  `--max-old-space-size=6144` (left over from the geo bake). Removing it made
  p99 *worse* on the next run (588 ms vs 175 ms), which is within the noise
  band and therefore no evidence either way.

Chasing this further on a box that also runs Postgres, Vite and the load
generator is not productive: the environment's variance exceeds the signal.
The next step is to measure on the target VPS with `metrics.ts` already in
place, and only then decide whether a tile worker thread is worth building.

### Open: paint latency after the economy retune

The economy moved from one charge per 30 s to **one per second**. The same 50
concurrent clients now produce roughly **4.6× the write load** — sustained
throughput went from ~9 paints/s to **~40 paints/s**, and p99 crossed the
200 ms target that was set for the original economy.

The paint transaction was reduced from ~10 sequential round trips to 4 by
collapsing the canvas write, history row, both leaderboard counters, the
session update and the tile dirty chain into a single CTE, and by doing the
IP-bucket refill/check/deduct in one statement instead of a read-modify-write
pair. Correctness is unchanged — all 50 smoke checks still pass, including
exactly-30-then-429 and the full cost table.

**That did not settle the p99, and the measurements here cannot settle it
either.** Across runs on this development box the max ranged from 221 ms to
2.24 s with everything else identical, because Vite, Postgres, the tile
worker and an in-memory geo index all share it. Median and p90 improved;
the tail is dominated by noise.

Two things to do before treating this as a real number:

1. **Re-measure on the actual VPS**, with the web dev server not running.
2. **Move tile rendering to a worker thread.** Yielding between tiles removed
   the worst of the event-loop blocking, but PNG encoding still competes with
   the request path on the same core. This is the largest remaining lever and
   the only one measurement here can already justify.

   `country_stats` sharding was the original suspect and has been **ruled
   out** — wait-event sampling under load showed no lock waits whatsoever.
   Do not spend effort there without new evidence.

The threshold itself may also deserve revisiting: 200 ms p99 was chosen when a
client could paint twice a minute.

### Verified

Against a real server and real Postgres (`pnpm verify`, 50 checks green):
paint/overpaint/violation/restore costs, exactly-30-then-429, WS delivery in
~100 ms with correct viewport filtering, tile pixel placement and mipmapping,
persistence across restart, country attribution for ten real places, and the
full admin surface (stamp, revert, freeze, staff, audit, protected regions
holding against an admin stamp). 81 unit tests cover the pure logic.

#### What the load test cost to get right

Its first three runs all "failed", and every failure was in the test, not the
server. Recording them because each one is a trap worth not re-entering:

1. **`http_req_failed` counted the 429s.** A refusal is the correct outcome
   here, so the threshold flagged the system working. Split into an
   `unexpected` counter instead.
2. **The latency threshold measured nothing.** It was tagged
   `{expected_response:true}`, a tag the script never set, so it ran against
   an empty series and passed trivially. Successful paints now get their own
   Trend.
3. **Double-spend detection produced false positives, twice.** First by
   inferring `bank == 0` from a 429 — but "no_charges" means *bank < cost*,
   so a session holding 1 charge refused a cost-2 paint then legitimately
   lands a cost-1 one. Then, after fixing that, by comparing each paint to a
   locally-modelled bank: the client clock starts when the response arrives
   while the server's started before it processed the request, so at the
   30-second regeneration boundary the server correctly grants a charge the
   model has not yet credited. The invariant that survives both is
   **aggregate**: across a session, total charges spent can never exceed the
   starting bank plus what could have regenerated, with one charge of slack.

The run that also mattered: with all 50 VUs sharing one IP, the test measured
the rate limiter rather than throughput (2.98% success, 254 ms mean). Giving
each VU its own simulated address moved it to 29% success and 122 ms p99.

---

## 13. Open questions carried into the build

1. **Palette neutrals.** With 27 land / 5 water and no neutral family, black
   and white outlines at sea cost 4. If that proves annoying in practice,
   promote greys to a neutral family — one edit in `palette.ts`.
2. **Landmark size.** 256×128 is sized for the pixel font. Confirm legibility
   at z12 on a phone before seeding, since re-seeding after launch means
   overwriting whatever grew around it.
3. **`PAINT_BOUNDS`.** Ships as `null` (worldwide). If day-one activity looks
   too sparse at 38 m/px, scoping to a region is a one-line config change —
   already gated, never hardcoded.
4. **Timelapse frame budget.** 200 frames over a 512×512 box is the starting
   cap. Tune against real event density once the canvas has a month of
   history.
5. **Residential proxies.** Not solved, by design. If they become the dominant
   attack, the answer is the deferred behavioural scoring in §8, not more
   IP-level rules.
