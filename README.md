# Worldcanvas

A persistent, live pixel-art canvas layered on a real world map. Anyone can
paint, one pixel at a time, from a charge bank. Nothing ever resets. A live
leaderboard tracks pixels painted per country.

**[PLAN.md](PLAN.md) is the spec.** Every decision, constant and trade-off is
recorded there. This file is just how to run it.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # set SESSION_SECRET at minimum

docker compose up -d db       # Postgres only; app runs from source in dev
pnpm db:migrate

pnpm geo:fetch && pnpm geo:bake   # ~28 MB download, ~5 min bake
pnpm seed:landmark                # the protected monument at Null Island
pnpm staff:create -- --email you@example.com --role admin

pnpm dev                      # server :8080, web :5173
```

The app boots without the geo bake — country attribution and the terrain rule
degrade to "International Waters / land", which makes the terrain rule a no-op
rather than a wrong answer. Everything else works.

### No Docker? Project-local Postgres

Docker needs WSL2 or Hyper-V to run Linux containers, which not every Windows
box has. Any Postgres 16 install works — point `DATABASE_URL` at it. To run one
entirely inside the project, using binaries you already have:

```bash
PG="/c/Program Files/PostgreSQL/16/bin"
"$PG/initdb" -D .pgdev/data -U worldcanvas --pwfile=<(echo -n devpassword) -E UTF8
"$PG/pg_ctl" -D .pgdev/data -l .pgdev/server.log -o "-p 5544" start
"$PG/createdb" -U worldcanvas -h 127.0.0.1 -p 5544 worldcanvas
```

Then `DATABASE_URL=postgres://worldcanvas:devpassword@127.0.0.1:5544/worldcanvas`.
`.pgdev/` is gitignored; deleting the folder removes it completely. Port 5544
avoids colliding with a system instance on 5432/5433.

## Verifying it works

```bash
pnpm test        # 81 unit tests: coordinate math, economy, gating, geometry, bake
pnpm typecheck   # all three packages
pnpm verify      # ~120 smoke checks against a RUNNING server + real Postgres
pnpm load        # k6: 50 concurrent painters
pnpm load:abuse  # k6: 1 IP, 200 fresh cookies
```

`pnpm verify` covers the parts unit tests structurally cannot — the paint
transaction against real Postgres, the tile pyramid, WebSocket fan-out, real
country attribution, and the admin tooling. Start the server first.

| script | what it proves |
|---|---|
| `tiles.mjs` | a painted pixel lands at the right offset in the right PNG, neighbours stay transparent, parents mipmap |
| `realtime.mjs` | a paint reaches a subscribed client in <1s, and does **not** reach one watching elsewhere |
| `economy.mjs` | exactly 30 paints then 429, with an accurate countdown; no double-spend |
| `geo.mjs` | ten real places attribute to the right country and terrain; the 1/2/1 cost rule fires on real land and sea |
| `admin.mjs` | stamp/revert/freeze/staff/audit, protected regions holding against admins, timelapse, templates |
| `export.mjs` | a real ffmpeg run produces a playable GIF and MP4, the cache hit is free, the rate limit only bites a genuinely new encode |

`admin.mjs` needs an account with the `admin` role:

```bash
BOOTSTRAP_ADMIN_PASSWORD=some-long-password pnpm staff:create -- --email verify@example.com --role admin
VERIFY_ADMIN_EMAIL=verify@example.com VERIFY_ADMIN_PASSWORD=some-long-password pnpm verify
```

Without `VERIFY_ADMIN_PASSWORD` it skips rather than fails.

## Layout

