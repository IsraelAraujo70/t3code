# friend fork

This fork of [T3 Code](https://github.com/pingdotgg/t3code) adds bots: named, long-lived agents with a
standing role, a default model, their own memory, and one ongoing conversation each. It replaces the
separate friend app. `friend/main` is the fork's main branch.

## Following upstream

The fork tracks stable upstream releases (`vX.Y.Z` tags), not upstream `main`.

1. `node scripts/friend/merge-upstream.ts` merges the newest stable tag into a fresh integration
   worktree (`friend/merge-<tag>`). It never pushes or moves `friend/main`.
2. In that worktree, run `vp i`, `node scripts/friend/check-seams.ts`, and the fork tests:
   `vp test run apps/server/src/bots apps/web/src/bots packages/contracts/src/bots.test.ts`.
3. Fast-forward `friend/main` to the integration branch after review.

Urgent upstream fixes between releases are cherry-picked onto `friend/main`.

## Where the fork touches upstream code

Fork code lives in its own paths (`apps/server/src/bots/`, `apps/web/src/bots/`,
`packages/contracts/src/bots.ts`, `scripts/friend/`). Every edit to an upstream file carries a
`Fork (friend)` comment and is listed in [`scripts/friend/seams.ts`](scripts/friend/seams.ts) with its
expected marker count. `check-seams` fails when a merge drops or duplicates a fork hunk, or when an
upstream file gains a fork edit that the list does not record. Keep each upstream edit small, and add
behavior in fork-owned files instead.

## One bots host

Bots run on one machine only: the server started with `T3CODE_BOTS_HOST=1`. Every other server of
this fork keeps bots off. It never opens `bots.sqlite`, injects no bot instructions, refuses the
bots RPCs and memory tools, and does not advertise the `bots` environment capability. Clients read
bots from the environment that advertises it, so a laptop connected to the host shows the host's
bots. See [`apps/server/src/bots/BotsHost.ts`](apps/server/src/bots/BotsHost.ts).

## State and rollback

Bot data lives in `bots.sqlite` next to the upstream database in the T3 userdata directory. The fork
adds no columns or events to upstream tables. A bot's conversation is an ordinary thread whose id
starts with `bot:`, so the official T3 Code app can open the same userdata directory; it shows bot
threads as normal threads and ignores `bots.sqlite`.
