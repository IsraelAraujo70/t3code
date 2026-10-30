# friend fork

This fork of [T3 Code](https://github.com/pingdotgg/t3code) adds bots: named, long-lived agents with a
standing role, a default model, their own memory, and one ongoing conversation each. It replaces the
separate friend app. `friend/main` is the fork's main branch.

## Following upstream

The fork tracks stable upstream releases (`vX.Y.Z` tags), not upstream `main`.

1. `node scripts/friend/merge-upstream.ts` merges the newest stable tag into a fresh integration
   worktree (`friend/merge-<tag>`). It never pushes or moves `friend/main`.
2. In that worktree, run `vp i`, `node scripts/friend/check-seams.ts`,
   `node scripts/friend/vscode-theme.ts --check` (rerun it without `--check` when the default theme's
   colors changed), and the fork tests:
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

## Where the fork's settings live

What a user chooses lives in Settings; what holds a secret or describes the machine stays in the
host's environment. Settings → Bots edits the bots host whatever the settings scope says (it shows no
scope bar): the bots, About you, Voice, guest bots (only when the host has some), and This host, a
read-only list of the env-only features (dictation, Android push, public webhook URL, Linear sync,
host MCP servers) with what turns each on. The host reads them once at startup into the bot
directory's `host` field ([`hostStatus.ts`](apps/server/src/bots/hostStatus.ts)), never a secret, a
token or a token path. Settings → Kanban & Linear (under Code) holds the kanban. `T3CODE_BOTS_HOST`
stays an env switch: it decides which machine opens `bots.sqlite`, so no client may flip it.

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
  reads that reply aloud word for word in the voice's language. The client
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
on screen. Every bot's instructions say that a 🎙️ message is answered for the ear: a few sentences
of plain prose, with no lists, links, code or markdown (`VOICE_REPLY_TEXT` in
[`BotsInstructions.ts`](apps/server/src/bots/BotsInstructions.ts)).

Replies are read word for word. The realtime model paraphrases text it is told to "speak", answers
text it is merely given, and summarizes what it is asked to describe. So the server turns the reply
into plain speech first ([`speakable.ts`](apps/server/src/bots/voice/speakable.ts): markdown dropped,
a short phrase in place of a code block, a table, a URL or long inline code) and appends each part
as a request to read a quoted text exactly as written. Codex cuts the middle out of any appended
speech over about 4,000 bytes, so the server reads a reply longer than `SPEECH_PART_BYTES` in parts,
one realtime turn each, the next appended when the voice falls quiet; a read ends after its last
part. The voice sometimes ends a turn partway through a part; unless the user talked over it, the
server appends the rest once more, from the sentence where it stopped (`unsaid` in
[`VoiceSession.ts`](apps/server/src/bots/voice/VoiceSession.ts)). The prompts and framing are judged with
[`voiceBench.ts`](apps/server/src/bots/voice/voiceBench.ts), which runs scripted replies and spoken
requests (`bench/cases.ts`) through the real voice and scores word recall, self-answers and latency
into `bench/results/`. The model varies between runs, and its behavior changed under unchanged
prompts on 2026-10-29, so rerun the bench before changing a prompt and after a Codex upgrade.
The realtime model cannot be chosen: with a ChatGPT login the backend ignores `thread/realtime/start`'s
`model` and accepts any name.

The realtime model answers simple questions by itself even when told not to. Its prompt therefore
tells it to delegate everything with GPT-Live's `<|SpawnThinking|>` token, and after a delegation
it only acknowledges. The client plays the
voice's audio only for that acknowledgement and for the replies the server sends; turns the voice
starts by itself stay silent (`voiceAudible` in
[`packages/client-runtime/src/voice.ts`](packages/client-runtime/src/voice.ts)). The delegations
reach no agent, because the realtime thread's Codex cannot run turns.

