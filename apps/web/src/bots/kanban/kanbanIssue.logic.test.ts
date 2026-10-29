import { buildKanbanLookups } from "@t3tools/client-runtime/kanban-display";
import {
  BotId,
  ProviderInstanceId,
  ThreadId,
  KanbanTicketId,
  LinearAccountId,
  linearWorkspaceId,
  LOCAL_KANBAN_WORKSPACE_ID,
  ProjectId,
  type KanbanLabel,
  type KanbanSnapshot,
  type KanbanTicket,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assigneeOptions,
  cycleOptions,
  minuteEpoch,
  nextLabelColor,
  parsePullRequestUrl,
  relativeTimeLabel,
} from "./kanbanIssue.logic";

const ACCOUNT = LinearAccountId.make("la_1");
const at = "2026-10-24T12:00:00.000Z";
const NOW = Date.parse(at);

const ticket = (patch: Partial<KanbanTicket> = {}): KanbanTicket => ({
  id: KanbanTicketId.make("t1"),
  projectId: ProjectId.make("p"),
  linear: { accountId: ACCOUNT, issueId: "i1", teamId: "team", url: "https://linear.app/x" },
  identifier: "MON-1",
  title: "Work",
  status: { kind: "linear", stateId: "s-doing" },
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
  ...patch,
});

const label = (id: string, patch: Partial<KanbanLabel> = {}): KanbanLabel => ({
  id,
  workspaceId: linearWorkspaceId("org"),
  teamId: null,
  name: id,
  color: "#000000",
  parentId: null,
  source: "linear",
  ...patch,
});

const person = (id: string, name: string, organizationId = "org", active = true) => ({
  id,
  organizationId,
  name,
  displayName: name,
  avatarUrl: null,
  active,
});

