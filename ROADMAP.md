# CanvasPlanet — Roadmap

v1 is defined in [PLAN.md](PLAN.md) and is complete: every endpoint is built,
81 unit tests and 50 smoke checks pass, and both k6 load scenarios are green.

This file is what comes after, in the order agreed.

**Status as of the last pass**: Phase 2 is done except §2.5 (needs a real-
hardware load run, not more code). Phase 3 is fully closed: the reporting
queue (§3.1), backups with a proven restore (§3.2), and the status page plus
alerting (§3.3) are all done. Phase 4 is fully closed too — the embeddable
widget (§4.2), alliances (§4.1) and timelapse export (§4.3) are all built.
**Phase 5: §5.1 (accounts + login, including the admin Users tab and Discord
OAuth) and §5.2 (leaderboard reorder) are both done.** One manual step is
still outstanding on Discord OAuth: register the redirect URIs in Discord's
Developer Portal (see §5.1) before the "Continue with Discord" button can
complete a real login. **Phase 6 (streaks) and Phase 7 (Corruption event) are
both done too, built 2026-08-09.**
Next up: §5.3 (creator tools / social — still just directions, not scoped),
Phase 8 (Art Contests) or later, or §2.5's real-hardware load run — ask
before assuming which.

A 2026-08-09 feature brainstorm scoped nine further additions, below as
**Phase 6–14** — each fully agreed in shape, and not yet prioritized against
§5.3/§2.5 above beyond Phase 6 and Phase 7 themselves landing. Ask before
assuming which (if any) comes next.

---

## Phase 2 — finish the surfaces that already have backends

### ~~2.1 Admin panel~~ — done

All six tabs (Control, Revert, Regions, Stamp, Staff, Audit) are built and
wired into `AdminPanel.tsx`. Revert supports all three selectors (map-drawn
bbox, time window, session id) with a mandatory preview before apply.

### ~~2.2 Template overlay~~ — done

The quantizer exists and `POST /api/templates` works. Missing: before/after
preview canvases, Floyd–Steinberg dithering **in Oklab** (same space as the
nearest-neighbour search, or the error terms are meaningless), drag-to-position
with lock, next-pixel highlighting, progress counter, and the `/t/:id` share
flow.

Worth doing properly: the better this is, the less reason anyone has to script
painting. It is an anti-bot feature disguised as an artist tool.

### ~~2.3 Timelapse player~~ — done

Draw an area, pick a range, scrub or play it back on canvas. Entirely
client-side: the server returns bucketed frames and the player replays
deltas, so it costs nothing beyond one query. Scrubbing backwards rebuilds
from the base state rather than inverting deltas — at 512×512 with 200 frames
that is a few milliseconds, and inverting would need the previous colour of
every pixel in every frame.

Verified by `verify/timelapse.mjs`: a known paint sequence including an
overpaint replays to exactly the live canvas state, frames are chronological,
and both the area cap and an inverted time range are refused.

**Export stays out** — see 4.3. The scrubber is the version that does not
risk the paint path.

### ~~2.4 Zoom-out heatmap layer~~ — done

A toggleable overlay (Settings → Canvas → Heatmap) showing paint density
rather than colour. `/tiles/heat/:z/:x/:y.png` is a second server-side render
mode — a leaf tile is one `COUNT(*)` on `pixels_tile_idx` encoded as
greyscale+alpha, downsampled through the same mipmap pyramid as the colour
tiles. The colour ramp is applied client-side (`canvas/heatLayer.ts`)
because the pyramid's alpha-weighted box filter is only meaningful as a
scalar mean in greyscale — mixing ramp colours (e.g. blue + red) at a parent
tile would not land on a meaningful "in-between" density.

The tile worker renders both modes on every dirty tile, roughly doubling its
per-tile cost. `HEATMAP_WORKER=false` turns that back off without a deploy —
worth watching given §2.5 below.

### 2.5 Paint latency: measured on real hardware (2026-08-09)

Carried over from v1 (PLAN.md §12). After the economy was retuned to one
charge per second, 50 concurrent clients sustain ~40 paints/s and p99 sits
around the 200 ms target — sometimes under it, sometimes well over.

Run for real against `k6/paint-load.js` on the VPS, web dev server stopped:
**p99 = 320 ms** on the successful-paint distribution (`paint_latency_ok`),
above the 200 ms target, with zero overspend bugs and zero unexpected
failures — the correctness invariants hold, only latency misses.

Three candidate causes were investigated earlier and **all three ruled out**
(do not repeat this work without new evidence):

- **`country_stats` lock contention** — `pg_stat_activity` sampling under
  load showed *zero* lock waits.
- **PNG encoding blocking the event loop** — 6.7 ms mean / 28 ms max per
  tile.
- **A large V8 heap deferring GC** — removing `--max-old-space-size` made the
  next run worse, i.e. no signal either way.

**New evidence from this run, real bug found along the way**: the admin
dashboard's event-loop-lag histogram (`metrics.ts`) claimed in its own
comment to reset on every read, but `resetEventLoopLag()` was never actually
called anywhere — `maxMs` was silently cumulative since process start, not a
per-window figure. Fixed in `routes/admin.ts` (`GET /api/admin/stats` now
resets after reading). With that fixed, a poll taken *immediately after
server start* (before any load) already showed `maxMs` in the 1600–2200 ms
range, while a poll taken for the actual 90 s, 50-VU load window that
followed showed `meanMs: 13.76, p50Ms: 12.08, p99Ms: 32.64, maxMs: 84.08` —
tame, not the source of the 862 ms-class stall previously seen.

**Read: the rare large stall is not a paint-load-path problem** — it
correlates with startup-time work, not sustained painting. The tile worker's
own `lastDrain` log during that same load window showed a 256-tile backlog
drain taking ~10.2 s; a similarly large drain right after boot (geo data
load, initial dirty-tile backlog) is the leading suspect for where the
860–2200 ms stalls actually come from. Next step if picked back up: poll
`/api/admin/stats` immediately across a cold server restart (not mid-load)
and correlate the spike against `tiles.lastDrain` / `geo` load timing
specifically, rather than against paint throughput.

The 320 ms p99 itself is still open — nothing above rules that out, it only
narrows where the *rare max stall* comes from. The steady p50/p99 numbers
above (12 ms / 33 ms) suggest the 320 ms tail is more likely ordinary queueing
under 50-VU contention than a single blocking stall; not yet root-caused.

**2026-08-09 follow-up, both open threads picked back up — one closed, one
root-caused for real:**

