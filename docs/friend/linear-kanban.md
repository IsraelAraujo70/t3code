# Kanban of agents, synced (or not) with Linear

A board of tickets in the T3 Code fork, beside Pull Requests in the sidebar footer. A project's board
is local (five fixed columns) or follows one Linear team's workflow, with moves going both ways.
Tickets link to the threads working on them, and each workspace has bots responsible for it.

## What other forks did

Searched the forks of `pingdotgg/t3code` (paginated, recent and starred first), branch names, code
search for `linear`, `kanban`, `LinearClient`, `api.linear.app`, and upstream PRs. Upstream `main`
(`becf853`) has no Linear or Kanban code. Four forks had relevant work, all MIT like upstream:

| Fork                                                                                                                                          | Revision  | What it has                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [maslinedwin/t3code](https://github.com/maslinedwin/t3code/tree/5ab69b55663dc104a1546fac915b662defa1630c) `feat/linear-issue-import`          | `5ab69b5` | Linear import, one thread ↔ one issue, status written back when a turn starts, a PR opens or merges. One API key in `ServerSecretStore` (`linear.api-token`). No polling, no board.                                             |
| [Bil0000/t3code](https://github.com/Bil0000/t3code/tree/4b44b92e0848b31c03f659182082cd49b8b0238a) `t3/issues-independent-main-draft-20261014` | `4b44b92` | Account-scoped issue trackers: several accounts, keys per connection in `ServerSecretStore`, project → tracker scope bindings, thread links with a title/state snapshot. Refreshes on visits and run ends, no poller. No board. |
| [what1f/t3kanban](https://github.com/what1f/t3kanban/tree/bdae6a89d5503392b67eb722a103d3648985297d) `main`                                    | `bdae6a8` | A task board over threads: fixed columns (Todo, In Progress, In Review, Blocked, Done), native HTML drag and drop, a sidebar entry. No Linear.                                                                                  |
| [ccdwyer/t3code](https://github.com/ccdwyer/t3code/tree/dc4e660481b251c621a22870ba18676c4caf4617) `ft/hyperion` (upstream PR #3135)           | `dc4e660` | Executable workflow boards with `@dnd-kit/core`, external-source sync every 120 s with persisted cursors and backoff, server-held PATs. Sources are GitHub, Asana and Jira; no Linear.                                          |

Upstream proposals: open [#19274](https://github.com/pingdotgg/t3code/pull/19274) (standalone Linear
tracker) and [#19576](https://github.com/pingdotgg/t3code/pull/19576) (tracker workflows and thread
links); closed [#3711](https://github.com/pingdotgg/t3code/pull/3711),
[#7065](https://github.com/pingdotgg/t3code/pull/7065),
[#3135](https://github.com/pingdotgg/t3code/pull/3135),
[#7091](https://github.com/pingdotgg/t3code/pull/7091).

None combined a Linear-synced board with thread links and responsible agents, so no code was copied
verbatim. Ideas taken, adapted to the fork's `bots.sqlite` and services:

- **Keys in `ServerSecretStore`, never sent back** (maslinedwin, Bil0000). One secret per account.
- **Accounts as the unit, projects bound to an account's scope** (Bil0000).
- **Columns from the team's real workflow states, ordered by state type then `position`**; the
  `issueUpdate(id, input: { stateId })` mutation (maslinedwin's GraphQL).
- **A persisted sync cursor** (ccdwyer), so a restart resumes instead of re-reading everything.
- **`@dnd-kit/core` for the board** (ccdwyer), already a web dependency used by the bots sidebar.
- **Fixed local columns for boards without Linear** (what1f), minus "Blocked".

Left out on purpose: maslinedwin's in-memory progression and state cache (lost on restart), automatic
status writes on turn and PR events (surprising for a shared company workspace), ccdwyer's whole
workflow engine (lanes running agents and scripts), and what1f's "a task is a thread" model, since a
Linear ticket needs several threads.

## Design

### Accounts and workspaces

A Linear personal API key belongs to one user in one workspace (organization). So an **account** is
a named key, and several accounts give several workspaces, or several users of one workspace. Adding
an account calls `viewer` with the key: a refused key is never stored. The key goes to the server
secret store as `friend-linear-<accountId>`; `bots.sqlite` keeps only the name, the last 4
characters, the user's name and the organization. Clients get those, never the key. OAuth is not
implemented (a personal key covers the use; OAuth needs a public redirect URL).

A **workspace** is either `local` or one Linear organization (`linear:<orgId>`). Two accounts in the
same organization are one workspace.

### Links

- **Project → account + team (+ optional Linear project).** At most one per T3 project. Changing
  the team or account drops the project's synced tickets (they belong to the old scope); local
  tickets stay. Unlinking does the same.
- **Ticket → threads.** Any number of threads, from the card's menu or a bot's tool. A thread
  deleted later just stops showing.
- **Workspace → bots.** Any number of responsible bots, set in Settings → Bots → Kanban & Linear.

### Data (`bots.sqlite`, migration `8_Kanban`)

`linear_accounts`, `kanban_project_links` (with `sync_cursor`, `last_full_sync_at`, `sync_error`),
`linear_workflow_states`, `kanban_tickets` (local tickets have `local_state`; synced ones
`issue_id` + `linear_state_id`; unique per project and issue), `kanban_ticket_threads`,
`kanban_workspace_bots` (cascades when a bot is deleted). No upstream table changes, so the official
app can still open the same userdata.

The kanban lives on the bots host, like everything else in `bots.sqlite`: other servers of the fork
answer the kanban RPCs with "Bots run on another machine", and the sidebar button appears only while
a bots host is connected.

### Sync: polling, not webhooks

The bots host has no public URL (only the tailnet), so Linear's webhooks cannot reach it. Every
`T3CODE_KANBAN_POLL_SECONDS` (default 60, `0` turns it off) the server syncs each linked project:

- **Incremental:** issues of the team (and Linear project) with `updatedAt > cursor`, archived ones
  included so they can be dropped. Issues that left the team are dropped too.
- **Full**, on link, on "Sync now", and every 30 minutes: open issues plus anything updated in the
  last 30 days. Tickets outside that window are dropped, except tickets with linked threads, which
  are re-read by id and kept until they are archived or leave the team.

One sync runs at a time. A failure is stored on the link and shown on the board and in Settings; the
next success clears it. About 60 requests per hour per linked project, far under Linear's limit.

Linear caps query complexity at 10,000. Teams with their projects nested exceed it in a workspace
with a few teams (Moneria: 12,130), so teams and projects are read flat and grouped on the server.

### Board

- A board narrowed to a **linked project** shows its team's states as columns (Moneria Back-end:
  Backlog, A Fazer, Em Progresso, Em Revisão, Concluído, Cancelado, Duplicate).
- Any other board (an unlinked project, or several projects at once) has the five local columns,
  and Linear tickets fold in by category. Linear has no review category, so a started state named
  like a review (`In Review`, `Em Revisão`) counts as "In review"; canceled and duplicate tickets
  have no column there.
- A card shows the identifier, priority, title, the workspace's bots, the assignee, and each linked
  thread with its status (Needs approval, Waiting for answer, Failed, Working, Settled). Clicking a
  thread opens it.
- Dragging a card moves it. A Linear ticket moves in Linear first; the board keeps Linear's answer,
  so a refused move changes nothing. The column under the pointer takes the card.
- Filters: project, workspace, Linear account. "New ticket" creates a local ticket, or a Linear issue
  in a linked project (Linear picks its column).

Thread status comes from the thread shells the client already has; the kanban snapshot carries only
thread ids, so the board adds no per-thread traffic.

### Phone

On Android the board is its own navigation tab, after Bots. Upstream's phone bar holds four sections
plus Settings and lists the rest at the top of Settings. With Bots and Kanban there are five, so the
fork ends the phone bar in a More item instead of Settings: Chats, Bots, Kanban, Pulls, More. More
opens a menu of the sections that did not fit (upstream's overflow: Usage, or whatever the order in
Settings → Navigation tabs pushes past the fourth) and Settings, and is selected while one of them
is on screen. Picking one is the same as pressing its tab. Kanban takes part in Navigation tabs like
the others (reorder, hide). Tablet rails are unchanged. iOS has no Bots tab, so there the board
opens from a "Kanban" row under "Computer" in the Bots section.

The board uses the same RPCs and the same board rules (`@t3tools/client-runtime/kanban-board`), with
the project, workspace and account filters as menu chips. A phone shows one column at a time, picked
from a row of chips with counts. Dragging across a small screen is clumsy, so a card moves through
its menu, opened by long-press or the ⋯ button: "Move to…" lists only the columns the ticket can
take, and the same menu links and unlinks threads, opens the issue in Linear, or deletes a local
ticket. "New ticket" asks for a title. Tapping a linked thread opens it with `returnTab: "kanban"`
in its route params, so Android Back (and the header's up arrow) return to the Kanban tab instead
of Chats. The tab stops listening to the board while it is not on screen, since the server
republishes the snapshot after every sync.

### Bots

Responsible bots appear on the workspace's cards and get eight MCP tools: `kanban_list` (with
filters: status types, states, assignee incl. `me` = the bot, priorities, labels, text, linked
threads, a limit), `kanban_get` (the issue with description, comments and history, trimmed, plus
the labels and assignees it accepts), `kanban_update` (priority, assignee, labels, due date, title,
the ticket's bot), `kanban_comment`, `kanban_move`, `kanban_create`, `kanban_link_thread` (defaults
to the calling thread) and `kanban_unlink_thread`. On a local ticket, history and comments name the
bot that acted. The caller comes from the trusted MCP scope; a bot reaches only the
workspaces it is responsible for, and a bot responsible for none is refused.

**No automation.** Nothing starts a thread or moves a ticket by itself (for example "when a ticket
enters In progress, the responsible bot opens a thread"). That is left for later as an explicit,
per-workspace rule that is off by default and deduplicated in the database.

## Not done (v1; v2 added comments, labels, assignees and starting threads)

- Linear accounts and project links on the phone: they are edited on web or desktop, and the app
  says so when no account exists.
- OAuth accounts, Linear webhooks.

## Verified (2026-10-26)

On an isolated server (`~/.cache/friend-tmp/linear-kanban-home`, ports 14425/6385,
`T3CODE_BOTS_HOST=1`) seeded with a read-only copy of the real database:

- Two accounts added with the same Moneria key under different names ("Moneria (Israel)",
  "Moneria (bots)"); both show `••••` plus the last 4, one Moneria workspace; the key is in
  `userdata/secrets` (0600) and occurs 0 times in `bots.sqlite`.
- `moneria-api` linked to Back-end; the board filled with the team's real issues and columns.
- Test ticket **BACK-204** created from the board, dragged Backlog → Em Progresso (Linear's state
  history confirms it), moved to Em Revisão in Linear and seen on the board 4 s later by polling,
  then dragged to Cancelado (left canceled in Linear).
- Two threads linked to BACK-204 with their status; clicking one opened it; bot "Moneria Ops" made
  responsible for Moneria and shown on the cards.
- Local board on the unlinked `server` project: T-1 and T-2 created and moved between columns.

## v2: Linear-grade board, filters, views and the issue view

v2 keeps v1's model (accounts, project links, polling, local boards, thread links, responsible bots)
and adds what a Linear user expects: dense cards, filters, display options, saved views, and an issue
view that opens beside the board like a pull request does.

### Data (`bots.sqlite`, migration `9_KanbanV2`)

- `kanban_tickets` gains the fields cards and filters read: assignee and creator ids, estimate, due
  date, label ids and attached GitHub PRs (JSON arrays), Linear project, milestone and cycle, parent
  issue (id, identifier, title), sub-issue progress (total, closed), Linear's `sortOrder`, when it
  closed, and whether Linear auto-closed it. `bot_id` (the ticket's own bot) and `description` (local
  tickets) are T3-only: a sync never writes them.
- Catalogs, replaced on each full sync: `linear_users` (people, with avatars), `kanban_labels`
  (Linear labels of each workspace, and local labels), `linear_projects`, `linear_milestones`,
  `linear_cycles` (per linked team, ending in the last 90 days or later).
- `linear_accounts` gains the key owner's user id and avatar, which is who "me" is.
- `kanban_views`: saved views (name, icon, JSON config, optional Linear custom view id, position).
  The migration seeds Active, Backlog, All issues, Meus issues and Concluídas.
- `kanban_local_comments` and `kanban_ticket_events` (history of local tickets).

The migration clears every link's `last_full_sync_at`, so the first poll after the upgrade reads
the new fields for every synced ticket.

### Linear queries, measured

Measured on Moneria with Linear's `x-complexity` response header (limit 10,000 per query):

| Query                                                                                                    | Complexity         |
| -------------------------------------------------------------------------------------------------------- | ------------------ |
| Sync page: root `issues(first: 100)` with every card field, children (50), labels (50), attachments (25) | 17                 |
| The same fields under `team { issues(first: 100) }`                                                      | 1,521              |
| Issue view: description, parent, children (100), comments (100), history (100)                           | 2,011              |
| `users(first: 250)`                                                                                      | 400                |
| `issueLabels(first: 250)`                                                                                | 425                |
| `projectMilestones(first: 250)`                                                                          | 350                |
| `projects(first: 100)` with icon and color (with teams: 540)                                             | ~300               |
| A team's `cycles(first: 50)`                                                                             | 126                |
| `customViews(first: 50)`                                                                                 | 230                |
| v1's `teams { projects(first: 100) }`                                                                    | refused (> 10,000) |

Root `issues` is priced far below the same selection under a team, so the sync keeps it with a team
filter. Every list is paginated. Description, comments and history are read only when an issue
opens, never on the polling path; the poll still asks only for issues updated since the cursor.

### Filters

Filters run on the client over the snapshot (`@t3tools/client-runtime/kanban-board`, shared by web
and mobile). A view keeps the tickets that match every clause. Clause kinds:

- **Set** (`is`, `is not`, `is any of`, `is not any of`): status (a state id, or a local state),
  status type, assignee and creator (a Linear user id, `owner`, `bot:<id>`, plus `me` and `none`),
  priority (`0`–`4`), label (`none`), Linear project, milestone, cycle (`current` is the cycle
  running now), responsible bot (the ticket's own bot, else its workspace's), thread status (any
  linked thread; `none`), pull request state (`none`), workspace, Linear account (`local`), T3
  project.
- **Date** (`before`, `after`, in the past or next N days, set, empty): created, updated, due,
  completed.
- **Flag**: is a sub-issue, has sub-issues, has a linked thread, has a PR, auto-closed, has a due
  date.
- **Text**: identifier, title and label names contain the text. Descriptions are not on the board,
  so they are not searched.

"Me" is every Linear account's own user plus `owner` (the T3 user, assignee of local tickets).

The AI filter turns a sentence into clauses with the OpenRouter key dictation already uses
(`T3CODE_KANBAN_AI_FILTER_MODEL`, default `anthropic/claude-haiku-5.5`); every clause the model
returns is decoded, and invalid ones are dropped. Without `OPENROUTER_API_KEY` the button says why.

### Display and views

A view stores its filters and display: board or list, columns and swimlanes grouped by status,
assignee, priority, label, project, cycle or thread status, ordering (priority, updated, created,
manual, due date, thread status),
completed issues (all, past week, past month, none), closed tickets by recency, sub-issues, empty
columns, hidden columns, and the card properties shown. Empty or hidden columns fold into a "Hidden
columns" panel. Views are tabs; they can be saved, renamed, reordered and deleted, and live on the
bots host, so every client sees the same ones. A view is on every board, or on one project's board.
T3 has one owner per server, so views are the owner's.

Linear's custom views can be imported once per account: the filters T3 can express (assignee is me
or a person, state type or name, priority, labels by name, parent, children, project, cycle, due
date set) become a T3 view; the rest are listed as skipped. An imported view stays inside its
Linear workspace (and its team's T3 projects for a team view), and "me" is the importing account's
user. Nothing is written to Linear.

Manual order follows Linear's `sortOrder` (and a local ticket's own). Dragging to reorder inside a
column is not offered for Linear tickets: the order is shared by the whole team in Linear.

#### Grouping by thread status

A ticket takes the most urgent status of its linked threads, in this rank
(`THREAD_STATUS_RANK` in `kanbanView.ts`):

1. Needs approval
2. Waiting for answer
3. Failed
4. Working
5. Settled (idle, ready or done: T3 does not tell these apart)
6. No thread: no linked thread, or none this client knows (archived or on another environment)

Failed ranks above Working because it needs the user and Working does not. Groups and swimlanes
follow this rank, with "No thread" last. Ordering by thread status uses the same rank, and ties
fall back to the newest update, as ordering by priority does. The status is the client's live view
of the threads, so a card moves when its thread changes, as the thread status filter does. It is
not stored on the ticket, so dropping a card on a thread status group does nothing.

Clients decode the kanban snapshot strictly, saved views included. A client built before thread
status grouping (an older Android APK) fails to load the Kanban tab once any saved view uses it,
and an older bots host refuses to save such a view. Update the phone app and the host before saving
one. Desktop and web follow the server they connect to.

### Writes

Status, priority, assignee, labels, due date, project, milestone, cycle, estimate, title and
description go to Linear with `issueUpdate`, comments with `commentCreate`/`commentDelete`. As in
v1, the board keeps Linear's answer, so a refused write changes nothing. A ticket's own bot is
T3-only. Local tickets take priority, local labels, an assignee (the owner or a bot), a description,
comments, and keep a history.

### Web

The page keeps its URL as the deep link: `/kanban?project=<id>&view=<id>&issue=BACK-169&full=1`.
View tabs, the filter button and chips, search (`/`), and the display menu sit above the board or
list. A card opens the issue in a panel on the right (`PreviewPanelShell`, resizable); the panel's
maximize button takes the whole page, like a pull request. From the PR view it reuses the PR
glyphs, checks and diff stat (`linkedPullRequestDetailAtom`), and a PR row opens
`/pull-requests` with that PR selected when its repository is a project of this environment.
Issue descriptions and comments render with the chat's markdown.

### Phone (v2)

The Android Kanban tab draws the same cards (status and priority glyphs in `react-native-svg`),
a row of saved views, and chips for status, assignee (Me first), priority and label, with the
workspace and Linear account as filter chips; the project stays a scope menu. A tap opens the issue
screen (`BotsKanbanIssue`): description, editable properties, sub-issues, comments with a composer,
activity, pull requests (the app's PR screen when the repository resolves) and threads (open,
unlink, link, start). The card's long-press menu stays; its thread rows moved to the issue screen.
Saving and editing views is web-only.

### Local tickets

A local ticket's `closed_at` is set when it enters Done and cleared when it leaves (migration
`10_KanbanLocalClosedAt` backfills v1's Done tickets), so the completed-issues window and ordering
treat local and Linear tickets alike.

### Starting work

"Start thread" on an issue creates a thread in the ticket's T3 project with the project's default
model (or one picked), in the project root, whose first message carries the issue: identifier,
title, link and description. "Ask <bot>" sends the same message to a bot's conversation instead.
Either way the thread is linked to the ticket. Nothing starts by itself.

### Not done in v2

- **Linear images in descriptions and comments.** `uploads.linear.app` files need the account's
  key; the issue view renders markdown with the chat's renderer, which loads images directly, so
  private Linear uploads show as broken images. A server proxy route with the key would fix it; it
  was left out to avoid a new authenticated HTTP route.
- **Manual reordering of Linear cards** (shared order of the whole team in Linear), and of local
  cards (manual order follows `sortOrder`; there is no drag-to-reorder within a column yet).
- **Linear favorites.** Custom views are imported on demand; favorites are not mirrored.
- **Several accounts with different visibility in one organization.** A full sync refreshes an
  organization's catalog (people, labels, projects, milestones) from one of its accounts per pass,
  replacing the previous one. If accounts of the same organization see different private teams,
  names from the other account's teams can go missing until its link syncs again.
- **"Time in status" and "Set default for everyone"** from Linear's display panel: Linear exposes no
  time-in-status field, and views are already shared across the owner's clients.
- **Description search.** Descriptions are not on the board, so the Content filter matches
  identifier, title and labels only.
- **Phone:** saving, renaming and reordering views are web-only; the due date takes presets or a
  typed `YYYY-MM-DD`, without a native date picker; no swimlanes on the phone.

### Verified (2026-10-27)

On an isolated server (base dir `~/.cache/friend-tmp/kanban-v2-home`, ports 16392/8352, bots host,
seeded with `migrate-dev-db --projects 20` from a read-only snapshot; deleted afterwards) with the
real Moneria Linear:

- Sync of `moneria-api` ↔ Back-end: 111 tickets with labels, PRs, parents, sub-issue progress;
  catalogs 9 people, 17 labels, 11 projects, 5 milestones; account user and avatar set.
- Board, filters (Assignee is Me), display (rows by priority), views (seeded, imported from Linear:
  5 imported, "Tarefas bloqueadas" skipped; "Meus por prioridade" created), the issue panel and full
  screen, PR rows with live checks opening the T3 PR view, AI filter ("minhas issues de prioridade
  alta que têm PR aberto" → Assignee is Me, Priority is High, Pull requests is Open).
- Writes only on BACK-204: priority, assignee, label, due date, a comment (UI and service), a drag
  Cancelado → Concluído and back through the status picker; Linear confirmed it ended Cancelado,
  with no priority, assignee, labels or due date, and no comments.
- Local board on `moneria-docs`: priority, local label, assignee bot, description, comment, history;
  "Start thread" created a thread with the issue as its first message and linked it.
- Android (release APK on the `friend36` emulator): Kanban tab with the new cards, saved views
  (Meus issues), filter chips, the issue screen with properties, sub-issues, activity, comments,
  threads, and PRs opening the app's PR screen.