```
packages/shared    coordinate math, palette, charge economy, wire protocol
                   Imported by BOTH sides so they can never disagree about
                   which pixel a click maps to.
packages/server    Fastify + ws + tile renderer + tile worker + admin API
packages/web       Vite + React + Leaflet
k6/                load and abuse tests from the definition of done
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server and web in watch mode |
| `pnpm test` | Vitest across the workspace |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm db:migrate` | Apply pending SQL migrations (forward-only) |
| `pnpm db:partitions` | Create next months' `pixel_events` partitions — **run monthly from cron** |
| `pnpm geo:fetch` | Download boundary + ASN datasets (~50 MB) |
| `pnpm geo:bake` | Build `data/geo-index.bin` (~147 KB, ~10 sec) |
| `pnpm seed:landmark` | Paint and protect the Null Island monument |
| `pnpm staff:create` | Bootstrap-only: grant `mod`/`admin` to an account by email (mints one if it doesn't exist yet) |
| `pnpm backup` | Dump the database, prune old dumps — **run nightly from cron** |
| `pnpm backup:restore <file>` | Restore from a dump, with a confirm prompt |
| `pnpm alert:watch` | Poll `/api/status` and push a notification on state changes — **run continuously, as its own process** |
| `pnpm mail:dev` | Local SMTP catcher + web inbox at `:1080`, for testing the account-verification email without a real provider |
| `pnpm load` | 50 concurrent painters (DoD) |
| `pnpm load:abuse` | 1 IP, 200 fresh cookies (DoD) |

## Key numbers

| | |
|---|---|
| Grid | zoom 12 — 1,048,576 × 1,048,576 pixels, **~38.22 m/pixel** at the equator |
| Grid centre | `(524288, 524288)` = 0°, 0° |
| Charges | +1 per 30s, cap 30, new sessions start full |
| Cost | 1 base · 2 overpaint · 2 terrain-violating · **1 to restore** |
| Palette | 32 colours, indices 27–31 are the water family |
| IP ceiling | 120 paints/hour, shared across every cookie on that IP |
| Request flood guard | 40-request burst, then 1 request per 2s/IP, before DB work |
| Painting | z12 and in only |

## Deployment

```bash
docker compose up -d          # app + Postgres + Caddy
```

Point Cloudflare at the box with the orange cloud on. `/tiles/*` gets
edge-cached (the heaviest route never reaches the origin under a flood), and
Turnstile on first paint plus the origin-side `/api/paint` request limiter are
the anti-bot front line. A Cloudflare WAF rate limit is optional defence in
depth, not required for enforcing the game economy. See PLAN.md §8 and §10.

`status.<your-domain>` needs its own DNS record pointed at the box (a
separate host on purpose — see `Caddyfile`); Caddy issues its certificate
automatically once that resolves, same as the main domain. It serves a
static page from `status/` plus one proxied `/api/status` route, so it stays
up independent of the SPA build, the main domain's DNS, or Cloudflare being
the thing that's down.

## Backups

The canvas never resets. Losing the database loses everything the app has
ever produced, permanently — there is no reason to run this in production
without backups running from day one.

```bash
pnpm backup                              # dump now, prune old dumps
pnpm backup:restore backups/worldcanvas-20260101.sql.gz   # restore, with a confirm prompt
```

Cron, from the repo root on the VPS:

```
0 3 * * * cd /opt/worldcanvas && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Retention is 7 daily + 4 weekly (Sundays) + 12 monthly (the 1st), pruned
automatically on every run. Set `BACKUP_REMOTE` in `.env` to an `rclone`
destination to copy dumps off the box — without it, dumps are local-only and
`pnpm backup` says so on every run. **Run `pnpm backup:restore` against a
throwaway database at least once** before you ever need it for real.

Both scripts auto-detect their environment: with `docker compose` running
they dump/restore through the `db` container (VPS/prod); otherwise they fall
back to a local `pg_dump`/`psql` on `PATH` against `DATABASE_URL` (dev, e.g.
the project-local Postgres from "No Docker?" above) — no code path is
Docker-only. The local path has been exercised for real: back up, corrupt or
add data, restore, and the database matched the pre-backup state exactly.

## Alerting

`pnpm alert:watch` polls `GET /api/status` on an interval and pushes a
notification when `overall` changes state — the piece ROADMAP.md §3.3 called
"still missing" (the status page and its 90-day history are read-only; this
is what pages someone). Run it as its own long-lived process, separate from
the app:

```bash
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... pnpm alert:watch
```

It is deliberately a *separate* OS process rather than another timer inside
the server. `status/history.ts` already samples health every 5 minutes, but
from inside the app process — a full crash of that process writes no bad
sample at all (see its own doc comment). A watcher that only talks to the
app over HTTP still notices when the app itself is the thing that died.

Config (all in `.env`, see `.env.example`):

| var | default | |
|---|---|---|
| `ALERT_STATUS_URL` | `http://localhost:$PORT/api/status` | what to poll |
| `ALERT_WEBHOOK_URL` | unset | POSTed `{ text, content }` on every alert — Slack and Discord incoming webhooks both accept this as-is. Unset just logs to stdout. |
| `ALERT_POLL_INTERVAL_MS` | `30000` | |
| `ALERT_FAIL_THRESHOLD` | `2` | consecutive bad polls before the first alert, so one slow response doesn't page anyone |
| `ALERT_RENOTIFY_MS` | `900000` | how often to re-surface a *continuing* outage; an escalation from degraded → down always alerts immediately regardless of this |

A recovery notification fires once `overall` returns to `operational`, with
how long it was down. No webhook configured still gets you a local log —
useful under pm2/systemd, or with output redirected to a file.

## Timelapse export

`POST /api/export/timelapse` (ROADMAP.md §4.3) turns the same data the
in-browser timelapse scrubber replays (§2.3) into a downloadable GIF or MP4.
Unlike everything else read-only in this app, an encode is not free — a
512×512×200-frame job is 2–10s of one core — so it goes through a queue
rather than rendering inline on the request:

```bash
curl -X POST localhost:8080/api/export/timelapse \
  -H 'Content-Type: application/json' \
  -d '{"x0":524000,"y0":524000,"x1":524255,"y1":524127,"from":0,"to":1735000000000,"frames":100,"format":"gif"}'
# {"id":"...","status":"queued"}   (or "cached" — see below)

curl localhost:8080/api/export/<id>          # poll until status is "done" or "failed"
curl localhost:8080/api/export/<id>/file -o out.gif
```

Non-negotiables, all enforced:

- **Concurrency capped at exactly 1** (`export/queue.ts`), a `running` guard
  like the tile worker's — an encode never competes with the paint path for
  more than one core.
- Frames are piped to ffmpeg's stdin one at a time (`export/render.ts`
  yields, never collects, RGBA buffers) — never more than one frame
  (≤1MB at the 512px cap) held in memory regardless of frame count.