*Boot-time stall*: confirmed directly (a standalone script driving the real
`loadSources()`/`geo.load()` code in isolation, not the live server) that
parsing the 26 MB countries + 63 MB water GeoJSON and building `PolygonIndex`
blocks the event loop for ~1.1–1.7 s at boot — same order of magnitude as the
1600–2200 ms `maxMs` seen above, and it happens *before* `app.listen()`, so it
never touches a real request. ~93% of that time is `JSON.parse` itself, not
the R-tree; `PolygonIndex.add()` was still switched from one `tree.insert()`
per polygon to a single deferred `tree.load()` bulk build (real ~15–20%
win, zero call-site changes, 18/18 tests pass) since it was free money, but
the GeoJSON parse is the actual bulk of it and was left alone — one-time,
pre-`listen()`, invisible to players, not worth the complexity of a
worker-thread offload or a second baked cache format for that payoff.

*The 320 ms p99*: root-caused, and it was a load-test artifact, not a server
bug — but a real bug all the same, just in `k6/paint-load.js`. Reproduced on
an isolated instance (scratch Postgres DB, server on a spare port, never
touching the shared dev DB or the live canvas) with `pg_stat_activity`
sampled every 300 ms through the run: 151 samples caught a backend in a
`Lock transactionid` / `Lock tuple` wait, **every single one on the same
statement** — the paint transaction's big write CTE. The `country_stats`
row is the reason: the load test's "spread VUs across the world" coordinate
formula spreads across *tiles* but not *countries*, and international waters
is one country_id covering ~70% of the globe like any other — checked
directly, 37 of the script's 50 fixed VU coordinates landed there. Every one
of those 37 VUs serialized on that single row's lock for the back half of
its transaction (from the `country_stats` upsert through `COMMIT`), which is
exactly the mechanism the original three-candidates pass checked for and
ruled out (*"pg_stat_activity sampling under load showed zero lock
waits"*) — it just didn't hold for this exact script.

Fixed in `k6/paint-load.js`: `setup()` now resolves each VU's coordinate
through the real `/api/pixel/:x/:y` lookup and retries until no country has
more than `MAX_VUS_PER_COUNTRY` (3) VUs on it, so the test measures spread-out
concurrent play instead of an artificial worst-case pileup on one row. Rerun
after the fix, same 50 VUs/60 s: p99 290 ms (still above the 200 ms target,
now measuring something real) and — the clearer signal — **max latency
dropped from 2.86 s to 460 ms**, a 6x drop in the worst outlier from removing
one artificial lock chokepoint. `country_stats` contention is also a latent
*real* risk worth keeping in mind (a popular event or contested border could
genuinely concentrate many concurrent painters on one country) even though
this specific 320 ms number was test-artifact-driven — not addressed here,
scope was measuring correctly, not hardening the transaction.

Next step if picked back up: rerun with the fixed script on the real VPS
hardware to see whether 290 ms/460 ms-class numbers replicate outside this
dev box (which showed high run-to-run variance — 196/447/759 ms across three
back-to-back trials under different conditions — so treat single-trial
numbers here as directional, not final).

### 2.6 Small gaps — all done

Turnstile 428 flow, `favicon.svg`, and revert's erase broadcast were closed
earlier. **Country subdivisions** now return real data: `pnpm geo:fetch`
pulls Natural Earth `admin_1` (optional, like the water polygons), and
`/api/country/:iso` computes a top-8 regional breakdown from a capped, cached
sample of held pixels — see `geo/subdivisions.ts` for why that is a lazy
read-time query rather than a third baked per-tile layer (subdivisions are
a country-page enrichment, not a paint-time attribution, so they were kept
off the hot path deliberately).

---

## Phase 3 — trust, safety and operations

Do this before any real traffic. Today moderation is still purely reactive:
abuse is only found by looking for it.

### ~~3.1 User reporting queue~~ — done

A "report this area" flag button (rail icon, next to Timelapse) lets anyone
draw a bbox and send it to a mod queue — the missing *input* side of
moderation; the tooling to act already existed, this is the way to hear about
it. (Template reporting exists — `template_reports` / the Audit tab's
report count — but that is a different surface: it flags a specific shared
image, not an arbitrary painted area.)

`POST /api/report` (public, session-rate-limited to 20/hour, same 512px bbox
cap as a template/region read) writes an `area_reports` row. The admin
panel's new **Reports** tab (mod-visible) lists open reports oldest-first,
each with:

- a **live thumbnail**, rendered server-side on every view rather than stored
  at submission time — a report reviewed hours later should show the area's
  *current* state, not a stale snapshot, and `no-store` keeps it that way.
- up to 5 **suspects**: whoever painted most inside that bbox in the last 24h,
  from `pixel_events`, each with a one-click 24h ban (reuses the existing
  `/api/admin/ban`, no new ban logic).
- one-click **Revert** (bbox-only, same as the Revert tab with just an area
  drawn) or **Dismiss**, both resolving the report and writing to `audit_log`.

### ~~3.2 Automated backups + a tested restore~~ — done, restore proven

`pnpm backup` (`scripts/backup.sh`) does a nightly `pg_dump | gzip`, prunes to
7 daily / 4 weekly / 12 monthly, and warns loudly on every run if
`BACKUP_REMOTE` (an `rclone` destination) is unset — a dump that never leaves
the box is not a backup of that box. `pnpm backup:restore` rebuilds the
database from a dump with a type-the-db-name confirm.

Both scripts auto-detect their environment: `docker compose` running means
prod/VPS (dump/restore through the `db` container, as before); otherwise
they fall back to local `pg_dump`/`psql` against `DATABASE_URL`, which is
what a Docker-less dev box (see README "No Docker?") needs to run either
script at all.

**"The script looks right" and "the restore works" are different claims —
the second one is now done**, not just scripted: a real backup was taken of
the dev database (46,724 pixels / 62,867 pixel_events), a marker row was
added afterward, `backup:restore` was run against that dump, and the
restored database matched the pre-backup counts exactly with the marker row
gone — proof the restore actually drops/reloads rather than no-op'ing. This
was exercised on the dev box's local Postgres, not the target VPS — the
mechanism is now proven, but re-running it once against the VPS's own
`docker compose` stack before relying on it there is still worth the ten
minutes, since the two code paths (docker vs. local) are different and only
one of them has a live-fire result yet.

### ~~3.3 Status page + alerting~~ — done

`GET /api/status` (no auth — nothing in it identifies a user) reports `ok`,
an `overall` state, per-component states (`canvas`/`realtime`/`database`,
derived from real signals — DB reachability/latency, tile-worker backlog,
WebSocket health — not three independently-monitored services; see
`status/snapshot.ts`), plus DB latency, paints/sec, connected clients, tile
queue depth and uptime. `503` when `overall` is "down". `GET
/api/status/history?days=` serves a daily-aggregated uptime record, sampled
every 5 minutes into `status_history` and retained 90 days (`status/history.ts`).

Reachable two ways: in-app from Settings → System status (a compact 30-day
view), and standalone at `status.<domain>` — a dependency-free static page
(`status/index.html`) served directly by Caddy on its own subdomain with a
full 90/30/7-day component history strip, shared cross-component tooltips,
and a legend, so it works even if the main domain, its DNS, Cloudflare, or
the SPA build is what's actually down. Colours are the dataviz skill's fixed,
pre-validated status palette; layout follows its "Minimalism & Swiss Style"
recommendation for dashboards/professional tools.

**Known limitation, stated on the page itself**: history is sampled from
inside the app process. A full process crash writes no bad sample at all, so
that kind of outage shows as a *gap* in the strip, not as "down" — this is
the "what did our own numbers look like" record, not a substitute for an
external monitor.

**Push is now wired**: `pnpm alert:watch` (`scripts/alert-watch.ts`) polls
`/api/status` on an interval and pushes a notification (any Slack- or
Discord-compatible incoming webhook, via `ALERT_WEBHOOK_URL`) when `overall`
changes state, with a consecutive-failure threshold so one slow poll doesn't
page anyone, immediate escalation on degraded→down, periodic re-notify on a
continuing outage, and a recovery notice. Run it as its own process — that
is what fixes the same-process blind spot above: it only talks to the app
over HTTP, so a fully dead server still gets noticed. Verified against a
mock status endpoint stepping through operational → degraded → down →
operational: threshold gating, escalation, and recovery all fired the right
notification exactly once each. See README "Alerting" for config.

An external uptime monitor pointed at `/api/status` is still worth adding
independently if one is available (it survives the watcher's own box being
down, which `alert:watch` structurally cannot), but is no longer required
for the app to page someone.

---

## Phase 4 — growth

Only worth building once phase 3 exists.

### ~~4.1 Alliances / teams~~ — done

Named groups with a colour and their own leaderboard beside countries. Country
rivalry is the built-in hook; teams let communities that are not a country
organise too.

Membership mirrors country attribution deliberately: one alliance per
session, stored directly on `sessions.alliance_id` (nullable) rather than a
membership join table — the same "last one you painted for" shape as
`last_country_id`, here "last one you explicitly joined." `alliance_stats`
mirrors `country_stats` row for row, updated inside the same paint
transaction via two extra CTEs (`gain_alliance`/`loss_alliance`, guarded on
`alliance_id IS NOT NULL` so the ~majority of sessions with no alliance never
touch it). That in turn needed `alliance_id` added to `pixels` and
`pixel_events` alongside `country_id`, so an overpaint can find the
*previous* owning alliance the same way it already finds the previous
country — without that, held could only ever climb.

`alliances/store.ts` is `leaderboard/store.ts`'s shape exactly (in-memory
map, `applyPaint`/`rows`/`tick`, dirty-flag broadcast on the same 1 Hz hub
tick, now `hub.start()` takes an array of tick sources instead of one). The
one real difference: alliance creation is a runtime, player-driven event, so
`GET /api/alliances` exists for the panel to refresh names/colours (the "alb"
broadcast only carries stats, by id) alongside what bootstrap already saw.

