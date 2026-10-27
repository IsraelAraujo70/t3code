import {
  BotId,
  KANBAN_DEFAULT_VIEW_CONFIG,
  KanbanTicketId,
  LinearAccountId,
  linearWorkspaceId,
  LOCAL_KANBAN_WORKSPACE_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanFilterClause,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanViewConfig,
  type LinearStateType,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildKanbanView,
  describeClause,
  dropActionFor,
  filterOptions,
  groupTickets,
  kanbanMeIds,
  kanbanStartProjectTarget,
  sortViewTickets,
  ticketMatchesClause,
  viewTickets,
  type KanbanGroup,
  type KanbanViewContext,
} from "./kanbanView.ts";

const LINKED = ProjectId.make("linked");
const ACCOUNT = LinearAccountId.make("la_1");
const at = "2026-10-24T00:00:00.000Z";
const THREAD = ThreadId.make("thread-1");

const context: KanbanViewContext = {
  now: Date.parse(at),
  threadStatus: (threadId) => (threadId === THREAD ? "working" : null),
  personName: (personId) => (personId === "owner" ? "Israel" : null),
};

const config = (patch: Partial<KanbanViewConfig> = {}): KanbanViewConfig => ({
  ...KANBAN_DEFAULT_VIEW_CONFIG,
  completed: "all",
  completedByRecency: false,
  ...patch,
});

const ticket = (id: string, patch: Partial<KanbanTicket> = {}): KanbanTicket => ({
  id: KanbanTicketId.make(id),
  projectId: LINKED,
  linear: { accountId: ACCOUNT, issueId: `issue-${id}`, teamId: "team", url: "https://linear.app" },
  identifier: `MON-${id}`,
  title: "Work",
  status: { kind: "linear", stateId: "s-doing" },
  assigneeId: "me-id",
  assigneeName: null,
  creatorId: "other",
  priority: 2,
  estimate: null,
  dueDate: null,
  labelIds: ["bug"],
  linearProjectId: "lp",
  milestoneId: null,
  cycleId: "cycle",
  parent: null,
  subIssues: null,
  pullRequests: [],
  botId: null,
  sortOrder: 0,
  closedAt: null,
  autoClosed: false,
  threadIds: [],
  createdAt: at,
  updatedAt: at,
  ...patch,
});

const parent = ticket("1", {
  dueDate: "2026-10-25",
  subIssues: { total: 1, closed: 0 },
  threadIds: [THREAD],
  pullRequests: [
    {
      attachmentId: "pr",
      url: "https://github.com/o/r/pull/1",
      repository: "o/r",
      number: 1,
      title: "Fix",
      state: "open",
    },
  ],
});
const child = ticket("2", {
  parent: { issueId: "issue-1", identifier: "MON-1", title: "Parent" },
  assigneeId: "other",
});
const local = ticket("3", {
  linear: null,
  identifier: "T-1",
  status: { kind: "local", state: "todo" },
  assigneeId: "owner",
  creatorId: "owner",
  labelIds: [],
  cycleId: null,
  linearProjectId: null,
  priority: 0,
});
const done = ticket("4", {
  status: { kind: "linear", stateId: "s-done" },
  closedAt: "2026-10-23T00:00:00.000Z",
});
const old = ticket("5", {
  status: { kind: "linear", stateId: "s-done" },
  closedAt: "2026-10-01T00:00:00.000Z",
});
const canceled = ticket("6", {
  status: { kind: "linear", stateId: "s-cancel" },
  closedAt: "2026-10-22T00:00:00.000Z",
});

const states = (
  [
    ["s-backlog", "Backlog", "backlog"],
    ["s-todo", "A Fazer", "unstarted"],
    ["s-doing", "Em Progresso", "started"],
    ["s-review", "Em Revisão", "started"],
    ["s-done", "Concluído", "completed"],
    ["s-cancel", "Cancelado", "canceled"],
  ] as const
).map(([id, name, type], position) => ({
  id,
  teamId: "team",
  name,
  type: type satisfies LinearStateType,
  position,
  color: "#123456",
}));

const person = (id: string, name: string, organizationId: string) => ({
  id,
  organizationId,
  name,
  displayName: name,
  avatarUrl: null,
  active: true,
});

