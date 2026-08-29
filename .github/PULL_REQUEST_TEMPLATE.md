## What this changes

<!-- What changes for a user or an operator? One or two sentences. -->

## Why

<!-- The reasoning, if it isn't obvious from the diff. Link the issue: Fixes #123 -->

## How it was verified

<!-- Tick what you actually ran. CI gates on the first three. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm verify` — needed if this touches the paint transaction, tiles,
      realtime, geo, admin tooling, or export. Say which scripts you ran.
- [ ] Checked by hand in a browser (say which, and on mobile if it's UI)

## Checklist

- [ ] Everything this change needs is **committed**, including
      `pnpm-lock.yaml` if dependencies moved. CI builds from a clean
      checkout and will fail on files that only exist in my working tree.
- [ ] No new migration edits an already-shipped migration. Schema changes
      are a new forward-only file.
- [ ] Shared logic that both sides depend on lives in `packages/shared`,
      not duplicated across client and server.
- [ ] PLAN.md / ROADMAP.md updated if this changes behaviour they describe.
- [ ] No secrets, tokens, or real user data in the diff.

## Game balance

- [ ] This changes charge costs, cooldowns, the terrain rule, or the palette.

<!-- If ticked: link the issue where the balance change was agreed. These are
     game-design decisions and shouldn't first appear in a pull request. -->

## Screenshots

<!-- Before and after for anything visual. Delete this section otherwise. -->