`POST /api/alliances` creates and auto-joins (`ALLIANCE_CREATE_PER_DAY`
per session); join/leave (`POST /api/alliances/:id/join`,
`POST /api/alliances/leave`) share one cooldown (`ALLIANCE_JOIN_COOLDOWN_MS`,
6 minutes) rather than a rolling count — unlike reports or templates, there
is no natural "N per window" table to count against for something you switch
rather than repeat. Colour is a palette index (`Swatch.i`), not a free hex
value, so an alliance renders with one of the canvas's own 32 colours and the
wire format stays as compact as a pixel's.

Moderation reuses the existing pattern exactly: a mod-visible **Alliances**
tab in the admin panel (`GET /api/admin/alliances`,
`POST /api/admin/alliances/:id/disable`), and disabling one evicts every
member's `alliance_id` immediately (same reasoning as disabling a staff
account cutting its sessions) rather than just hiding the name.

Caught during real verification (`verify/alliances.mjs`, plus a Playwright
pass over both the player panel and the admin tab): `alliances.id` is a
`SMALLINT`, and an out-of-range id reaching a query is a Postgres
numeric-overflow error, not "not found" — both `GET /api/alliances/:id` and
the join/disable routes validate the range before querying. Also caught: the
migration runner is forward-only and tracks by filename, so editing
`0006_alliances.sql` after it had already run once on this dev box did
nothing there (a fresh install picks up the final version in one shot); the
fix for an already-migrated environment is `0007_alliance_join_cooldown.sql`,
not a further edit to 0006.

### ~~4.2 Embeddable canvas widget~~ — done

`GET /embed.html?x0=&y0=&x1=&y1=` — a live, read-only view of a region for
communities to put on their own site. `Embed` in the main app's rail (next to
Report) draws a region and hands back a ready-to-paste `<iframe>` snippet,
with a live preview.

