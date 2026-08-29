# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** CanvasPlanet runs as a live service with a
canvas that never resets, so a disclosed-but-unpatched flaw can be used to
cause permanent damage before a fix ships.

Two ways to report, both fine:

1. **GitHub private advisory** — the "Report a vulnerability" button under
   this repository's **Security** tab. Preferred, since it keeps the
   discussion and the eventual patch in one place.
2. **Email** — <support@canvasplanet.net>, the same address published on the
   [about page](https://canvasplanet.net/about.html).

Please include what you need to make it reproducible: affected endpoint or
page, the steps, what you expected, what happened, and any proof-of-concept.
If you found it against the live site rather than a local checkout, say so
and give a rough timestamp — it helps to correlate against logs.

## What to expect

| | |
|---|---|
| First response | within 72 hours |
| Triage and severity assessment | within 7 days |
| Fix for a confirmed critical issue | as fast as it can be shipped safely |

You will get a real reply from a human, and credit in the advisory and
release notes if you want it. If you would rather stay anonymous, say so.

## Testing against the live site

Please **test against your own local checkout** wherever possible — the
README's quick start gets you a full stack in a few minutes.

If you must probe canvasplanet.net, then in scope and appreciated:

- Reading, probing and analysing public endpoints at a **reasonable rate**.
- Anything you can demonstrate against your own account or session.

Out of scope, and not authorised:

- **Denial of service, load testing, or flooding.** The repo ships k6 load
  tests (`pnpm load`, `pnpm load:abuse`) — run those locally instead.
- **Automated painting.** Bots are prohibited by the Terms; a bot that
  defaces the shared canvas is vandalism, not research.
- Social engineering, phishing, or physical attacks against anyone involved.
- Accessing, modifying, or exfiltrating other users' data beyond the minimum
  needed to prove an issue exists. If you can read one other user's record,
  stop there and report it — do not enumerate the table.

Act in good faith and stay within the above, and we will not pursue or
support any action against you for your research.

## Areas worth your attention

If you are looking for where the interesting bugs would be, PLAN.md §8 and
§10 describe the threat model as designed. The load-bearing defences are:

- **Server-authoritative economy** — charges, the 2/4/2 placement costs and
  the per-IP ceiling are enforced server-side. A client that can spend
  charges it did not earn, or paint below cost, is a critical bug.
- **Session and account integrity** — session forgery, attaching an
  anonymous session to an account that is not yours, or any auth bypass on
  the signup / verify / reset flows.
- **Staff and moderation boundaries** — a non-staff account reaching an
  admin route, or an admin action defeating a protected region.
- **`TRUST_CF_CONNECTING_IP`** — when true on an origin reachable directly,
  client IPs are forgeable and the IP budget is bypassable. That is a
  documented deployment footgun (see `.env.example` and the `Caddyfile`'s
  `cloudflare_only` block). A way to forge the client IP *through* the
  intended Cloudflare path is a real finding.
- **Tile and export paths** — path traversal in the tile pyramid or export
  file serving, and anything that lets one request pin more than one core in
  the export queue.

## Supported versions

CanvasPlanet is a continuously deployed service. Only the current `main` and
the running deployment are supported; there are no maintained release
branches or backports.