Each session runs its own `codex app-server` and realtime session, closed when the session ends, so
nothing stays open while idle. Settings → Bots → Voice picks the voice and the spoken language on
the bots host (`voiceReaderVoice` and `voiceLanguage` in the server settings; the voice is one of
the nine v3 voices Codex 0.162 offers). The
next read uses a new choice. Realtime fixes its voice at the start, so an open conversation swaps
its realtime session instead: once the voice is quiet the client opens a new peer and the server
starts realtime in the new voice for it, keeping what the user said and the replies still to speak
(`bots.voice.reconnect`). Clients built before this keep their voice until they hang up. Left on "Server default",
`T3CODE_VOICE_READER_VOICE` picks it (default `cove`, Codex's own); a voice the installed Codex does
not offer for v3 falls back to Codex's default with a warning in the log. A language is a whole
script, both prompts and every framing text the server appends
([`voiceLanguage.ts`](apps/server/src/bots/voice/voiceLanguage.ts)), fixed for a session: `pt-BR`
is the measured one, `en` a translation not yet judged with `voiceBench.ts`. Unset, the language
comes from `T3CODE_VOICE_LANGUAGE`, else English. The picker offers previews only when the host
sets `T3CODE_VOICE_SAMPLES_URL` to a directory serving `<voice>.webm`. The locale voices (`porto`, `rio`, …) need Codex 0.163.0 or newer. The protocol
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

## Rotating a bot's conversation

A bot's conversation is generation `g` of `bot:<id>:<g>`. Each bot has a rotation policy (Daily,
Weekly or Off, in the bot editor; Daily by default). A generation becomes due at the first 04:00
host time after it started (six days later for Weekly) once it has at least 10 runs. The server
then queues a handoff turn: the bot saves memories and replies with a short handoff. When that
turn ends and nothing is running, waiting, queued, or delegated, the bot moves to `g + 1`, a fresh
thread with no provider turn. Its instructions carry the handoff and the earlier thread ids, which
it reads with `t3_thread_read` only when needed. One handoff runs at a time on the host.

Thread watches and kanban links move in the same `bots.sqlite` transaction as the generation.
Scheduled and webhook tasks then move through `ScheduledTaskService.rebindThread`, and the old
thread is archived last. A restart finishes a rotation that stopped halfway. Everything else
(peers, push, compaction, queue resume, link access) reads the current generation from the bot
row. The manual reset takes the same path without the handoff turn. PR links stay on the old
thread. See [`apps/server/src/bots/rotation/`](apps/server/src/bots/rotation/).

Clients load earlier generations only from the History button beside the bot's face in the
conversation header (web, desktop and mobile; `bots.bot.history`). An earlier generation opens in
the normal thread view without a composer, since only the current one takes messages. A new
generation with no messages yet points back to the one before it. Both clients read these rules
from `botGenerationView` in
[`packages/client-runtime/src/botChat.ts`](packages/client-runtime/src/botChat.ts).

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

The guest app has voice as well: the composer's wave button, the orb, and a listen button under each
reply, on client-runtime's voice controller. The guest listener carries the session
(`POST /guest/v1/bots/:botId/voice` streams the answer and the bot's activity as SSE, then
`/voice/ready` and `/voice/report`). The thread is always the bot's conversation, and what the guest
says goes through the guest send rules (as the guest, on the bot's model, sandbox only), so the bot
gets `<guest name>: 🎙️ …`. Realtime runs on the host with its ChatGPT login, and no credential
reaches the app or the sandbox. A guest holds one voice session at a time, a revoked token ends it,
and the voice does not change mid-call. See
[`GuestVoice.ts`](apps/server/src/bots/guest/GuestVoice.ts);
[`guestVoiceProbe.ts`](apps/server/src/bots/guest/guestVoiceProbe.ts) runs it against a server's
real voice.

A guest's bot also has three tools that run in the T3 server process
([`GuestTools.ts`](apps/server/src/bots/guest/GuestTools.ts)): `generate_image`, `list_images` and
`html_render`. They reach the sandboxed Claude Code as an in-process Agent SDK MCP server over the
CLI's own stdin/stdout (the turn's `appTools`, attached only to sandbox instances), so no network
route or credential enters the sandbox, and each tool is bound to the turn's thread. Images come from
Codex with the `codex` instance's ChatGPT login: one ephemeral app-server thread per image with every
MCP server, app, plugin and tool feature off, a read-only sandbox, and a guard that stops on any item
but the image ([`CodexImages.ts`](apps/server/src/bots/guest/CodexImages.ts)); edits take only images
of the same conversation. `T3CODE_GUEST_IMAGES_PER_DAY` (default 30) caps them per guest. A page is
stored as given and never runs on the host; the guest API serves it under T3's sandbox CSP. What the
tools made is recorded in `bots.sqlite` (`guest_artifacts`): the bot's own tool output passes through
its sandbox and can be forged, so the guest API serves only recorded artifacts. They appear in the
guest's history as assistant messages without text, before the reply.

