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
  speaks that reply whole in pt-BR, describing code and tables instead of reading them. The client
  sends only the thread and message ids; the server loads the text and refuses anything but an
  assistant message of that thread.
- **Talk to a bot.** A bot thread's composer has a voice button next to dictation. While a
  conversation is on, an orb shows whether the voice is listening, waiting on the bot, or speaking.
  On mobile the orb takes the chat's place. Mute and close replace the two buttons, and typing still
  works.

In a conversation the realtime voice is only a receptionist. Realtime ends the user's turn at every
short pause and its turn detection cannot be configured, so the server collects what the user says
until they have been silent for `T3CODE_VOICE_TURN_SILENCE_MS` (default 10000) and then posts it to
the thread as one normal user message starting with 🎙️, queued behind a running turn. Hanging up
posts what is still waiting. The server reads aloud every reply that completes while the call is
open. Approvals and questions are never answered by voice: the voice only says that one is waiting
on screen.

Replies are spoken whole. Codex cuts the middle out of any appended speech over about 4,000 bytes,
so the server speaks a reply longer than `SPEECH_PART_BYTES` in parts, one realtime turn each, the
next appended when the voice falls quiet; a read ends after its last part. The prompts are judged
with [`voiceProbe.ts`](apps/server/src/bots/voice/voiceProbe.ts), which speaks a reply through the
real voice and reports how much of it was said. The model varies between runs, so compare several.
The realtime model cannot be chosen: with a ChatGPT login the backend ignores `thread/realtime/start`'s
`model` and accepts any name.

The realtime model answers simple questions by itself even when told not to. Its prompt therefore
tells it to delegate everything, and after a delegation it only acknowledges. The client plays the
voice's audio only for that acknowledgement and for the replies the server sends; turns the voice
starts by itself stay silent (`voiceAudible` in
[`packages/client-runtime/src/voice.ts`](packages/client-runtime/src/voice.ts)). The delegations
reach no agent, because the realtime thread's Codex cannot run turns.

