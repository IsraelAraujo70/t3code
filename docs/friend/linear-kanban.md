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

### Bots

Responsible bots appear on the workspace's cards and get five MCP tools: `kanban_list`,
`kanban_move`, `kanban_create`, `kanban_link_thread` (defaults to the calling thread) and
`kanban_unlink_thread`. The caller comes from the trusted MCP scope; a bot reaches only the
workspaces it is responsible for, and a bot responsible for none is refused.

**No automation.** Nothing starts a thread or moves a ticket by itself (for example "when a ticket
enters In progress, the responsible bot opens a thread"). That is left for later as an explicit,
per-workspace rule that is off by default and deduplicated in the database.

## Not done

- Mobile: the Android app has no board. The RPCs and contracts are shared, so a later mobile screen
  needs only UI.
- OAuth accounts, Linear webhooks, comments, labels, assignee changes, card reordering within a
  column.
- Starting a thread from a card (link an existing thread instead).

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