Reuses the cached tiles and the existing WS hub, as planned — but "just
reuse the WS stream" ran into a real problem on the way: the session cookie
is `SameSite=Lax`, which browsers never attach inside a *cross-origin*
iframe (exactly what an embed is), so the normal cookie-authenticated `/ws`
was structurally unreachable from there. The fix is `?ro=1`: an anonymous,
read-only WS mode (`ws/hub.ts`'s `Conn.sessionId` is now nullable) that
skips the session requirement entirely. Sound rather than a workaround —
pixel/leaderboard/pulse broadcasts are public data regardless of who's
connected, and a read-only socket can never send anything that mutates
state, so nothing that needed a session in the first place is missing. This
also means the widget makes no `/api/bootstrap` call and sets no cookie at
all — verified with Playwright: an embed inside a genuinely cross-origin
host page carried zero cookies in the whole browser context, still
connected over `/ws?ro=1`, and a pixel painted from a wholly separate
authenticated session reached it live.

`/embed.html` is a second Vite entry (`EmbedApp.tsx`), not a route inside
the main SPA — it ships to every page that embeds it, so it carries none of
the admin/template/timelapse code the main bundle needs. Caddy denies
framing everywhere else (`X-Frame-Options: DENY` / `frame-ancestors 'none'`
on the main app and the status page) and allows it only on `/embed.html`
— a deliberate carve-out rather than a gap, now that one legitimately
embeddable page exists.

Fixed along the way: `WsClient` had no `disconnect()` — an unmounted
component's socket kept calling handlers that closed over already-destroyed
Leaflet objects, caught by the embed's Playwright check (`no console
errors`) crashing on a stale map reference. Both `EmbedApp.tsx` and the main
`App.tsx` now call it on cleanup.

### ~~4.3 Timelapse GIF/MP4 export~~ — done

The most shareable artifact the app can produce, and the one feature that
could have starved the paint path on a single VPS — a 512×512×200-frame
encode is roughly 2–10s of one core. `POST /api/export/timelapse` (same bbox/
from/to/frames shape as the player's `/api/timelapse`, plus `format: "gif" |
"mp4"`) queues a job rather than rendering inline; `GET /api/export/:id`
polls status; `GET /api/export/:id/file` streams the result. An **Export**
button lives inside `TimelapsePanel.tsx` itself (next to Play/scrub) rather
than as a new rail icon — it exports exactly the clip already loaded, not a
freshly re-queried one.

Every non-negotiable from the original plan landed exactly as scoped:

- **Concurrency capped at exactly 1** (`export/queue.ts`) — a `running`
  guard against a DB-backed queue table, the same shape as the tile worker's,
  so a server restart mid-encode loses nothing (the row is just retried).
- Frames are never held in memory: `export/render.ts` is a generator that
  yields one RGBA buffer per frame (`export/build.ts`'s bucketed deltas,
  rasterized the same way `TimelapsePanel.tsx`'s `seek()`/`draw()` does
  client-side), and `queue.ts` pipes each one straight to ffmpeg's stdin as
  it's produced, awaiting backpressure (`stdin.write()` returning false) and
  yielding the event loop between frames the same way the tile worker yields
  between tile encodes.
- Rate limited to one new encode per session per 10 minutes — but a cache
  hit (matching `bbox, from, to, frames, format`) is checked *first* and
  never touches that limit, so a repeat request really is free, not just
  cheap.
- Output expires after `EXPORT_EXPIRY_HOURS` (36h default) and an hourly
  sweep deletes the file and the row together.

The query itself (`explore.ts`'s `/api/timelapse` handler) was extracted
into `timelapse/build.ts` so the player and the export job walk the exact
same `pixel_events` in the exact same order — an export that showed
something the player didn't would be worse than not shipping it.

Verified with a real ffmpeg run, not a mocked one (`verify/export.mjs`): a
real GIF (magic bytes `GIF89a`) and a real MP4 (`ftyp` box) both come back
playable, including one deliberately-odd-dimensioned bbox to exercise the
`pad=ceil(iw/2)*2` filter libx264's `yuv420p` needs for even dimensions.
Also a real Playwright pass through the actual UI button.

That Playwright pass caught a real, pre-existing bug unrelated to export
itself: `pickBbox`/`BboxDraw` (shared by timelapse, revert, regions, stamp,
report and embed — every "draw an area" flow in the app) disables
`map.dragging` for the duration of a drag, so Leaflet never records a real
drag and fires a plain `"click"` on the very mouseup that finished the
selection — silently painting (and spending a charge on) whatever pixel the
drag ended on, every time, in every one of those six tools. The store's
`mapPicking` flag alone can't catch it: resolving `begin()`'s promise and
clearing that flag happens as a microtask still inside the mouseup task,
which completes *before* the browser's separate `"click"` task even starts.
Fixed with a second, synchronous guard — `BboxDraw.justEnded`, set the
instant a drag ends and consumed (read-then-cleared) by the very next click
check in `MapCanvas.tsx` — since a plain field read isn't subject to the
same task-boundary timing as a store update behind a promise chain.

---

## Phase 5 — player accounts

Everything below §5.1 is gated on it having landed: the leaderboard reorder
(§5.2) has nothing to show until accounts exist, and the social/creator ideas
in §5.3 mostly assume a persistent player identity to hang on to. Agreed
2026-08-08 as the next major slice after §4.3/§2.5.

### ~~5.1 Accounts + login~~ — done

Email/password (argon2id — same library and pattern `staff.ts` already uses
for the mod/admin login, just applied to a new player-facing table, not
`staff`).

**Discord OAuth (built 2026-08-09 fast-follow)**: `GET /api/auth/discord`
redirects to Discord's authorize screen (CSRF `state` round-tripped through a
short-lived `cp_discord_state` cookie, `0012_users_discord.sql`'s DISCORD_STATE_COOKIE
constant lives in shared/config.ts); `GET /api/auth/discord/callback` exchanges
the code, fetches the profile from `discord.com/api/users/@me`, and logs in —
same session-attach step as `/api/auth/login`. A Discord-only account has no
password at all, which needed `0012_users_discord.sql` to drop `email` and
`password_hash` down to nullable (`UserDTO.email` is now `string | null`
throughout, including the admin Users tab) and add a unique `discord_id`.
`findOrCreateDiscordUser` (routes/auth.ts) has three cases in order: an
existing `discord_id` match (repeat login); no match but a **verified**
Discord email matching an existing password account — links rather than
bouncing off the email UNIQUE constraint with a 409 that would strand the
same person with no way forward, since Discord already proved ownership (an
*unverified* Discord email deliberately does not auto-link — Discord itself
is the one saying it isn't verified, and it does not get to leapfrog what a
password account's own email verification enforces everywhere else); or
neither, so a brand-new password-less account is created, with the Discord
username sanitized/collision-suffixed into a valid, unique `display_name`
(`uniqueDisplayNameFrom`) since there is no signup form here to reject a bad
one on.

Verified for real, in two layers, given a live Discord user consenting is not
something an unattended script can do: `verify/discord.mjs` exercises every
HTTP-reachable path against the real running server *and* Discord's real
endpoints — the authorize redirect's client_id/redirect_uri/scope, the CSRF
state cookie actually being set and checked, every callback failure mode
(missing state, mismatched state, Discord reporting the user declined), and a
bogus code getting a genuine refusal from Discord's real token endpoint, not
a mocked one. A Playwright pass confirmed the actual "Continue with Discord"
button (Account panel, shown only when `bootstrap.discordEnabled` is true)
navigates a real browser all the way to Discord's real authorize screen with
zero console/page errors. `findOrCreateDiscordUser`'s account-linking logic
itself — new account, repeat login, display-name collision, verified-email
linking, unverified-email *not* linking — was exercised directly against the
real dev Postgres (13 checks, all passing) since the DB layer is reachable
without Discord's consent screen even though the HTTP endpoint isn't.
**What is structurally still unverified**: a real code exchange succeeding
end to end, which needs both a human clicking "Authorize" on Discord's own
site and the redirect URIs actually registered in Discord's Developer Portal
first (`http://localhost:5173/api/auth/discord/callback` dev,
`https://canvasplanet.net/api/auth/discord/callback` prod) — do that, then
click the real button once to close the loop.