- One new encode per session per 10 minutes. A repeat request with the same
  `(bbox, from, to, frames, format)` is a cache hit — served instantly and
  for free, and does **not** count against that limit.
- Output expires (`EXPORT_EXPIRY_HOURS`, default 36h) and is swept off disk
  hourly.

Requires `ffmpeg` on `PATH` — already in the Docker image (`apk add ffmpeg`
in the runtime stage); install it separately for the no-Docker dev path
above.

Config (all in `.env`, see `.env.example`):

| var | default | |
|---|---|---|
| `EXPORT_OUTPUT_DIR` | `./exports` | where encoded files land |
| `EXPORT_EXPIRY_HOURS` | `36` | how long a finished file is kept before the hourly sweep deletes it |

## Player accounts

`POST /api/auth/signup` → `/api/auth/verify` → `/api/auth/login` (ROADMAP.md
§5.1), plus `/api/auth/request-reset` → `/api/auth/reset` for "forgot
password" (accessible from the login form's "Forgot password?" link). Email/
password now, Discord OAuth as a fast-follow. Anonymous play is
completely unaffected — there is no login wall, and the existing
cookie-session economy keeps working exactly as before with zero account.
Logging in attaches the browser's current anonymous session to the account
(`sessions.user_id`), so paint attribution to `user_stats` starts
immediately.

Signed-in players can upload a JPEG, PNG, or WebP profile picture from the
Account panel. The server strips metadata, crops it square, and stores a
256px WebP alongside the account data in Postgres; removing it restores the
display-name initial. Pictures appear in the account rail and player
leaderboard, and moderators can remove them from the Users tab.

Email verification is required before login works — a signup with no working
inbox behind it just sits unverified. That means outbound email has to work
even on a Docker-less dev box:

```bash
pnpm mail:dev   # maildev — a local SMTP catcher + web inbox at :1080
pnpm dev        # in another terminal
```

With no `SMTP_HOST` set, the server points at `localhost:1025` (maildev's
default) with no auth, so `pnpm mail:dev` + `pnpm dev` is enough to sign up
and click a real verification link end to end — open `http://localhost:1080`
to read the mail maildev caught. In production, point the same SMTP client at
Resend's own relay (`smtp.resend.com`, user `resend`, password = your Resend
API key) — see `.env.example`.

## Attribution

Basemap © OpenStreetMap contributors. Water polygons © OpenStreetMap (ODbL —
attribution is required and is carried in the map's attribution control).
Country boundaries from Natural Earth (public domain).