The guest app updates itself like the owner's Android app, through the guest API: `app-update`
answers the newest published build and `app-update/apk` sends it, both behind the guest's token.
Each guest has their own folder, `<T3CODE_GUEST_APP_UPDATE_DIR>/<guest id>` (default
`~/.t3-friend/android/bia` for Bia), holding the APK and `latest.json`; the folder comes from the
token, so a guest only reaches their own app. The app checks on start and when it returns to the
foreground, and installs only an APK whose sha256 and size match the manifest. See
[`GuestAppUpdate.ts`](apps/server/src/bots/guest/GuestAppUpdate.ts) and
[`appSelfUpdate.ts`](packages/client-runtime/src/appSelfUpdate.ts), shared with the owner's app.

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

## The Mac app updates itself

The owner's Mac app (unsigned, arm64) updates from the bots host like the Android app:
`DESKTOP_UPDATE_PATH` answers the newest published build and `DESKTOP_UPDATE_ZIP_PATH` sends the
zipped `.app`, both behind the owner's environment auth (the guest listener has no such route). The
server reads `T3CODE_DESKTOP_UPDATE_DIR` (default `~/.t3-friend/desktop`), where
`~/.t3-friend/build-mac-app.sh` builds on omarchy and `publish-mac-app.sh` replaces `latest.json`
atomically. See [`AppUpdate.ts`](apps/server/src/bots/appUpdate/AppUpdate.ts).

The zip is built on Linux. Off macOS, `scripts/build-desktop-artifact.ts` skips the native rebuild,
so node-pty loads its N-API darwin prebuild. The two macOS image tools and the Rust resource monitor
come from `~/.t3-friend/mac-build-tools`; the monitor is built on the Mac only when
`native/resource-monitor` changes.

