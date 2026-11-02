# friend fork

This fork of [T3 Code](https://github.com/pingdotgg/t3code) adds bots: named, long-lived agents with a
standing role, a default model, their own memory, and one ongoing conversation each (plus optional side threads). It replaces the
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
scope bar): the bots, About you, Voice, and This host, a
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

## Side threads of a bot

Besides its main conversation, a bot can hold side threads, one per subject, that run in parallel
with it: `bot:<id>:t-<key>` in Scratch, on the bot's model, with the bot's role, memories and tools.
Memories are read on every turn, so one saved in any thread reaches the next turn of all of them;
messages stay in their own thread. The user opens one with a title from the Threads button beside
the bot's face in the conversation header (web and desktop), and the bot with `bot_thread_open`.
Archiving, restoring and renaming are the thread's own, and deleting the bot archives them.
In the web sidebar the Sections and Tabs layouts list side threads under their bot in the Bots
block; Rail and Mixed keep them in the thread list, where any bot thread shows its bot's face and
name in place of "No project". Mobile lists them under their bot in the Bots tab (the Bots section
on iOS) and leaves them out of the home list; the wide-screen sidebar keeps every bot thread and
shows its bot's face in place of the project icon.

A side thread has no row in `bots.sqlite`: the id names its bot. `parseBotThreadId` still matches
only the main conversation, so rotation, compaction, push, voice, history and the mobile
thread screen ignore side threads; code where a thread acts as its bot (instructions, memory and bot tools, the bot
sender mark, link access, host MCP tools, queue resume) uses `parseBotThreadOwner`.

## The Mac app updates itself

The owner's Mac app (unsigned, arm64) updates from the bots host like the Android app:
`DESKTOP_UPDATE_PATH` answers the newest published build and `DESKTOP_UPDATE_ZIP_PATH` sends the
zipped `.app`, both behind the owner's environment auth. The
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

A bot can get the tools of an MCP server that runs on the host without the bot holding its token.
`~/.t3-friend/bot-host-mcp.json` (or `T3CODE_BOT_HOST_MCP_FILE`) maps a
bot id to Streamable HTTP servers on 127.0.0.1 or [::1] and their token files; T3 lists and calls their tools with
the Bearer and offers them as in-process MCP servers. Only the
listed bot gets them, only on a Claude instance, and any failure leaves the bot without those tools
for the turn, never without its turn. Setup and rules: [`docs/friend/bot-host-mcp.md`](docs/friend/bot-host-mcp.md).

## Linked environments and bots

Upstream's linked environments let agents here work on another machine; the owner's Mac is linked
from the bots host with full access, which the Mac does not fence. The fork's
[`BotLinkAccess`](apps/server/src/bots/linkAccess.ts) is therefore the only barrier. A bot's
conversation may use links only when the user turned it on in the bot's editor (Settings → Bots,
"May work on linked environments"; table `linked_environment_bots` in `bots.sqlite`, empty at
first). Only the owner's `bots.bot.linkedEnvironments` RPC (`orchestration:operate`) writes the table: no
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

The thread header's "Open in" picker offers it as "VS Code in T3", first in the list and the default
choice: the button and the favorite-editor shortcut open (or focus) the same tab. Picking an external
editor in the list makes that the default again, kept per browser. The choice appears only where the
thread's environment advertises the `vscode` capability (Linux with the CLI installed, read at
startup) and the session holds `terminal:operate`; otherwise the picker is upstream's.

The server proxies `/vscode/*`, HTTP and WebSocket, to Microsoft's `code serve-web` (the standalone
CLI, licence accepted with `--accept-server-license-terms`). The first request starts it as a
transient `systemd-run --user` unit with `MemoryMax=$T3CODE_VSCODE_MEMORY_MAX` (default `3G`),
`CPUWeight=20` and `IOWeight=20`; one unit serves every tab and stops after
`T3CODE_VSCODE_IDLE_MS` (default 30 minutes) with no open connection, or when T3 stops. The CLI is
`T3CODE_VSCODE_CLI` (default `~/.t3-friend/vscode/bin/code`), its data `T3CODE_VSCODE_DATA_DIR`
(default `~/.t3-friend/vscode`). A missing CLI shows its path in the tab.

serve-web listens on a unix socket in a 0700 directory and runs without a connection token: its
client repeats the token inside the socket protocol, so the token would have to reach the browser.
Access is the owner's session check with `terminal:operate` (the app's cookie, or a media `wsTicket`
for the desktop's bearer session, traded once for a cookie scoped to `/vscode` that dies with the
session). Responses lose `X-Frame-Options`; embedding is
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

## Workflows