const snapshot: KanbanSnapshot = {
  accounts: [
    {
      id: ACCOUNT,
      name: "Moneria",
      keyLast4: "1234",
      userName: "Me",
      userId: "me-id",
      userAvatarUrl: null,
      organizationId: "org",
      organizationName: "Moneria",
      organizationUrlKey: "moneria",
      createdAt: at,
      updatedAt: at,
    },
  ],
  workspaces: [{ id: linearWorkspaceId("org"), name: "Moneria", botIds: [] }],
  links: [
    {
      projectId: LINKED,
      accountId: ACCOUNT,
      teamId: "team",
      teamKey: "MON",
      teamName: "Moneria",
      linearProjectId: null,
      linearProjectName: null,
      lastSyncedAt: at,
      syncError: null,
      createdAt: at,
    },
  ],
  states,
  tickets: [parent, child, local, done, old, canceled],
  people: [
    person("me-id", "Me", "org"),
    person("other", "Other", "org"),
    person("foreign", "Foreign", "elsewhere"),
  ],
  labels: [
    {
      id: "bug",
      workspaceId: linearWorkspaceId("org"),
      teamId: null,
      name: "Bug",
      color: "#ff0000",
      parentId: null,
      source: "linear",
    },
    {
      id: "local-label",
      workspaceId: LOCAL_KANBAN_WORKSPACE_ID,
      teamId: null,
      name: "Chore",
      color: "#00ff00",
      parentId: null,
      source: "local",
    },
  ],
  linearProjects: [
    { id: "lp", organizationId: "org", name: "Payments", color: "#ff0000", icon: null },
  ],
  milestones: [],
  cycles: [
    {
      id: "cycle",
      teamId: "team",
      number: 1,
      name: null,
      startsAt: "2026-10-20T00:00:00.000Z",
      endsAt: "2026-10-30T00:00:00.000Z",
    },
    { id: "foreign-cycle", teamId: "other-team", number: 2, name: null, startsAt: at, endsAt: at },
  ],
  views: [],
};

const ids = (tickets: ReadonlyArray<KanbanTicket>) => tickets.map((entry) => entry.id);
const group = (id: string): KanbanGroup => ({ id, title: id, icon: { kind: "none" }, tickets: [] });
const matches = (subject: KanbanTicket, clause: KanbanFilterClause, ctx = context) =>
  ticketMatchesClause(snapshot, subject, clause, ctx);

describe("filters", () => {
  it("expands me to every account's user and the owner, and notIn excludes the whole set", () => {
    expect([...kanbanMeIds(snapshot)].sort()).toEqual(["me-id", "owner"]);
    const mine = { kind: "set", field: "assignee", op: "in", values: ["me"] } as const;
    expect(matches(parent, mine)).toBe(true);
    expect(matches(local, mine)).toBe(true);
    expect(matches(child, mine)).toBe(false);
    expect(matches(child, { ...mine, op: "notIn" })).toBe(true);
    expect(matches(parent, { ...mine, op: "notIn", values: ["other", "me"] })).toBe(false);
  });

  it("matches label none, the current cycle, content, thread status and pull requests", () => {
    expect(matches(local, { kind: "set", field: "label", op: "in", values: ["none"] })).toBe(true);
    expect(matches(parent, { kind: "set", field: "label", op: "in", values: ["none"] })).toBe(
      false,
    );
    const current = { kind: "set", field: "cycle", op: "in", values: ["current"] } as const;
    expect(matches(parent, current)).toBe(true);
    expect(
      matches(parent, current, { ...context, now: Date.parse("2026-10-30T00:00:00.000Z") }),
    ).toBe(false);
    expect(matches(parent, { kind: "text", field: "content", value: "bUg" })).toBe(true);
    const threads = { kind: "set", field: "threadStatus", op: "in", values: ["working"] } as const;
    expect(matches(parent, threads)).toBe(true);
    expect(matches(child, { ...threads, values: ["none"] })).toBe(true);
    expect(matches(parent, { kind: "set", field: "pullRequest", op: "in", values: ["open"] })).toBe(
      true,
    );
  });

  it("filters statuses by the all-projects columns as well as by state", () => {
    const inProgress = { kind: "set", field: "status", op: "in", values: ["in_progress"] } as const;
    expect(matches(parent, inProgress)).toBe(true);
    expect(matches(parent, { ...inProgress, values: ["s-doing"] })).toBe(true);
    expect(matches(canceled, { ...inProgress, values: ["canceled"] })).toBe(true);
    expect(matches(local, { ...inProgress, values: ["todo"] })).toBe(true);
  });

  it("uses day windows, UTC due dates, and never matches a missing date", () => {
    expect(matches(parent, { kind: "date", field: "createdAt", op: "pastDays", value: 7 })).toBe(
      true,
    );
    expect(matches(old, { kind: "date", field: "closedAt", op: "pastDays", value: 7 })).toBe(false);
    expect(matches(done, { kind: "date", field: "closedAt", op: "pastDays", value: 7 })).toBe(true);
    const dueSoon = { kind: "date", field: "dueDate", op: "nextDays", value: 2 } as const;
    expect(matches(parent, dueSoon)).toBe(true);
    expect(matches(parent, { ...dueSoon, value: 0 })).toBe(false);
    expect(matches(child, dueSoon)).toBe(false);
    expect(matches(child, { kind: "date", field: "dueDate", op: "isEmpty", value: null })).toBe(
      true,
    );
    expect(
      matches(old, { kind: "date", field: "closedAt", op: "before", value: "2026-10-10" }),
    ).toBe(true);
  });

  it("applies the completed window and hides sub-issues only when their parent is in scope", () => {
    expect(
      ids(
        viewTickets(
          snapshot,
          LINKED,
          config({ completed: "pastWeek", showSubIssues: false }),
          context,
        ),
      ),
    ).toEqual(ids([parent, local, done, canceled]));
    expect(
      ids(
        viewTickets(
          { ...snapshot, tickets: [child] },
          LINKED,
          config({ showSubIssues: false }),
          context,
        ),
      ),
    ).toEqual(ids([child]));
    expect(ids(viewTickets(snapshot, LINKED, config({ completed: "none" }), context))).toEqual(
      ids([parent, child, local]),
    );
  });
});

