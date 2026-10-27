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
  type KanbanSnapshot,
  type KanbanTicket,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assigneeChoices,
  issueTimeline,
  labelChoices,
  responsibleBotIds,
  statusChoices,
} from "./kanbanIssue.logic";

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
});

describe("issue choices", () => {
  it("moves a Linear ticket only within its team, in board order", () => {
    expect(statusChoices(snapshot, baseTicket(true)).map((choice) => choice.id)).toEqual([
      "s-todo",
      "s-done",
    ]);
    expect(statusChoices(snapshot, baseTicket(false)).map((choice) => choice.id)).toEqual([
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
});
