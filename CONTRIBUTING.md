# Contributing to CanvasPlanet

Thanks for looking. This file is the short version of how work gets in.
**[PLAN.md](PLAN.md) is the spec** — every constant, trade-off and
non-negotiable is argued there. Read the section covering whatever you are
touching before you change it, because most of the surprising decisions in
this codebase are surprising on purpose and the reasoning is written down.

## Ground rules that are not style preferences

CanvasPlanet is a live service with a canvas that **never resets**. A few
constraints follow from that and are not up for a per-PR debate:

- **The server is authoritative.** Charges, costs, cooldowns and IP budgets
  are decided server-side. A client-side check is a UX affordance, never an
  enforcement point.
- **Migrations are forward-only.** Never edit a migration that has shipped;
  add a new one. There is production data behind every one of them.
- **`packages/shared` is imported by both sides.** Coordinate math, the
  palette and the wire protocol live there specifically so the client and
  server can never disagree about which pixel a click maps to. Don't
  reimplement any of it on one side.
- **Don't widen a rate limit to make a test pass.** The limits in
  `.env.example` are the product. Tests get their own env overrides.

## Getting set up

Full instructions are in the [README](README.md#quick-start), including a
project-local Postgres path if you have no Docker. The short version:

```bash
pnpm install
cp .env.example .env      # set SESSION_SECRET at minimum
pnpm db:migrate
pnpm dev                  # server :8080, web :5173
```

The app boots without the geo bake — country attribution degrades to
"International Waters" rather than being wrong. If you are touching anything
geographic, run `pnpm geo:fetch && pnpm geo:bake` first.

## Before you open a pull request

```bash
pnpm typecheck    # all packages
pnpm test         # unit suite
pnpm build        # this is what CI actually gates on
```

CI runs exactly these three from a **clean checkout**, and that is the whole
point of [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — read its
header comment. Passing locally proves nothing if the files only exist in
your working tree. Commit everything your change needs, lockfile included:
CI installs with `--frozen-lockfile` and will fail if `pnpm-lock.yaml`
disagrees with any `package.json`.

`pnpm verify` (~120 smoke checks) needs a running server and a real Postgres,
so CI does not run it. If your change touches the paint transaction, tiles,
realtime, geo, admin tooling or export, run the relevant script yourself and
say so in the PR.

## Commits and pull requests

- One logical change per PR. A 40-file refactor bundled with a bugfix gets
  asked to split.
- Write commit subjects that say what changed for a *user or operator*, in
  the imperative. The existing history is the reference: "Stop the HUD's
  empty space eating drags meant for the map", not "fix bug in HUD".
- Explain **why** in the body when the reason is not obvious from the diff.
  This codebase's comments carry a lot of reasoning; keep that up.
- If you changed behaviour that PLAN.md or ROADMAP.md describes, update them
  in the same PR. A spec that has drifted is worse than no spec.

## What is likely to be accepted

Bug fixes with a reproduction, accessibility and mobile fixes, performance
work on the paint or tile path with a measurement, documentation that
corrects something wrong, and test coverage for existing behaviour.

## What to discuss first

**Open an issue before building** anything that changes game balance (charge
costs, cooldowns, the terrain rule, palette), adds a dependency, changes the
database schema, or adds a new external service. These are cheap
conversations and expensive surprises — the charge economy in particular is
tuned, and a change to it is a game-design decision, not a code change.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

CanvasPlanet is licensed under the **GNU AGPL-3.0**. By contributing you
agree that your contributions are licensed under the same terms. Note what
AGPL §13 means in practice here: if you run a modified copy as a public
network service, you must offer your users its source.