describe("sortViewTickets", () => {
  it("puts urgent first and no priority last, and closed tickets after open ones by recency", () => {
    const urgent = ticket("7", { priority: 1 });
    expect(ids(sortViewTickets([local, parent, urgent], config()))).toEqual(
      ids([urgent, parent, local]),
    );
    expect(
      ids(sortViewTickets([old, local, done, canceled], config({ completedByRecency: true }))),
    ).toEqual(ids([local, done, canceled, old]));
  });

  it("puts tickets without a due date last", () => {
    expect(ids(sortViewTickets([child, parent], config({ orderBy: "dueDate" })))).toEqual(
      ids([parent, child]),
    );
  });
});

describe("groupTickets", () => {
  it("follows the linked team's states, with local tickets in the first state of their category", () => {
    const groups = groupTickets(snapshot, LINKED, "status", snapshot.tickets);
    expect(groups.map((entry) => entry.title)).toEqual([
      "Backlog",
      "A Fazer",
      "Em Progresso",
      "Em Revisão",
      "Concluído",
      "Cancelado",
    ]);
    expect(ids(groups.find((entry) => entry.id === "s-todo")!.tickets)).toEqual(ids([local]));
  });

  it("uses the local states plus canceled on the all-projects board", () => {
    const groups = groupTickets(snapshot, null, "status", snapshot.tickets);
    expect(groups.map((entry) => entry.id)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]);
    expect(groups[1]!.icon).toEqual({ kind: "status", stateType: "unstarted", color: "#e2e2e2" });
    expect(ids(groups.find((entry) => entry.id === "canceled")!.tickets)).toEqual(ids([canceled]));
  });

  it("orders priorities urgent to low, then no priority", () => {
    expect(groupTickets(snapshot, null, "priority", []).map((entry) => entry.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "0",
    ]);
  });
});

describe("buildKanbanView", () => {
  it("folds empty and user-hidden columns and lays assignee swimlanes over visible columns", () => {
    const view = buildKanbanView(
      snapshot,
      null,
      config({ hiddenColumns: ["done"], subGroupBy: "assignee" }),
      context,
    );
    expect(view.teamId).toBeNull();
    expect(view.columns.map((column) => column.id)).toEqual(["todo", "in_progress", "canceled"]);
    expect(view.hiddenColumns.map((column) => column.id)).toEqual(["backlog", "in_review", "done"]);
    expect(view.total).toBe(6);
    expect(view.swimlanes!.map((lane) => [lane.id, lane.title])).toEqual([
      ["owner", "Israel"],
      ["me-id", "Me"],
      ["other", "Other"],
    ]);
    const mine = view.swimlanes!.find((lane) => lane.id === "me-id")!;
    expect(ids(mine.cells.get("in_progress")!)).toEqual(ids([parent]));
    expect(mine.cells.has("done")).toBe(false);
  });

  it("keeps empty columns when the view shows them", () => {
    const view = buildKanbanView(snapshot, LINKED, config({ showEmptyColumns: true }), context);
    expect(view.teamId).toBe("team");
    expect(view.columns).toHaveLength(6);
    expect(view.hiddenColumns).toEqual([]);
    expect(view.swimlanes).toBeNull();
  });
});