Landed beyond the original shape below, decided along the way: **email
verification is required before login works** (`email_verified_at`, a
one-shot hashed token in `email_verifications`, 24h TTL) — an unverified
signup just sits inert. That needed real outbound email, which didn't exist
anywhere in this app yet: `email/mailer.ts` is one `nodemailer` SMTP
transport for every environment (Resend's own relay in production —
`smtp.resend.com`, user `resend`, password = API key — a local `maildev`
catcher in dev, `pnpm mail:dev`), so prod and dev differ only in which host
answers on port 587/1025, never in how the app talks to it. `email` and
`display_name` are both `CITEXT` (case-insensitive `UNIQUE` for free, so
`Player@x.com` and `player@x.com` collide the way a human expects). **Password
reset landed too** (built right after, once the email groundwork existed to
build it on): `POST /api/auth/request-reset` → a real emailed link
(`?resetToken=...`, straight at the app rather than through a server redirect
— unlike verify, nothing needs to happen server-side until a new password is
actually submitted) → `POST /api/auth/reset`, its own `password_resets` table
with a shorter 1h TTL than email verification (a live reset link is a
stronger capability — it hands over the account outright). Resetting
**invalidates every other `user_sessions` row for that account** — a stolen
session cookie doesn't survive a reset — and, since clicking the link already
proves inbox ownership, also verifies the account if it hadn't been yet
rather than leaving someone stuck unable to log in either way.

**Admin Users tab (built 2026-08-08 fast-follow)**: search/view player accounts, mod-visible tier — same shape as the Alliances tab (list + disable/enable, no create form, since accounts are self-service signup). `users.disabled_at` (`0011_users_disabled.sql`) was the missing piece from the original §5.1 schema; disabling deletes every `user_sessions` row for that account immediately, mirroring staff.disable/alliance.disable, and both `getAuthUser` and `/api/auth/login` now check it — proven for real (not just code review) with a live session that kept working right up until the disable call, then 404'd on the very next `/api/auth/me`.

Caught by the mandatory Playwright pass, not by typecheck or a code read: the tab's initial unfiltered load and a subsequent search can resolve **out of order** — a one-row search response can land before the slower full-table one, which then silently clobbers it. Fixed with a request-id guard in `UsersTab.tsx` (`load()` only applies a response if it's still the most recent request in flight) rather than reaching for `AbortController`, since the stale fetch finishing late is harmless — only applying its result isn't. **General lesson for this codebase**: any admin tab that gains a *second* trigger for the same load function (a filter, a refresh button) needs this guard — the existing single-load tabs (Staff, Alliances) never hit it only because they have nothing to race against.

Verified for real, not just typechecked: `verify/accounts.mjs` runs the whole
loop against a running server and a real `maildev` catcher — signup
validation, the actual emailed link (parsed out of a real captured email, not
a mocked token), the verify redirect setting `cp_user`, a replayed token
being refused, wrong-password and pre-verification login refusals, a login
linking the browser's anonymous session and a paint immediately landing in
`user_stats`, logout, and resend-verification answering identically for a
real account and a nonexistent one (skips cleanly, not fails, if `maildev`
isn't running), plus the full reset loop — request → real emailed link →
new password → old password rejected/new one works → every other session
signed out. Two separate Playwright passes drove both loops (signup →
verify-link click → logged-in panel → sign-out, and forgot-password →
reset-link click → new password → re-login) in a real browser with zero
console/page errors.

**Anonymous play is unaffected.** No login wall — the existing cookie-session
economy (charges, rate limiting, bans, the whole anti-abuse surface in
`session/session.ts` and `paint/service.ts`) stays exactly as-is and keeps
working with zero account. An account is a claimable upgrade: a persistent
display name and a place on the player leaderboard, nothing about paint
eligibility changes.

**Hardening pass (2026-08-09)**: `POST /api/auth/signup` used to answer a
duplicate email with a plain 409 — an oracle a prober could use to test
arbitrary addresses for an account, undermining the enumeration resistance
every other account-existence-adjacent route here (login, request-reset,
resend-verification) deliberately maintains. Fixed by branching on the
Postgres unique-violation's `constraint` field: a `users_display_name_key`
hit still 409s (display names are public, nothing to protect), but a
`users_email_key` hit now answers exactly like a fresh signup — no second
row, no second email, no distinguishable response. Also closed: `/signup`,
`/resend-verification` and `/request-reset` had no per-IP rate limit at all
(only `/login` did) — since two of those three send email gated solely by a
60s *per-account* cooldown, an attacker could email-bomb any address
indefinitely, one request per cooldown, forever. All three now share the
same sliding-window limiter `/login` already used (`createRateLimiter`,
factored out of what was `loginRateLimited`), env-overridable the same way
for the verify suite's shared 127.0.0.1. Verified for real: full
`verify/accounts.mjs` rerun against the live dev server (38/38 checks,
including new duplicate-email/duplicate-display-name coverage) plus the
server's vitest suite, both green.

**Signup is a fresh start, deliberately** — a new `users` row and its stats
begin at zero; the session's pre-existing charges/held/cumulative counts are
*not* migrated onto it (already decided, see below). That keeps the paint
transaction's existing country/alliance attribution completely untouched by
this feature — signing up only starts *future* paints counting toward the
new identity, the same way joining an alliance mid-way only starts counting
from the join, not retroactively.

Shape (mirrors the alliances precedent in §4.1 closely, since it's the same
problem: attribute a paint to an optional group, correct on overpaint,
without touching the hot path for the common case of no group):

- `users` table: id, email (unique, nullable once Discord-only accounts
  exist), password_hash (nullable likewise), discord_id (nullable unique),
  display_name, created_at — separate from `sessions`, not a rename of it.
  `sessions` keeps doing what it does today (the rate-limit/ban/charge
  identity); `sessions.user_id` (nullable FK) is the only link between the
  two, set at login/signup on whichever session cookie the browser currently
  holds. This is deliberate: merging the two would mean every anti-abuse
  check now has to account for a nullable user layer, on the single hottest
  path in the app. Keeping them separate means an anonymous paint is
  *exactly* as fast as it is today — the join only happens for the minority
  of requests carrying a logged-in session.
- Login needs to outlive the anonymous session's `SESSION_TTL_DAYS` cookie
  churn, so it's its own long-lived cookie/token pair (`user_sessions`,
  mirroring `staff_sessions`'s shape: token_hash + expires_at), not reuse of
  the session cookie.
- `user_stats` (cumulative, held) — a third instance of the exact
  `country_stats`/`alliance_stats` shape, updated inside the same paint
  transaction via a `gain_user`/`loss_user` CTE pair guarded on
  `sessions.user_id IS NOT NULL`, identical to how alliances guard on
  `alliance_id IS NOT NULL`. `pixels`/`pixel_events` gain a nullable
  `user_id` column so overpaint can find the *previous* owning user the same
  way it already finds the previous country/alliance.
- A logged-in user painting from a second device/browser attaches that
  session to the same `user_id` — paints from either session accumulate onto
  one `user_stats` row, since attribution is keyed by user, not session.

### ~~5.2 Leaderboard reorder: player, then faction, then country~~ — done

Product decision, not just a UI change: **player is now the primary
identity**, faction second, country third — the reverse of the original
country-first panel. `players/store.ts` is a third instance of
`leaderboard/store.ts`'s exact shape (in-memory map, `applyPaint`/`rows`/
`tick`, dirty-flag broadcast), backed by `user_stats` the way §5.1 already
built it. `hub.start()` took the array-of-tick-sources shape specifically for
this — `hub.start([() => leaderboard.tick(), () => alliances.tick(), () =>
players.tick()])` in `index.ts` is the entire hub-side change. One real
difference from country/alliance rows: there is no small, bootstrap-shipped
catalog of "all players" to join against client-side the way `countries`/
`alliances` are, so a player leaderboard row (`UserLbRow`) carries its
`displayName` inline in the wire tuple rather than an id the client resolves
locally. `players.rows()` also only lists accounts with `cumulative > 0` —
an account that only ever signed up has nothing to rank yet.