const cycle = (id: string, startsAt: string, endsAt: string, teamId = "team") => ({
  id,
  teamId,
  number: Number(id.slice(1)),
  name: null,
  startsAt,
  endsAt,
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
  workspaces: [],
  links: [],
  states: [
    { id: "s-done", teamId: "team", name: "Done", type: "completed", position: 0, color: "#0f0" },
    {
      id: "s-review",
      teamId: "team",
      name: "In Review",
      type: "started",
      position: 2,
      color: "#00f",
    },
    { id: "s-doing", teamId: "team", name: "Doing", type: "started", position: 1, color: "#ff0" },
    { id: "s-todo", teamId: "team", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
    { id: "s-other", teamId: "other", name: "Todo", type: "unstarted", position: 0, color: "#fff" },
  ],
  tickets: [],
  people: [
    person("zed", "Zed"),
    person("me-id", "Israel"),
    person("ann", "Ann"),
    person("gone", "Gone", "org", false),
    person("elsewhere", "Elsewhere", "other-org"),
  ],
  labels: [
    label("team-bug", { teamId: "team" }),
    label("org-wide"),
    label("group"),
    label("child", { parentId: "group" }),
    label("other-team", { teamId: "other" }),
    label("local-a", { workspaceId: LOCAL_KANBAN_WORKSPACE_ID, source: "local" }),
  ],
  linearProjects: [],
  milestones: [],
  cycles: [
    cycle("c1", "2026-09-01T00:00:00.000Z", "2026-09-15T00:00:00.000Z"),
    cycle("c2", "2026-10-01T00:00:00.000Z", "2026-10-15T00:00:00.000Z"),
    cycle("c3", "2026-10-15T00:00:00.000Z", "2026-10-29T00:00:00.000Z"),
    cycle("c5", "2026-11-12T00:00:00.000Z", "2026-11-26T00:00:00.000Z"),
    cycle("c4", "2026-10-29T00:00:00.000Z", "2026-11-12T00:00:00.000Z"),
    cycle("c9", "2026-10-15T00:00:00.000Z", "2026-10-29T00:00:00.000Z", "other"),
  ],
  views: [],
  allWorkspacesBotIds: [],
};

describe("relativeTimeLabel", () => {
  it("reads recent times relative to now", () => {
    expect(relativeTimeLabel("2026-10-24T11:59:30.000Z", NOW)).toBe("now");
    expect(relativeTimeLabel("2026-10-24T11:55:00.000Z", NOW)).toBe("5m ago");
    expect(relativeTimeLabel("2026-10-24T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(relativeTimeLabel("2026-10-19T12:00:00.000Z", NOW)).toBe("5d ago");
  });

  it("treats a time ahead of the clock as now", () => {
    expect(relativeTimeLabel("2026-10-24T12:05:00.000Z", NOW)).toBe("now");
  });

  it("shows the date past a month, with the year when it differs", () => {
    expect(relativeTimeLabel("2026-08-21T12:00:00.000Z", NOW)).toBe("Aug 21");
    expect(relativeTimeLabel("2025-08-21T12:00:00.000Z", NOW)).toBe("Aug 21, 2025");
  });
});

describe("minuteEpoch", () => {
  it("reads the minute clock as UTC, whatever the local time zone", () => {
    const minute = new Date(NOW + 5 * 60_000).toISOString().slice(0, 16);
    expect(minute).toBe("2026-10-24T12:05");
    expect(minuteEpoch(minute)).toBe(Date.UTC(2026, 9, 24, 12, 5));
    expect(relativeTimeLabel("2026-10-24T12:00:00.000Z", minuteEpoch(minute))).toBe("5m ago");
  });
});

describe("parsePullRequestUrl", () => {
  it("reads the repository and number of a GitHub pull request", () => {
    expect(parsePullRequestUrl("https://github.com/Moneria-Brasil/moneria-api/pull/191")).toEqual({
      repository: "Moneria-Brasil/moneria-api",
      number: 191,
    });
    expect(parsePullRequestUrl("https://github.com/o/r/pull/7/files#diff")).toEqual({
      repository: "o/r",
      number: 7,
    });
  });

  it("refuses other URLs", () => {
    expect(parsePullRequestUrl("https://github.com/o/r/issues/7")).toBeNull();
    expect(parsePullRequestUrl("https://gitlab.com/o/r/pull/7")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/o/r/pull/0")).toBeNull();
  });
});

describe("pickers", () => {
  it("assigns among the organization's active people, me first", () => {
    expect(
      assigneeOptions(snapshot, ticket(), buildKanbanLookups(snapshot, [], "Owner"), []).map(
        (option) => option.id,
      ),
    ).toEqual(["me-id", "ann", "zed"]);
    const assignedToGone = ticket({ assigneeId: "gone" });
    expect(
      assigneeOptions(snapshot, assignedToGone, buildKanbanLookups(snapshot, [], "Owner"), []).map(
        (o) => o.id,
      ),
    ).toContain("gone");
  });

  it("assigns a local ticket to the owner or a bot", () => {
    const bot = {
      id: BotId.make("b1"),
      name: "Ada",
      role: "",
      model: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      homeGeneration: 1,
      sectionId: null,
      position: 0,
      canManageBots: false,
      rotation: "daily" as const,
      createdAt: at,
      updatedAt: at,
      homeThreadId: ThreadId.make("t1"),
      memories: [],
    };
    const lookups = buildKanbanLookups(snapshot, [], "Owner");
    const localLookups = buildKanbanLookups(snapshot, [bot], lookups.ownerName);
    expect(
      assigneeOptions(snapshot, ticket({ linear: null }), localLookups, [bot]).map((option) => [
        option.id,
        option.name,
      ]),
    ).toEqual([
      ["owner", "Owner"],
      ["bot:b1", "Ada"],
    ]);
  });

  it("lists the team's current cycle first, then upcoming, then past newest first", () => {
    const options = cycleOptions(snapshot, "team", NOW);
    expect(options.map((option) => option.cycle.id)).toEqual(["c3", "c4", "c5", "c2", "c1"]);
    expect(options.filter((option) => option.current).map((option) => option.cycle.id)).toEqual([
      "c3",
    ]);
  });

  it("gives consecutive local labels different colors", () => {
    const first = nextLabelColor(snapshot.labels);
    const second = nextLabelColor([
      ...snapshot.labels,
      label("local-b", { workspaceId: LOCAL_KANBAN_WORKSPACE_ID, source: "local" }),
    ]);
    expect(first).not.toBe(second);
  });
});
