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

## Voice

Every server of the fork advertises `voice`. Voice runs through Codex realtime with the `codex`
provider instance's ChatGPT login. It uses only WebRTC, because the WebSocket/PCM transport would
need an API key. Clients get two entry points (web, desktop, Android):

- **Listen to a reply.** Each assistant reply has a listen button in its action row. Pressing it
  speaks a short pt-BR summary of that reply. The client sends only the thread and message ids; the
  server loads the text and refuses anything but an assistant message of that thread.
- **Talk to a bot.** A bot thread's composer has a voice button next to dictation. While a
  conversation is on, an orb shows whether the voice is listening, waiting on the bot, or speaking.
  On mobile the orb takes the chat's place. Mute and close replace the two buttons, and typing still
  works.

In a conversation the realtime voice is only a receptionist. The server posts each finished
utterance to the thread as a normal user message starting with 🎙️, queued behind a running turn,
and reads aloud every reply that completes while the call is open. Approvals and questions are
never answered by voice: the voice only says that one is waiting on screen. The call holds no
conversation state, so hanging up loses nothing.

The realtime model answers simple questions by itself even when told not to. Its prompt therefore
tells it to delegate everything, and after a delegation it only acknowledges. The client plays the
voice's audio only for that acknowledgement and for the replies the server sends; turns the voice
starts by itself stay silent (`voiceAudible` in
[`packages/client-runtime/src/voice.ts`](packages/client-runtime/src/voice.ts)). The delegations
reach no agent, because the realtime thread's Codex cannot run turns.

Each session runs its own `codex app-server` and realtime session, closed when the session ends, so
nothing stays open while idle. `T3CODE_VOICE_READER_VOICE` picks the voice (default `cove`,
Codex's own); a voice the installed Codex does not offer for v3 falls back to Codex's default with a
warning in the log. The locale voices (`porto`, `rio`, …) need Codex 0.163.0 or newer. The protocol
is experimental in Codex. See [`apps/server/src/bots/voice/`](apps/server/src/bots/voice/)
and `VoiceSessionRpc` in [`packages/contracts/src/bots.ts`](packages/contracts/src/bots.ts). On
Android, `plugins/withFriendVoiceReaderWebrtc.cjs` plays the voice as media rather than as a call.

## State and rollback

Bot data lives in `bots.sqlite` next to the upstream database in the T3 userdata directory. The fork
adds no columns or events to upstream tables. A bot's conversation is an ordinary thread whose id
starts with `bot:`, so the official T3 Code app can open the same userdata directory; it shows bot
threads as normal threads and ignores `bots.sqlite`.