What used to be two separate panels (`Leaderboard.tsx` for country,
`AlliancesPanel.tsx` for faction) are now three tabs of one `LeaderboardPanel`
— Player, Faction, Country, in that order, with a single shared All-time/
Held toggle rather than each tab keeping its own.

The open question from the original plan — what a logged-out viewer sees on
a player-first panel — is decided: **Player is the default tab for everyone,
logged in or not**, and a logged-out viewer gets a "log in to claim your
spot" banner pinned above the ranked list (routing into the existing Account
panel on click) rather than the tab defaulting to faction/country for them.
Once logged in, the banner is replaced by the normal pinned-own-row behaviour
the country/faction tabs already had, once that account has actually painted
something — a fresh signup starts at zero (§5.1) and has nothing to pin
until its first paint.

**A real, pre-existing bug was found and fixed via the mandatory Playwright
pass**, unrelated to the reorder itself: `GET /api/auth/verify` — the route a
real browser hits by clicking the emailed link — issued the `cp_user` cookie
but, unlike `POST /api/auth/login`, never linked the browser's anonymous
session (`sessions.user_id`) to the account. Verifying is documented as
"doubling as a first login," but only an explicit second call to
`/api/auth/login` actually attributed paints; a player who signed up, clicked
the link once, and started painting — the normal path, and the one this
feature's own Playwright check exercised — never accumulated anything on the
player leaderboard at all. `POST /api/auth/reset` had the identical gap.
Both now call the same `getOrCreateSession` + `UPDATE sessions SET user_id`
step `/api/auth/login` already did. `verify/accounts.mjs` gained a
regression check that paints immediately after the verify-link redirect,
*without* an intervening explicit login, to make sure this specific gap can't
silently reopen — the original §5.1 verification never caught it because it
only ever chained login-then-paint, never verify-then-paint.

Verified for real, not just typechecked: a fresh `PlayerStore` unit-tested
the same way `AllianceStore` is (no DB — pure in-memory arithmetic), and a
full Playwright pass drove the real signup → real-captured-email →
verify-link click → live paint → leaderboard update loop end to end: Player
tab defaults open for a logged-out viewer with the claim banner showing,
Faction/Country tabs render independently with no banner leaking across
tabs, signing up and clicking the real verify link logs in with zero pinned
row yet (nothing painted), painting one pixel makes the account's own row
appear live via the "plb" WS push with the real display name, and a cold
reload still shows it from `bootstrap.playerLeaderboard` alone — zero
console/page errors throughout.

### 5.3 Creator tools and social/virality — directions, not yet scoped

Both flagged as directions of interest for after accounts land, neither
scoped to a specific build yet:

- **Creator tools**: deeper template tooling, collaborative/coordinated
  multi-session drawing, scheduled paint events — candidates only.
- **Social/virality**: revisits the Discord bot idea below now that Discord
  OAuth (§5.1) means the app already has a legitimate reason to talk to
  Discord's API — a milestone webhook and an OAuth login can likely share
  infrastructure. Still just a candidate; not scoped.

Come back and scope one of these properly once §5.1/§5.2 are live and there's
real signal on what players actually want next — deliberately left loose
rather than guessed at now.

---

## Phase 6 — Streaks — done

Cosmetic-only for now, by explicit decision — a milestone charge bonus was
considered and deliberately deferred, not forgotten.

`user_stats` gained `last_paint_date`, `streak_days`, `best_streak`
(`0013_streaks.sql`), updated inside the same paint transaction as the
existing `gain_user` CTE (`paint/service.ts`) — same `user_id IS NOT NULL`
guard shape as every other per-user stat here, so the vast majority of
anonymous paints never touch it. UTC day boundary (`(now() AT TIME ZONE
'utc')::date`), matching how `pixel_events` timestamps already work: same
day as last paint leaves the streak unchanged, exactly one day later
increments it, anything else (including the first-ever paint) resets it to 1.
`best_streak` is `GREATEST`'d alongside in the same CTE so it never needs a
separate write. A flame icon + count now surfaces on the player leaderboard
row (`PlayerLeaderboardTab.tsx`, shown once a streak reaches 2 — day one
isn't a streak yet) and the account panel (`AccountPanel.tsx`, plus "best N"
once that exceeds the current one). Gated on §5.1 accounts — an anonymous
session has no persistent identity to hang a streak on.

The wire tuple grew a field rather than adding a new message type:
`UserLbRow` is now `[userId, displayName, cumulative, held, streakDays]` —
`best_streak` deliberately isn't broadcast, since it only matters on the
player's own account panel (`UserDTO.bestStreak`, read straight from
`user_stats` by `getUserDTO`) and would be dead weight on every leaderboard
row otherwise.

`players/store.ts`'s in-memory mirror (`PlayerStore`) tracks `lastPaintDate`/
`streakDays` per player the same way it already mirrors cumulative/held —
`applyPaint()` recomputes the same same-day/next-day/gap transition in JS
using `Date.now()` (injectable for tests), so the leaderboard broadcast never
needs to re-query Postgres for a value the paint response already implies.
`best_streak` is deliberately *not* mirrored here — never broadcast, so
duplicating its arithmetic in memory would be untested dead code; the account
panel reads it straight from the DB instead.