Each session runs its own `codex app-server` and realtime session, closed when the session ends, so
nothing stays open while idle. Settings → Bots → Voice picks the voice on the bots host
(`voiceReaderVoice` in the server settings, one of the nine v3 voices Codex 0.162 offers). The
next read uses a new choice. Realtime fixes its voice at the start, so an open conversation swaps
its realtime session instead: once the voice is quiet the client opens a new peer and the server
starts realtime in the new voice for it, keeping what the user said and the replies still to speak
(`bots.voice.reconnect`). Clients built before this keep their voice until they hang up. Left on "Server default",
`T3CODE_VOICE_READER_VOICE` picks it (default `cove`, Codex's own); a voice the installed Codex does
not offer for v3 falls back to Codex's default with a warning in the log. The picker's previews load
from the bots host's tailnet (`/vozes/`). The locale voices (`porto`, `rio`, …) need Codex 0.163.0 or newer. The protocol
is experimental in Codex. See [`apps/server/src/bots/voice/`](apps/server/src/bots/voice/)
and `VoiceSessionRpc` in [`packages/contracts/src/bots.ts`](packages/contracts/src/bots.ts). On
Android, `plugins/withFriendVoiceReaderWebrtc.cjs` plays the voice as media rather than as a call.

## Where bots are listed

The desktop sidebar (its Bots tab or Bots block) and the Android Bots tab list bots the same way:
the user's sections in their order, foldable, bots inside by status (needs you, working, settled)
and then the user's order, with the same line under each name. Both read these rules from
[`packages/client-runtime/src/botDirectory.ts`](packages/client-runtime/src/botDirectory.ts). The
phone only reads: sections and bot moves are edited on desktop. Android's Chats tab shows only
threads; iOS has no Bots tab yet and keeps the bots above its thread list.

## Bot conversations as chat

Web, desktop and mobile show a bot thread (any `bot:<id>:<n>` id) as chat bubbles: the user's
messages on one side, the bot's replies on the other, adjacent messages of one side grouped. Tool
calls, the work log and progress rows stay out of the timeline. While the bot works, web shows a
"<bot> is working…" bubble above the composer and mobile its usual floating working pill. A settled
turn keeps a small "Worked for …" toggle that shows that turn's work. Failures, interrupts and
secret requests stay visible, since they need the user. The rules both clients share live in
[`packages/client-runtime/src/botChat.ts`](packages/client-runtime/src/botChat.ts).

Because the user no longer sees tool output, every bot's instructions end with "How to reply":
short, chat-style answers that still carry the result, numbers, paths, failures, open items and
the decision the bot needs (`replyStyleText` in
[`apps/server/src/bots/BotsInstructions.ts`](apps/server/src/bots/BotsInstructions.ts)). A bot's
own role wins when it asks for another format.

## Restarting a bot's session

"Restart session" (the bot's menu in the sidebar, or Settings → Bots) stops the bot's idle provider
process so the next message starts a fresh one that loads new MCP servers, skills and config, and
resumes the same provider conversation. It releases the session the way the idle timeout does, so
nothing is held or cancelled, and refuses while the bot has an unsettled run or the process still
works. Codex shares one app-server across threads, so a Codex bot restarts it only while no thread
uses it. See [`apps/server/src/bots/restart/`](apps/server/src/bots/restart/).

## Guests

A guest (Bia) talks to a few bots of their own through `apps/bia`, a separate Android app, and a
separate listener on the bots host: `T3CODE_GUEST_LISTEN=host:port`. That listener has its own
router holding only the routes in [`packages/contracts/src/guest.ts`](packages/contracts/src/guest.ts).
Do not serve it with `HttpRouter.serve`: that reuses the main listener's memoized router and
exposes every T3 route on the guest port. A guest authenticates with a bearer token (only its
sha256 is stored), and every bot id is checked against the guest's ownership. A send always uses
the bot's stored model selection. Guests, their bots and their phones live in `bots.sqlite`.
`apps/server/src/bots/guest/cli.ts` creates guests and their bots, and mints, revokes and prints
the pairing QR.

A guest's bots run Claude Code in Docker. Their provider instance uses
[`sandbox/t3-guest-claude`](apps/server/src/bots/guest/sandbox/t3-guest-claude) as its binary and
names the guest with `T3CODE_GUEST_ID`. The guest API refuses to send to a bot whose instance is
not exactly that, and such an instance never gets a T3 MCP credential, because the token would
grant the host's orchestration tools. Each provider session is one `docker run --rm` on an
`--internal` network. The only way out is the guest's proxy container. Its CONNECT proxy refuses
every non-public address, and its Anthropic forwarder holds the credential: a Claude subscription OAuth token
(`claude-oauth.token`, from `claude setup-token`) when present, otherwise an API key. The bot only
has a placeholder of the same kind, so its Claude Code signs in as a subscriber or as an API
client, and the forwarder allows only the guest's models (`T3CODE_GUEST_ANTHROPIC_MODELS`)
and caps effort (`T3CODE_GUEST_ANTHROPIC_MAX_EFFORT`). Whatever the bot does inside its
sandbox, it cannot use the credential elsewhere or pick another model. Guest text that would act on
Claude Code (a leading `/`, "ultrathink") reaches the bot defused. Conversations live in the
guest's volume, so stopping the container loses nothing. `T3CODE_GUEST_IDLE_MS` (default 10 minutes) stops an idle guest bot's container through
the same release as Restart session. A guest's bot can also be one the owner uses: the owner writes from T3, the guest from the
app, and both see the whole conversation. Every turn on such a bot's thread runs on the bot's own
model, whoever sends it (`GuestModelPin`, applied by the Orchestrator to every command), so an owner
message never moves the conversation out of the sandbox. The guest's messages reach the bot as
`<guest name>: <text>`, and the guest API marks each user message `guest` or `owner`
(`T3CODE_OWNER_NAME` names the owner in the app). A reply pushes to every party: the owner's usual
T3 push, and the guest's visible FCM notification (the bot name and a reply preview). With
`lurian-bot.token` in the guest's secrets, the proxy forwards `LURIAN_BOT_API_URL`
(`http://egress:8081/api/bot/v1`) to Lurian's Bot API with the token; no other path gets it.
The guest's own Google account works the same way: `cli.ts google-login <guest> --client-file …`
runs the OAuth flow on the host (the guest signs in in a browser there) and writes
`google/credentials.json` in the guest's secrets folder. The proxy refreshes access tokens from it
and forwards `GOOGLE_API_URL` (`http://egress:8082`) to the Gmail, Sheets, Calendar and Drive
APIs only; the image's `/opt/t3-guest/google-apis.md` tells the bot how to call them. Claude replies reach the app per completed text block, as on every T3 surface,
not per token.

A guest's bot can hand work to helper agents (Claude Code subagents), never to T3's `delegate_task`.
A subagent runs inside the bot's own Claude process, so it has the same container, network,
forwarders and credentials and nothing more. The image defines the helpers and their limits as
Claude Code managed settings in [`sandbox/claude/`](apps/server/src/bots/guest/sandbox/claude/),
which outrank anything the bot writes in its home: `web-research` (Haiku), `drafting` (Sonnet, low
effort), `numbers` (Sonnet, medium) and `organize` (Haiku), each with a turn cap, plus the
read-only built-in Explore. Up to 3 run at once and none can start another. The other built-in agents
and Workflow are off, and helpers never run in the background, so each one finishes within its
turn. [`subagent-budget.mjs`](apps/server/src/bots/guest/sandbox/subagent-budget.mjs) allows 4 per
user message. The forwarder's model and effort limits apply to helpers as to the bot. Changes take
effect when the image is rebuilt.

## State and rollback

Bot data lives in `bots.sqlite` next to the upstream database in the T3 userdata directory. The fork
adds no columns or events to upstream tables. A bot's conversation is an ordinary thread whose id
starts with `bot:`, so the official T3 Code app can open the same userdata directory; it shows bot
threads as normal threads and ignores `bots.sqlite`.