describe("dropActionFor", () => {
  it("moves within the ticket's own workflow and refuses canceled for local tickets", () => {
    expect(dropActionFor(snapshot, parent, "status", group("s-done"))).toEqual({
      kind: "move",
      to: { kind: "linear", stateId: "s-done" },
    });
    expect(dropActionFor(snapshot, parent, "status", group("in_review"))).toEqual({
      kind: "move",
      to: { kind: "linear", stateId: "s-review" },
    });
    expect(dropActionFor(snapshot, parent, "status", group("canceled"))).toEqual({
      kind: "move",
      to: { kind: "linear", stateId: "s-cancel" },
    });
    expect(dropActionFor(snapshot, parent, "status", group("in_progress"))).toBeNull();
    expect(dropActionFor(snapshot, local, "status", group("canceled"))).toBeNull();
    expect(dropActionFor(snapshot, local, "status", group("s-doing"))).toEqual({
      kind: "move",
      to: { kind: "local", state: "in_progress" },
    });
  });

  it("assigns only people who fit the ticket", () => {
    expect(dropActionFor(snapshot, parent, "assignee", group("foreign"))).toBeNull();
    expect(dropActionFor(snapshot, parent, "assignee", group("owner"))).toBeNull();
    expect(dropActionFor(snapshot, parent, "assignee", group("other"))).toEqual({
      kind: "update",
      patch: { assigneeId: "other" },
    });
    expect(dropActionFor(snapshot, local, "assignee", group("me-id"))).toBeNull();
    expect(dropActionFor(snapshot, local, "assignee", group("none"))).toEqual({
      kind: "update",
      patch: { assigneeId: null },
    });
  });

  it("adds only usable labels, and none clears them", () => {
    expect(dropActionFor(snapshot, parent, "label", group("local-label"))).toBeNull();
    expect(dropActionFor(snapshot, parent, "label", group("bug"))).toBeNull();
    expect(dropActionFor(snapshot, parent, "label", group("none"))).toEqual({
      kind: "update",
      patch: { labelIds: [] },
    });
    expect(dropActionFor(snapshot, local, "label", group("local-label"))).toEqual({
      kind: "update",
      patch: { labelIds: ["local-label"] },
    });
  });

  it("sets cycles of the ticket's own team only, and priority by group", () => {
    expect(dropActionFor(snapshot, parent, "cycle", group("foreign-cycle"))).toBeNull();
    expect(dropActionFor(snapshot, local, "cycle", group("cycle"))).toBeNull();
    expect(dropActionFor(snapshot, parent, "cycle", group("none"))).toEqual({
      kind: "update",
      patch: { cycleId: null },
    });
    expect(dropActionFor(snapshot, parent, "priority", group("1"))).toEqual({
      kind: "update",
      patch: { priority: 1 },
    });
    expect(dropActionFor(snapshot, parent, "none", group("all"))).toBeNull();
  });
});