**A real, non-obvious bug was caught by the mandatory Playwright pass, not by
typecheck or vitest**: `PlayerStore.load()` originally read
`last_paint_date` through node-postgres's default `DATE` parser, which
builds a JS `Date` at *local* midnight of that calendar date rather than UTC
midnight. On this server (local timezone EEST, UTC+3), round-tripping that
through `.toISOString().slice(0, 10)` silently shifted the date back by one
day on every `load()` — meaning every server restart quietly desynced the
in-memory streak mirror from the database it had just loaded from. Every
other date computation in this feature (the SQL CTE, `applyPaint`'s
`Date.now()`) deliberately treats "today" as a plain string for exactly this
class of bug; `load()` now does too, selecting `to_char(us.last_paint_date,
'YYYY-MM-DD')` instead of the raw column so it never constructs a `Date`
object from a `DATE` column at all. Unit tests (which never touch Postgres)
could not have caught this — it only appeared in a real browser reading a
real post-restart leaderboard row, the standing reason this project drives
every UI change through an actual browser rather than stopping at typecheck
and vitest.

Verified for real, not just typechecked: `verify/streaks.mjs` proves every
transition against the *actual* SQL CTE, not the JS mirror — signs up a real
account, paints once (streak 1), repaints the same UTC day (unchanged),
rewinds `user_stats.last_paint_date` a real day via direct SQL and repaints
(increments to 2, `best_streak` follows), then rewinds 3 days and repaints
again (resets to 1, `best_streak` stays 2) — plus a Playwright pass
confirming the flame badge actually renders, with the right count, on both
the account panel and the player's own leaderboard row, with zero console
errors, after a real server restart re-synced the in-memory mirror to the
(deliberately rewound) database state.

## Phase 7 — Recurring event: Corruption (vs. server) — done

Fires on an interval (`EVENT_INTERVAL_MS`, config.ts, ~90 min default —
overridable via `env.eventIntervalMs`/`EVENT_INTERVAL_MS`, the same "fixed,
tunable constant with an env escape hatch" shape as `TILE_WORKER_INTERVAL_MS`,
used to compress the real ~90min/10min cadence into seconds for
`verify/events.mjs`). `events/engine.ts`'s `EventEngine` picks a 48×48 zone
(`EVENT_ZONE_SIZE`) **at random** within the paint-bounds scope gate,
retrying (cheap — no I/O) up to 30 times if the candidate overlaps a
`protected_regions` row, then skipping the cycle entirely and trying again
next tick if every attempt lost — regions are sparse enough relative to the
world that this never actually happens in practice. A bot session (no
session row at all — same "staff bypass" shape as `admin/stamp.ts`: no
charges, no alliance/user attribution) paints `EVENT_BOT_PIXELS_PER_TICK`
(6) zone pixels Black (`EVENT_BOT_COLOR`) every hub tick. Any paint inside
the zone with a different colour counts as defence — a completely ordinary
paint through the real `/api/paint` route (own attribution, own
country/alliance credit, no special pixel type); `routes/paint.ts` calls
`events.applyPaint(x, y, color, session.id)` right alongside the
leaderboard/alliance/player stores' own post-commit calls, an O(1) no-op
whenever no event is running or the pixel falls outside the zone. Corruption
% is tracked from live visual state, not from who undid what: a zone pixel
counts as corrupted iff it currently shows the bot's colour, regardless of
who painted it there last — so the bot can re-corrupt a pixel a defender
already reclaimed, a real tug-of-war rather than a one-shot claim. If
coverage stays under `EVENT_WIN_THRESHOLD` (50%) when the timer ends,
defenders win; otherwise the bot does.

**The whole zone reverts to its pre-event state when the timer ends, win or
lose** — both the bot's paints and every player paint made inside it during
the event get undone, via `admin/revert.ts`'s existing `{bbox, since}`
selector (widened to accept a null `staffId`, since this is a programmatic
system revert with no staff member behind it — the columns it writes into
were already nullable). The payoff is that the event leaves zero permanent
trace on the canvas either way; `corruption_events` (migration
`0014_corruption_events.sql`) is the only permanent record, a summary row
(zone, result, corruption %, defender count) written once on start and once
on resolve, never the reverted pixels themselves.

Reward: a temporary charge-rate bonus (`EVENT_BONUS_MULTIPLIER` = 2x speed,
`EVENT_BONUS_DURATION_MS` = 10 min) for anyone who landed at least one
defending paint in a winning event, granted at resolution — it can only be
granted then, since "in a winning event" isn't knowable mid-event without
telegraphing the outcome. This needed genuinely new infrastructure per the
original plan's own framing: `sessions.event_bonus_until` plus a `regenMs`
parameter threaded through `economy.ts`'s `regenerate`/`spend`/
`msUntilNextCharge`/`canAfford` (defaulting to the fixed `CHARGE_REGEN_MS`
everywhere else), computed per-request by the new `effectiveRegenMs()` at
every site that already called those — `paint/service.ts`, `bootstrap.ts`,
and the WS `charges` push on reconnect in `index.ts`.

Broadcast shape mirrors leaderboard/alliances exactly — `EventEngine.tick()`
is a fourth tick source in the existing array `hub.start()` already takes,
returning non-null (unlike the other three, `dirty`-flag stores) for an
event's *entire* duration, since the countdown moves every second regardless
of whether anything else changed; the two edges — start and resolve — are
broadcast directly rather than waiting for the next tick, so every client
updates the instant either happens. `BootstrapResponse.event` carries the
same DTO for a client that loads or reconnects mid-event. UI: a countdown/
corruption-%/defender-count banner (`MapCanvas.tsx`'s `EventBanner`, amber
until the threshold then red) and a dashed zone outline — a dedicated
`L.rectangle`, not the shared `BboxDraw` picker instance six other tools
already fight over.