Only a packaged Mac build that carries `friendBuild` (its commit, in the app's `package.json`) and no
`app-update.yml` turns this on, so upstream's electron-updater never runs beside it. Squirrel.Mac
cannot install an unsigned app, so the main process installs it
([`apps/desktop/src/friend/`](apps/desktop/src/friend/)): it checks the zip's sha256 and size,
extracts it with `ditto`, checks the bundle id and the embedded commit, removes any quarantine
attribute, swaps the bundle with two renames (the old one stays as `~/t3-app-backup-<time>.app`, the
newest two kept) and relaunches. The renderer checks when the bots host connects and when the window
regains focus, at most every 15 minutes, and shows the offer in the sidebar footer. The Mac runs
whatever the bots host publishes: writing that directory on omarchy is shipping code to the Mac.

## Kanban and Linear

The sidebar footer's Kanban button (after Pull Requests, only while a bots host is connected) opens a
board of tickets per project. A project linked to a Linear team (Settings → Kanban & Linear)
shows that team's issues with its workflow states as columns; any other project has a local board
with five columns. Dragging a card moves the issue in Linear first. Linear accounts are personal API
keys kept in the server secret store, never sent to clients. The bots host has no public URL, so it
polls Linear every `T3CODE_KANBAN_POLL_SECONDS` (default 60, `0` off) for issues updated since its
cursor. Tickets link to threads, and each workspace's responsible bots get the `kanban_*` MCP tools
for its tickets and its boards' saved views only; a bot marked responsible for all workspaces gets
them everywhere. Nothing runs by itself. The data lives in `bots.sqlite`. The Android app has a Kanban tab
after Bots (iOS: a Kanban row in its Bots section), one column at a time, and moves cards through
their menu. Design, the study of
other forks, and what is left out: [`docs/friend/linear-kanban.md`](docs/friend/linear-kanban.md).

## Public webhook URLs without T3 Connect

A webhook task's URL normally comes from the T3 Connect relay, so without Connect `schedule_task`
returns no `webhookUrl`. The server still answers direct deliveries at `POST /api/hooks/<task id>/<token>`.
With `T3CODE_WEBHOOK_PUBLIC_BASE_URL` set to an https origin that forwards that path here (say a
Tailscale Funnel), webhook tasks get `<base>/api/hooks/<task id>/<token>`. The relay URL still wins when
Connect is on. The base must be https with no trailing slash; an invalid value is ignored with a warning.
Setup and what the URL exposes: [`docs/friend/webhook-public-base.md`](docs/friend/webhook-public-base.md).
See [`apps/server/src/bots/webhookPublicBase.ts`](apps/server/src/bots/webhookPublicBase.ts).

## Host MCP servers for a bot

A bot can get the tools of an MCP server that runs on the host without the bot, or a guest's
sandbox, holding its token. `~/.t3-friend/bot-host-mcp.json` (or `T3CODE_BOT_HOST_MCP_FILE`) maps a
bot id to Streamable HTTP servers on 127.0.0.1 or [::1] and their token files; T3 lists and calls their tools with
the Bearer and offers them as in-process MCP servers (beside `t3-guest` for a guest's bot). Only the
listed bot gets them, only on a Claude instance, and any failure leaves the bot without those tools
for the turn, never without its turn. Setup and rules: [`docs/friend/bot-host-mcp.md`](docs/friend/bot-host-mcp.md).

## Making a guest's bot the owner's

Settings → Bots → a guest bot's menu → Make it a regular bot (`bots.bot.makeRegular`, the owner's
session only, no MCP tool) removes the guest assignment and stores the chosen host instance with the
same model and options in one `bots.sqlite` transaction, then moves the live conversation with
`thread.model-selection.set`, upstream's provider switch. That order matters: GuestModelPin pins any
model change back to the sandbox while the guest row exists. It refuses while the bot works and any
target that names a guest or launches the sandbox; a retry converges. Plain edits (`bot_update`, the
edit dialog) refuse a host model for a guest's bot, so this is the only way out of the sandbox.
Afterwards the guest no longer sees the bot, gets no push for it, and its guest tools and artifacts
are gone from its turns; its role, memories, conversation and listed host MCP servers stay.

## Linked environments and bots

Upstream's linked environments let agents here work on another machine; the owner's Mac is linked
from the bots host with full access, which the Mac does not fence. The fork's
[`BotLinkAccess`](apps/server/src/bots/linkAccess.ts) is therefore the only barrier. A bot's
conversation may use links only when the user turned it on in the bot's editor (Settings → Bots,
"May work on linked environments"; table `linked_environment_bots` in `bots.sqlite`, empty at
first) and it belongs to
no guest; a guest's bot is refused even when its row is there, and the server refuses to add one.
Only the owner's `bots.bot.linkedEnvironments` RPC (`orchestration:operate`) writes the table: no
MCP tool, `bot_update` included, can. Any other thread may when its parent, its root and every
thread that messaged it may, so work an unlisted bot started, delegated or messaged is refused, and
so is a scheduled task an agent made. The gate reads the table on every check, so a switch applies
to the next call. PeerForwarding and PeerLinkRequests cannot be built without it, and it rechecks
every call, including the followers of remote tasks; `/mcp` also hides the link tools from refused
callers. Any error reading a caller's origin refuses.

## VS Code in the right panel

