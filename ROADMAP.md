# Worldcanvas — Roadmap

v1 is defined in [PLAN.md](PLAN.md) and is complete: every endpoint is built,
81 unit tests and 50 smoke checks pass, and both k6 load scenarios are green.

This file is what comes after, in the order agreed.

**Status as of the last pass**: Phase 2 is done except §2.5 (needs a real-
hardware load run, not more code). Phase 3 is fully closed: the reporting
queue (§3.1), backups with a proven restore (§3.2), and the status page plus
alerting (§3.3) are all done. Phase 4 is fully closed too — the embeddable
widget (§4.2), alliances (§4.1) and timelapse export (§4.3) are all built.
**Phase 5: §5.1 (accounts + login) and §5.2 (leaderboard reorder) are both
done.** Next up: §5.3 (creator tools / social — still just directions, not
scoped) or §2.5's real-hardware load run — ask before assuming which.

A 2026-08-09 feature brainstorm scoped nine further additions, below as
**Phase 6–14** — each fully agreed in shape, none started, and not yet
prioritized against §5.3/§2.5 above. Ask before assuming which (if any) of
these comes next.

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

### 2.5 Paint latency: measure on real hardware first

Carried over from v1 (PLAN.md §12). After the economy was retuned to one
charge per second, 50 concurrent clients sustain ~40 paints/s and p99 sits
around the 200 ms target — sometimes under it, sometimes well over.

**Do not start by building something.** `metrics.ts` is already in place and
its numbers appear on the admin dashboard, so a single load run on the VPS
(with the web dev server stopped) costs almost nothing and is worth more than
any amount of reasoning on the dev box, whose numbers vary by an order of
magnitude run to run.

Three candidate causes have been investigated and **all three ruled out**.
Do not repeat this work without new evidence:

- **`country_stats` lock contention** — the original and most plausible-looking
  suspect. `pg_stat_activity` sampling under load showed *zero* lock waits.
- **PNG encoding blocking the event loop** — 6.7 ms mean and 28 ms max per
  tile, with event-loop lag p99 at 24.8 ms. A tile worker thread would buy
  far less than it appears to.
- **A large V8 heap deferring GC** — removing `--max-old-space-size` made the
  next run worse, i.e. no signal either way.

What remains is a *rare* stall: event-loop lag max reached 862 ms while its
own p99 was 24.8 ms. Fine almost always, occasionally awful. That shape is
what to hunt on real hardware.

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
`staff`). Discord OAuth stays a deliberate fast-follow, not built yet — it
pairs naturally with §5.3's social angle, so it's worth doing once real
signup volume shows whether it's worth it, rather than building two unrelated
auth paths up front.

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
a mocked token), the verify redirect setting `wc_user`, a replayed token
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
real browser hits by clicking the emailed link — issued the `wc_user` cookie
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

## Deliberately not planned

- **Pixel decay in dead zones** — considered and rejected. "Nothing ever
  resets" is a founding promise and this bends it.
- **Behavioural bot scoring enforcement** — signals are collected from day one
  (`security/score.ts`) but nothing enforces. Deferred by design until there
  is real data to set a threshold against.