**Decisions made along the way, beyond the original shape**:
- **A frozen canvas pauses the whole event** (both starting a new one and the
  bot's own ticks) rather than let a contest run that defenders are
  structurally unable to respond to — not in the original plan, but a
  correctness gap the freeze feature already implied.
- **A server restart mid-event is handled**, not just theoretically safe:
  `EventEngine.recoverOnBoot()` finds any `corruption_events` row with
  `resolved_at IS NULL` and reverts+closes it (`result = 'aborted'`, a third
  value alongside `defended`/`corrupted`) before anything else boots — the
  "zero permanent trace" promise has to hold across a crash too. Proven for
  real, not just written: a verification server was killed with `taskkill`
  mid-event, and the next boot's log showed `reverting unresolved event N
  left over from a restart` before the zone was confirmed empty again.
- **A minimal mod-visible admin tab** (`EventsTab.tsx`, `GET
  /api/admin/events`, `POST /api/admin/events/end`) was added beyond the
  original spec — read-only status plus one force-end escape hatch, the same
  shape as `ControlTab`'s freeze toggle — since an autonomous timer-driven
  event with no operator visibility at all seemed worth the small addition.
- The actual corruption/defence arithmetic (`contains`/`notePaint`/
  `corruptionPct`/`result`/`toDTO`) was split into a pure, DB-free
  `ActiveEventState` class (`events/state.ts`) specifically so it's
  unit-testable the way `economy.ts` is, rather than living inline in the
  I/O-heavy `EventEngine`.

Verified for real, not just typechecked: 11 vitest cases exercise
`ActiveEventState` directly (zone membership at every edge, corruption
toggling both ways including re-corruption, defender credit being literal
per the spec — any non-bot-colour paint counts, even a still-clean pixel —
and the win/lose threshold at exactly `EVENT_WIN_THRESHOLD`). `verify/
events.mjs` then drives the whole system against a real server and a real
Postgres with the interval/duration compressed to seconds: waits for a real
event to start, defends one pixel through the real `/api/paint` route,
confirms the defence is credited before resolution, waits for the real
resolve-and-revert, then confirms the zone has *zero* pixels left in it, the
specific defended pixel is back to unpainted, `bootstrap.event` clears, and
`regenMs` actually drops for that session afterward — the full loop, not a
mocked slice. A Playwright pass against the same fast-timing server confirmed
the live banner and dashed zone outline actually render in a real browser,
the admin Events tab's live status matches the banner exactly, and clicking
"Force end now" resolves the event immediately — zero console/page errors
throughout.

**Team-vs-team mode is an explicit fast-follow**, not this phase: a neutral
zone, two **fresh, randomly-assigned teams per event** (not existing
alliances/countries — keeps it balanced and open to anyone nearby, no
pre-existing group required), majority-pixel-share-at-timer wins. Same engine,
different win condition — build once vs-server is proven.

## Phase 8 — Art Contests

Players nominate a candidate region via the same bbox-draw picker
Report/Embed already use, rate-limited per account (a handful a week, far
below Report's 20/hour — much lower stakes). A new mod-visible **Contest**
admin tab (same shape as Reports/Alliances) lists nominees for a mod to
approve into a round, reusing the Reports tab's live server-side thumbnail
rendering to preview each one.

Voting requires a logged-in account, one vote each: a `contest_votes` table
(`contest_id`, `user_id`, `nominee_id`) with a unique constraint enforces it —
gates this whole phase on §5.1 accounts, already live.

Reward is cosmetic only: a profile badge, and the winning region featured
somewhere browsable. **Real gap, worth flagging now rather than discovering
it mid-build**: "featured somewhere browsable" assumes a notable-art gallery
surface, which was discussed in the original brainstorm but is not itself one
of the agreed phases here — either scope a minimal one as part of this phase,
or this reward has nowhere to live yet.

## Phase 9 — Personal Dashboard

Private view, own account only, behind login: heatmap of where you've
painted, streak history (Phase 6), pixels-still-standing vs. overpainted
ratio, cumulative contribution over time. All derivable from existing
`pixel_events`/`user_stats` — no new tracking beyond what Phase 6 already
adds.

A public summary card at a shareable link keyed off `display_name` (already
unique `CITEXT`): streak, cumulative total, country/alliance/faction, badges —
a lighter cut of the same data, nothing the leaderboard doesn't already expose
in some form. Gated on §5.1 accounts.

## Phase 10 — Event History Log

Because Phase 7's events roll back the canvas completely, this log is the
**only permanent record an event ever happened** — worth building alongside
Phase 7 rather than much later, even as its own phase. A page listing past
events (and later, Phase 8 contests): date, zone, outcome, notable
defenders/participants. Backed by a small `events` table (id, type, bbox,
started_at, ended_at, outcome, top participants) written once per event
resolution — the summary only, not the reverted pixels themselves.

## Phase 11 — Postcards

Lightest-scoped of this batch. A "share this view" action: pick a
coordinate/bbox plus an optional caption, get back a static shareable image +
link (`/p/:id`, mirrors the `/t/:id` template share flow). Reuses the existing
tile renderer for a single-frame crop — no ffmpeg, no job queue, much cheaper
than the timelapse export pipeline (§4.3). Open question before building:
caption moderation — likely reuses the `template_reports` reporting pattern
rather than inventing a new one.

## Phase 12 — Cosmetic Supporter

`users.supporter_tier` (nullable), granted manually via admin toggle to
start — no payment processor wired yet; that's its own decision (Stripe
one-time vs. subscription) if this gets scoped further. Perks: name
colour/badge on the leaderboard and player panel, priority export queue
position, one extra concurrent export slot. Deliberately **not** extra
charges or paint speed — keeps the base economy's fairness untouched.

## Phase 13 — Sponsored Region

An org claims a bbox for a period → a landmark pin + a gallery listing (same
gallery dependency flagged in Phase 8) + a small info panel on click. Goes
through the same mod-review pattern as Alliances/Reports: a new admin tab to
approve/reject/expire. Payment is off-platform (invoice) to start, same
reasoning as Phase 12.

## Phase 14 — Public read-only Stats API

New `api_keys` table: `key_hash` (hashed, never stored plain — same shape as
session/reset tokens), `user_id` (one active key per account; generating a
new one revokes the old), `created_at`, `revoked_at`, request counters.
Self-serve generation/revocation from account settings; auth via
`Authorization: Bearer <key>`.

Read-only endpoints only — paints/sec, country/alliance/faction standings,
region pixel history via the existing `timelapse/build.ts` query — **no paint
endpoint reachable this way, ever**, keeping the anti-bot boundary on the real
paint path completely separate from this. Per-key rate limit (env-tunable,
e.g. 60 req/min), reusing whatever mechanism the existing session
rate-limiter already uses rather than building a second one. A paid
higher-limit tier was floated in the original brainstorm but is not committed
to — free, single-tier, per-account to start.

---

## Deliberately not planned

- **Pixel decay in dead zones** — considered and rejected. "Nothing ever
  resets" is a founding promise and this bends it.
- **Behavioural bot scoring enforcement** — signals are collected from day one
  (`security/score.ts`) but nothing enforces. Deferred by design until there
  is real data to set a threshold against.