Workflows run repeatable routines on the bots host: command steps, agent turns, gates and blocks
(hillclimb, arena, graph, interrogate) wired as a graph in a YAML definition. The engine lives in
[`apps/server/src/bots/workflows/`](apps/server/src/bots/workflows/), the schema and compiler in
`packages/contracts/src/workflows.ts` and `packages/shared/src/workflows/`, the screens in
`apps/web/src/bots/workflows/` and `apps/mobile/src/bots/workflows/`. Design and its reasons:
[`docs/friend/workflows-design.md`](docs/friend/workflows-design.md).

On the host, under the T3 home (`~/.t3`):

- `workflows/definitions/` is a git repository with one `<id>.workflow.yaml` per workflow. Every save
  is a commit; the server ingests it at startup and picks up hand edits. Library templates ship in
  [`apps/server/src/bots/workflows/library/`](apps/server/src/bots/workflows/library/).
- `userdata/bots.sqlite` holds each run's journal (`workflow_facts`) and the run list (`workflow_runs`).
- `workflows/runs/<runId>/` holds the receipts of each command unit (`started.json`, `exit.json`),
  the step directories, build artifacts, and the run's worktrees until `retain` lets them go.

The host needs `T3CODE_BOTS_HOST=1`, a user systemd (each command runs in a `systemd-run --user` unit
that outlives a server restart), the projects a definition names registered by title, and an enabled
Claude and Codex instance (the first enabled one, or `T3CODE_WORKFLOW_CLAUDE_INSTANCE` and
`T3CODE_WORKFLOW_CODEX_INSTANCE`). Steps marked `heavy` take heavy.sh's lock
(`T3CODE_WORKFLOW_HEAVY_LOCK`, default `~/.cache/t3-testdata/heavy.lock`), and agent steps are told to
run heavy commands through `T3CODE_WORKFLOW_HEAVY_SH` (default `~/.cache/t3-testdata/heavy.sh`); both
must use the same lock. Steps that open a pull
request push to the project's `origin` and call `gh`, so `gh` must be logged in.

Steps run on the host, not in a container: the RSI routines need the `:99` display, the host MCP
servers and the provider homes. The guard is the owner's gate. Before a command whose argv deploys,
restarts, merges into `friend/main`, force pushes or writes `~/.t3/userdata/settings.json`, the run
waits for a decision that only a user session makes (`bots.workflows.gate.decide`, which needs
`orchestration:operate`); no MCP tool and no bot decides a gate. The gate reads only command argv,
so an agent with a shell can go around it, a risk the owner accepted. The engine itself only pushes
`wf/…` branches, without force, and opens draft pull requests. Merging into `friend/main` is always
a handoff.

A step's agent turn is an ordinary thread with id `wf:<runId>:<keyHash>`
([`workflowThreads.ts`](packages/contracts/src/workflowThreads.ts)). These threads stay out of the
sidebar, search, the command palette, the archive and per-thread notifications; they open from the
run view or by direct link.

## Using workflows

Open Workflows from the Bots block of the sidebar (web and desktop) or from the Workflows row of the
Android Bots tab. It lists the bots host's workflows with their last run.

- **Create one.** "From template" copies a ready routine under a new name; "New workflow" starts
  blank. A new workflow starts turned off.
- **Run it.** Turn it on, then press "Run now" and fill in the parameters, or keep the defaults.
  While it is on, its triggers (a schedule, a new upstream tag) start runs by themselves.
- **Follow a run.** The run page shows each step with its status, cost and the thread its agent
  worked in. A failed step can be retried from there.
- **Approve a gate.** A run that needs you stops at a gate and shows the question with its options
  on the run page; Android also sends a notification. Pick an option and the run continues on that
  path. Only you decide gates, never a bot.
- **Read the result.** A run ends ready for review (with a draft pull request), with no gain,
  blocked, or failed. Merging into `friend/main` stays your step.

Each workflow is a file in `~/.t3/workflows/definitions` on the bots host. Saving in the editor
commits it there, and a hand edit of the file shows up in the app. Two templates are not ready to run
unattended yet, "Hillclimb de throughput no argo35" and "Correções viram enforcement estrutural";
their description says what is missing.

## State and rollback

Bot data lives in `bots.sqlite` next to the upstream database in the T3 userdata directory. The fork
adds no columns or events to upstream tables. A bot's conversation is an ordinary thread whose id
starts with `bot:`, so the official T3 Code app can open the same userdata directory; it shows bot
threads as normal threads and ignores `bots.sqlite`.

- `apps/web/src/bots/workflows/canvas/fonts/Excalifont-Regular-latin.woff2`: Excalifont (Latin subset) from excalidraw/excalidraw `packages/excalidraw/fonts/Excalifont` at 21ffaf4d, SIL OFL 1.1, license in `fonts/OFL.txt`.