On web and desktop, "VS Code" replaces Files in the right panel's "Open a surface" menus and takes
its F shortcut; the Files view itself stays, reachable from file links, the diff and the PR guide.
Mobile is unchanged. The tab opens `/vscode/?folder=<the thread's worktree, else the project root>`
on the thread's environment, so a remote environment serves its own VS Code. Keys typed in the frame
stay in its document; the desktop's native menu accelerators (quit, reload, zoom, Settings) still
reach the app.

The server proxies `/vscode/*`, HTTP and WebSocket, to Microsoft's `code serve-web` (the standalone
CLI, licence accepted with `--accept-server-license-terms`). The first request starts it as a
transient `systemd-run --user` unit with `MemoryMax=$T3CODE_VSCODE_MEMORY_MAX` (default `3G`),
`CPUWeight=20` and `IOWeight=20`; one unit serves every tab and stops after
`T3CODE_VSCODE_IDLE_MS` (default 30 minutes) with no open connection, or when T3 stops. Where no
systemd user manager answers (macOS, a Linux without one), checked once on the first start, it runs
instead as T3's child in its own process group under `nice -n 10`, with no memory cap, its stderr in
`$T3CODE_VSCODE_DATA_DIR/run/*.log`. A small `sh` wrapper kills that group when T3's end of its stdin
closes, so it dies with T3 even when T3 is killed outright.

The CLI is `T3CODE_VSCODE_CLI` when set. Otherwise the server looks in `~/.t3-friend/vscode/bin/code`,
then on macOS in `Visual Studio Code.app`'s `code-tunnel` (`/Applications` or `~/Applications`), then
for `code` on `PATH`. The tab names the standalone CLI download for the machine's platform when none is
found. Its data is `T3CODE_VSCODE_DATA_DIR` (default `~/.t3-friend/vscode`).

serve-web listens on a unix socket in a 0700 directory and runs without a connection token: its
client repeats the token inside the socket protocol, so the token would have to reach the browser.
Access is the owner's session check with `terminal:operate` (the app's cookie, or a media `wsTicket`
for the desktop's bearer session, traded once for a cookie scoped to `/vscode` that dies with the
session). The guest listener has no `/vscode` route. Responses lose `X-Frame-Options`; embedding is
allowed to the app's own origin and the desktop renderer, plus `T3CODE_VSCODE_FRAME_ANCESTORS`. See
[`apps/server/src/bots/vscode/`](apps/server/src/bots/vscode/).

VS Code opens in "T3 Dark" or "T3 Light", a theme extension that
[`scripts/friend/vscode-theme.ts`](scripts/friend/vscode-theme.ts) generates into
`apps/server/src/bots/vscode/theme/`: the workbench colors from the default theme's tokens in
`apps/web/src/index.css`, the syntax colors from `@pierre/theme` (light mode darkened like
`t3-light`), the editor font and size from the default code font. Before every start the server
installs it into `$T3CODE_VSCODE_DATA_DIR/server/extensions` under a folder named by its content
hash, so an unchanged theme writes nothing. The extension sets `window.autoDetectColorScheme` and
the preferred dark and light themes as configuration defaults, so a theme or font the user picks in
VS Code wins and stays. Uninstalling it inside VS Code does not last: the next start installs it again.

The tab follows T3's light or dark mode rather than the operating system's. A frame's
`prefers-color-scheme` reports the system whatever the embedder's `color-scheme`, so the proxy adds a
small script to the workbench page that answers VS Code's two color-scheme queries from the
`t3-color-scheme` URL parameter, and the panel posts each later change to the frame, without a
reload ([`colorScheme.ts`](apps/server/src/bots/vscode/colorScheme.ts)).

## State and rollback

Bot data lives in `bots.sqlite` next to the upstream database in the T3 userdata directory. The fork
adds no columns or events to upstream tables. A bot's conversation is an ordinary thread whose id
starts with `bot:`, so the official T3 Code app can open the same userdata directory; it shows bot
threads as normal threads and ignores `bots.sqlite`.
