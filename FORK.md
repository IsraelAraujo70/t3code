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

## Dictation

A server started with `OPENROUTER_API_KEY` advertises the `dictation` capability, whether or not it
hosts bots. Web and desktop then show a microphone button in the composer; mobile uses it where the
device has no on-device transcription (Android, iOS before 26). The recording goes up as a pending
attachment, and the server transcribes it with `T3CODE_DICTATION_MODEL` (default
`google/gemini-3.8-flash`), cleans it up with `T3CODE_DICTATION_POLISH_MODEL` (default
`anthropic/claude-haiku-5.5`, `off` skips this step), and deletes it. See
[`apps/server/src/bots/dictation/Dictation.ts`](apps/server/src/bots/dictation/Dictation.ts).

## Voice reader

Every server of the fork advertises `voiceReader`. A thread's header then offers "Ler respostas" (web,
desktop, Android). While it is on, the server speaks a short pt-BR summary of each completed run's
final reply through Codex realtime, using the `codex` provider instance's ChatGPT login. API keys
are not involved: the WebSocket/PCM transport would need one, so the reader uses only WebRTC. The
client owns the peer and sends a muted microphone track, which realtime needs before it talks. The
server only signals and feeds the text. It runs a dedicated `codex app-server` per subscription and
one realtime session per reply, closed when the speech ends, so nothing stays open while idle. The
protocol is experimental in Codex. See
[`apps/server/src/bots/voiceReader/`](apps/server/src/bots/voiceReader/) and
`VoiceReaderSubscribeRpc` in [`packages/contracts/src/bots.ts`](packages/contracts/src/bots.ts).
On Android, `plugins/withFriendVoiceReaderWebrtc.cjs` plays the voice as media rather than as a call.

## State and rollback

Bot data lives in `bots.sqlite` next to the upstream database in the T3 userdata directory. The fork
adds no columns or events to upstream tables. A bot's conversation is an ordinary thread whose id
starts with `bot:`, so the official T3 Code app can open the same userdata directory; it shows bot
threads as normal threads and ignores `bots.sqlite`.