describe("filter options and chips", () => {
  it("offers the scope's people with me first and none last, counted over the scope", () => {
    const people = filterOptions(snapshot, LINKED, "assignee", context);
    expect(people.map((option) => [option.value, option.label, option.count])).toEqual([
      ["me", "Me", 5],
      ["owner", "Israel", 1],
      ["me-id", "Me", 4],
      ["other", "Other", 1],
      ["none", "None", 0],
    ]);
  });

  it("offers the scope team's cycles and counts current and thread status from the context", () => {
    const cycles = filterOptions(snapshot, LINKED, "cycle", context);
    expect(cycles.map((option) => [option.value, option.count])).toEqual([
      ["current", 5],
      ["cycle", 5],
      ["none", 1],
    ]);
    const threads = filterOptions(snapshot, LINKED, "threadStatus", context);
    expect(threads.find((option) => option.value === "working")!.count).toBe(1);
    expect(threads.find((option) => option.value === "none")!.count).toBe(5);
  });

  it("reads clauses as chips", () => {
    expect(
      describeClause(snapshot, { kind: "set", field: "priority", op: "in", values: ["1", "2"] }),
    ).toEqual({ field: "Priority", op: "is any of", value: "Urgent, High" });
    expect(
      describeClause(snapshot, {
        kind: "set",
        field: "assignee",
        op: "notIn",
        values: ["me", "none"],
      }),
    ).toEqual({ field: "Assignee", op: "is not any of", value: "Me, None" });
    expect(
      describeClause(snapshot, { kind: "set", field: "status", op: "in", values: ["s-doing"] }),
    ).toEqual({ field: "Status", op: "is", value: "Em Progresso" });
    expect(
      describeClause(snapshot, { kind: "set", field: "label", op: "notIn", values: ["bug"] }),
    ).toEqual({ field: "Labels", op: "is not", value: "Bug" });
    expect(
      describeClause(snapshot, { kind: "date", field: "dueDate", op: "nextDays", value: 7 }),
    ).toEqual({ field: "Due date", op: "in the next", value: "7 days" });
    expect(
      describeClause(snapshot, {
        kind: "date",
        field: "createdAt",
        op: "before",
        value: "2026-10-01",
      }),
    ).toEqual({ field: "Created", op: "before", value: "2026-10-01" });
    expect(describeClause(snapshot, { kind: "flag", field: "hasThreads", value: false })).toEqual({
      field: "Has linked thread",
      op: "is",
      value: "No",
    });
    expect(
      describeClause(
        snapshot,
        { kind: "set", field: "t3Project", op: "in", values: [LINKED] },
        { projectName: (id) => (id === LINKED ? "moneria-api" : null) },
      ),
    ).toEqual({ field: "T3 project", op: "is", value: "moneria-api" });
    expect(describeClause(snapshot, { kind: "text", field: "content", value: "pix" })).toEqual({
      field: "Content",
      op: "contains",
      value: "pix",
    });
  });
});

describe("review fixes", () => {
  it("does not move a ticket dropped on the folded column it already sits in", () => {
    const extra = { ...states[2]!, id: "s-doing-2", name: "Fazendo", position: 10 };
    const inExtra = ticket("7", { status: { kind: "linear", stateId: "s-doing-2" } });
    const wider = { ...snapshot, states: [...states, extra], tickets: [inExtra] };
    const column = { ...group("in_progress"), tickets: [inExtra] };
    expect(dropActionFor(wider, inExtra, "status", column)).toBeNull();
  });

  it("counts and matches a local ticket in the linked state its column shows", () => {
    const todo = filterOptions(snapshot, LINKED, "status").find((o) => o.value === "s-todo");
    expect(todo?.count).toBe(1);
    expect(matches(local, { kind: "set", field: "status", op: "in", values: ["s-todo"] })).toBe(
      true,
    );
  });

  it("offers only the bots of workspaces the board reaches", () => {
    const scoped: KanbanSnapshot = {
      ...snapshot,
      workspaces: [
        { id: linearWorkspaceId("org"), name: "Moneria", botIds: [BotId.make("ours")] },
        { id: linearWorkspaceId("elsewhere"), name: "Other", botIds: [BotId.make("theirs")] },
      ],
    };
    expect(filterOptions(scoped, LINKED, "bot").map((option) => option.value)).toEqual(["ours"]);
  });
});

describe("kanbanStartProjectTarget", () => {
  const model = (name: string) => ({ instanceId: ProviderInstanceId.make("codex"), model: name });
  const shells = [
    { projectId: "other", updatedAt: "2026-10-27T00:00:00.000Z", modelSelection: model("newest") },
    { projectId: LINKED, updatedAt: "2026-10-20T00:00:00.000Z", modelSelection: model("old") },
    { projectId: LINKED, updatedAt: "2026-10-25T00:00:00.000Z", modelSelection: model("recent") },
  ];

  it("lets the server pick when the project has a default model", () => {
    expect(kanbanStartProjectTarget(model("default"), shells, parent)).toEqual({ kind: "project" });
  });

  it("copies the project's latest thread model, else the environment's latest", () => {
    expect(kanbanStartProjectTarget(null, shells, parent).modelSelection?.model).toBe("recent");
    expect(
      kanbanStartProjectTarget(null, shells, { projectId: ProjectId.make("empty") }).modelSelection
        ?.model,
    ).toBe("newest");
    expect(kanbanStartProjectTarget(null, [], parent)).toEqual({ kind: "project" });
  });
});
