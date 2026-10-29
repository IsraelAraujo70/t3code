// @effect-diagnostics globalDate:off -- Fixtures are local calendar days.
import {
  BotId,
  KanbanTicketId,
  LOCAL_KANBAN_WORKSPACE_ID,
  LinearAccountId,
  ProjectId,
  linearWorkspaceId,
  type KanbanActivity,
  type KanbanComment,
  type KanbanLabel,
  type KanbanPullRequestRef,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type LinearWorkflowState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { KANBAN_LOCAL_COLUMN_COLORS } from "./kanbanBoard.ts";
import {
  assigneeChoices,
  buildKanbanLookups,
  dateFromIsoDay,
  dueDatePresets,
  formatDueDate,
  formatKanbanDate,
  isoDay,
  isOverdue,
  issueTimeline,
  labelChoices,
  personDisplay,
  personInitials,
  priorityGlyph,
  pullRequestBadge,
  responsibleBotIds,
  statusChoices,
  statusDisplay,
  statusGlyph,
} from "./kanbanDisplay.ts";

const statusId = (status: KanbanTicketStatus) =>
  status.kind === "local" ? status.state : status.stateId;

const state = (id: string, type: LinearWorkflowState["type"], position: number) => ({
  id,
  teamId: "back",
  name: id,
  type,
  position,
  color: "#f2c94c",
});

const displaySnapshot: KanbanSnapshot = {
  accounts: [],
  workspaces: [],
  links: [],
  states: [state("doing", "started", 2), state("review", "started", 3)],
  tickets: [],
  people: [
    {
      id: "u-ana",
      organizationId: "org",
      name: "Ana Souza",
      displayName: "ana",
      avatarUrl: "https://example.test/ana.png",
      active: true,
    },
    {
      id: "u-mail",
      organizationId: "org",
      name: "bot@example.test",
      displayName: "deploys",
      avatarUrl: null,
      active: true,
    },
  ],
  labels: [],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
  allWorkspacesBotIds: [],
};
const lookups = buildKanbanLookups(displaySnapshot, [], "Israel");

describe("statusGlyph", () => {
  it("draws Linear's glyph for each category", () => {
    expect(statusGlyph("backlog")).toEqual({ kind: "dashed" });
    expect(statusGlyph("unstarted")).toEqual({ kind: "ring", fill: "none" });
    expect(statusGlyph("completed")).toMatchObject({ kind: "disc" });
    expect(statusGlyph("started", 1)).toEqual({ kind: "ring", fill: "full" });
  });

  it("fills a started glyph by progress, past the half with the large arc", () => {
    expect(statusGlyph("started", 0.5)).toEqual({
      kind: "ring",
      fill: { path: "M7 7V3.5A3.5 3.5 0 0 1 7 10.5Z" },
    });
    expect(statusGlyph("started", 0.75)).toEqual({
      kind: "ring",
      fill: { path: "M7 7V3.5A3.5 3.5 0 1 1 3.5 7Z" },
    });
  });

  it("draws a team's later started states fuller", () => {
    expect(statusDisplay(lookups, { kind: "linear", stateId: "doing" }).progress).toBe(0.5);
    expect(statusDisplay(lookups, { kind: "linear", stateId: "review" }).progress).toBe(0.75);
    expect(statusDisplay(lookups, { kind: "linear", stateId: "gone" }).name).toBe("Unknown status");
  });
});

describe("priorityGlyph", () => {
  it("lights more bars for higher priority", () => {
    expect([0, 1, 2, 3, 4].map(priorityGlyph)).toEqual([
      { kind: "none" },
      { kind: "urgent" },
      { kind: "bars", filled: 3 },
      { kind: "bars", filled: 2 },
      { kind: "bars", filled: 1 },
    ]);
  });
});

describe("personDisplay", () => {
  it("names the owner, bots and Linear users, never by email", () => {
    expect(personDisplay(lookups, "owner").name).toBe("Israel");
    expect(personDisplay(lookups, "bot:ops")).toMatchObject({ name: "ops", botId: "ops" });
    expect(personDisplay(lookups, "u-ana")).toMatchObject({
      name: "Ana Souza",
      avatarUrl: "https://example.test/ana.png",
    });
    expect(personDisplay(lookups, "u-mail").name).toBe("deploys");
    expect(personDisplay(lookups, "u-gone", "gone@example.test").name).toBe("Unknown");
    expect(personDisplay(lookups, "u-gone", "Rui").name).toBe("Rui");
  });

  it("takes initials from the first two words", () => {
    expect(personInitials("Ana Souza")).toBe("AS");
    expect(personInitials("israel")).toBe("I");
    expect(personInitials("")).toBe("?");
  });
});

describe("pullRequestBadge", () => {
  const pr = (number: number, prState: KanbanPullRequestRef["state"]): KanbanPullRequestRef => ({
    attachmentId: `a${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    repository: "o/r",
    number,
    title: "t",
    state: prState,
  });

  it("shows one number, or a count in the most advanced state", () => {
    expect(pullRequestBadge([])).toBeNull();
    expect(pullRequestBadge([pr(174, "open")])).toEqual({ text: "#174", state: "open" });
    expect(pullRequestBadge([pr(1, "closed"), pr(2, "merged"), pr(3, "draft")])).toEqual({
      text: "3 PRs",
      state: "merged",
    });
  });
});

describe("dates", () => {
  const now = new Date(2026, 9, 27, 15, 0);

  it("formats like Linear, with the year only when it differs", () => {
    expect(formatKanbanDate(new Date(2026, 9, 26), now)).toBe("Oct 26");
    expect(formatKanbanDate(new Date(2025, 0, 3), now)).toBe("Jan 3, 2025");
  });

  it("shows a stored due date that is not a real day as written", () => {
    const short = (date: Date) => formatKanbanDate(date, now);
    expect(formatDueDate("2026-10-26", short)).toBe("Oct 26");
    expect(formatDueDate("2026-99-99", short)).toBe("2026-99-99");
    expect(isOverdue({ dueDate: "2026-02-30", closedAt: null }, now)).toBe(false);
  });

  it("marks an open ticket overdue from the day after its due date", () => {
    expect(isOverdue({ dueDate: "2026-10-26", closedAt: null }, now)).toBe(true);
    expect(isOverdue({ dueDate: "2026-10-27", closedAt: null }, now)).toBe(false);
    expect(isOverdue({ dueDate: "2026-10-26", closedAt: "2026-10-27T00:00:00.000Z" }, now)).toBe(
      false,
    );
  });

  it("offers due dates counted in local days", () => {
    expect(dueDatePresets(now).map((preset) => preset.value)).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-11-03",
      "2026-11-10",
      "2026-11-26",
    ]);
  });
});

describe("local statuses", () => {
  it("draw in the board's local column colors and their category", () => {
    expect(statusDisplay(lookups, { kind: "local", state: "todo" })).toEqual({
      name: "Todo",
      stateType: "unstarted",
      color: KANBAN_LOCAL_COLUMN_COLORS.todo,
      progress: 0,
    });
    expect(statusDisplay(lookups, { kind: "local", state: "in_review" })).toMatchObject({
      stateType: "started",
      progress: 0.75,
    });
  });
});

describe("calendar days", () => {
  it("round-trip through local midnight", () => {
    expect(isoDay(dateFromIsoDay("2026-03-09"))).toBe("2026-03-09");
    expect(dateFromIsoDay("2026-03-09").getHours()).toBe(0);
  });
});

const ACCOUNT = LinearAccountId.make("la_1");
const at = "2026-10-26T10:00:00.000Z";

const baseTicket = (linear: boolean): KanbanTicket => ({
  id: KanbanTicketId.make(linear ? "t_lin" : "t_loc"),
  projectId: ProjectId.make("api"),
  linear: linear
    ? { accountId: ACCOUNT, issueId: "i1", teamId: "back", url: "https://linear.app/x" }
    : null,
  identifier: linear ? "BACK-1" : "T-1",
  title: "Fix login",
  status: linear ? { kind: "linear", stateId: "s-todo" } : { kind: "local", state: "todo" },
  assigneeId: null,
  assigneeName: null,
  creatorId: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  linearProjectId: null,
  milestoneId: null,
  cycleId: null,
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
});

const label = (
  id: string,
  source: KanbanLabel["source"],
  teamId: string | null,
  organization = "org",
): KanbanLabel => ({
  id,
  workspaceId: source === "local" ? LOCAL_KANBAN_WORKSPACE_ID : linearWorkspaceId(organization),
  teamId,
  name: id,
  color: "#ff0000",
  parentId: null,
  source,
});

const person = (id: string, name: string, active = true, organizationId = "org") => ({
  id,
  organizationId,
  name,
  displayName: name,
  avatarUrl: null,
  active,
});

const snapshot: KanbanSnapshot = {
  accounts: [
    {
      id: ACCOUNT,
      name: "Moneria",
      keyLast4: "abcd",
      userName: "Zé",
      userId: "u-ze",
      userAvatarUrl: null,
      organizationId: "org",
      organizationName: "Moneria",
      organizationUrlKey: "moneria",
      createdAt: at,
      updatedAt: at,
    },
  ],
  workspaces: [{ id: linearWorkspaceId("org"), name: "Moneria", botIds: [] }],
  links: [],
  states: [
    { id: "s-done", teamId: "back", name: "Done", type: "completed", position: 1, color: "#0f0" },
    { id: "s-todo", teamId: "back", name: "Todo", type: "unstarted", position: 1, color: "#999" },
    { id: "s-other", teamId: "front", name: "Todo", type: "unstarted", position: 1, color: "#999" },
  ],
  tickets: [],
  people: [
    person("u-bia", "Bia"),
    person("u-ze", "Zé"),
    person("u-old", "Old", false),
    person("u-elsewhere", "Elsewhere", true, "other-org"),
  ],
  labels: [
    label("team-bug", "linear", "back"),
    label("org-wide", "linear", null),
    label("front-only", "linear", "front"),
    label("other-org", "linear", null, "other-org"),
    label("local-1", "local", null),
  ],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
  allWorkspacesBotIds: [],
};

describe("issueTimeline", () => {
  const activity = (id: string, createdAt: string): KanbanActivity => ({
    id,
    actorId: null,
    actorName: "Linear",
    actorAvatarUrl: null,
    text: "moved",
    createdAt,
  });
  const comment = (id: string, createdAt: string): KanbanComment => ({
    id,
    authorId: null,
    authorName: "Ana",
    authorAvatarUrl: null,
    body: "hi",
    parentId: null,
    createdAt,
    editedAt: null,
    deletable: false,
  });

  it("merges history and comments oldest first, history first at the same instant", () => {
    const timeline = issueTimeline({
      activity: [activity("a1", "2026-10-26T09:00:00.000Z"), activity("a2", at)],
      comments: [comment("c1", at), comment("c0", "2026-10-25T09:00:00.000Z")],
    });
    expect(
      timeline.map((entry) => (entry.kind === "activity" ? entry.activity.id : entry.comment.id)),
    ).toEqual(["c0", "a1", "a2", "c1"]);
  });

  it("keeps an id shared by a history line and a comment distinct", () => {
    const timeline = issueTimeline({ activity: [activity("x", at)], comments: [comment("x", at)] });
    expect(timeline.map((entry) => entry.id)).toEqual(["a:x", "c:x"]);
  });
});

describe("issue choices", () => {
  it("moves a Linear ticket only within its team, in board order", () => {
    expect(statusChoices(snapshot, baseTicket(true)).map(statusId)).toEqual(["s-todo", "s-done"]);
    expect(statusChoices(snapshot, baseTicket(false)).map(statusId)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
    ]);
  });

  it("assigns a Linear ticket to its workspace's active people, the key's own user first", () => {
    expect(assigneeChoices(snapshot, baseTicket(true), ["ops"])).toEqual(["u-ze", "u-bia"]);
    expect(assigneeChoices(snapshot, { ...baseTicket(true), assigneeId: "u-old" }, [])).toContain(
      "u-old",
    );
  });

  it("assigns a local ticket to the owner or a bot", () => {
    expect(assigneeChoices(snapshot, baseTicket(false), ["ops"])).toEqual(["owner", "bot:ops"]);
  });

  it("offers the team's and the workspace's Linear labels, or local labels", () => {
    expect(labelChoices(snapshot, baseTicket(true)).map((choice) => choice.id)).toEqual([
      "team-bug",
      "org-wide",
    ]);
    expect(labelChoices(snapshot, baseTicket(false)).map((choice) => choice.id)).toEqual([
      "local-1",
    ]);
  });

  it("takes the ticket's own bot over the workspace's", () => {
    const withBots: KanbanSnapshot = {
      ...snapshot,
      workspaces: [
        {
          id: linearWorkspaceId("org"),
          name: "Moneria",
          botIds: [BotId.make("ops"), BotId.make("qa")],
        },
      ],
    };
    expect(responsibleBotIds(withBots, baseTicket(true))).toEqual(["ops", "qa"]);
    expect(responsibleBotIds(withBots, { ...baseTicket(true), botId: BotId.make("solo") })).toEqual(
      ["solo"],
    );
  });

  it("does not offer Linear label groups, which Linear does not assign", () => {
    const grouped: KanbanSnapshot = {
      ...snapshot,
      labels: [
        { ...label("area", "linear", "back") },
        { ...label("area-api", "linear", "back"), parentId: "area" },
      ],
    };
    expect(labelChoices(grouped, baseTicket(true)).map((choice) => choice.id)).toEqual([
      "area-api",
    ]);
  });
});
