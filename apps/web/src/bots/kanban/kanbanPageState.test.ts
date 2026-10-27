import {
  KANBAN_DEFAULT_VIEW_CONFIG,
  KanbanTicketId,
  KanbanViewId,
  ProjectId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanView,
  type KanbanViewConfig,
} from "@t3tools/contracts";
import type { KanbanGroup } from "@t3tools/client-runtime/kanban-board";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingDrops,
  cellDropActions,
  draftOf,
  effectiveConfig,
  findIssue,
  hasKanbanSearch,
  importSummary,
  isDirty,
  parseKanbanSearch,
  pickActiveView,
  reorderedViewIds,
  renameViewInput,
  saveAsInput,
  saveViewInput,
  viewsForScope,
  withColumnShown,
  withDraft,
  withIssue,
  withoutDraft,
  withoutSavedDraft,
  type KanbanDrafts,
} from "./kanbanPageState";

const API = ProjectId.make("api");
const WEB = ProjectId.make("web");

const view = (id: string, projectId: ProjectId | null, config = KANBAN_DEFAULT_VIEW_CONFIG) =>
  ({
    id: KanbanViewId.make(id),
    projectId,
    name: `View ${id}`,
    icon: "Zap",
    config,
    linearViewId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }) satisfies KanbanView;

const everywhere = view("all", null);
const apiOnly = view("api_mine", API);
const webOnly = view("web_mine", WEB);
const views = [everywhere, apiOnly, webOnly];
const listConfig: KanbanViewConfig = { ...KANBAN_DEFAULT_VIEW_CONFIG, layout: "list" };

describe("kanban URL", () => {
  it("keeps valid params and drops the rest", () => {
    expect(
      parseKanbanSearch({ project: "api", view: "api_mine", issue: "back-169", full: 1 }),
    ).toEqual({ project: API, view: "api_mine", issue: "BACK-169", full: 1 });
    expect(parseKanbanSearch({ view: "bad id!", issue: "", full: "1", project: 3 })).toEqual({});
    expect(parseKanbanSearch({ issue: "BACK-1", full: "1" })).toEqual({
      issue: "BACK-1",
      full: 1,
    });
    expect(parseKanbanSearch({ issue: "BACK-1", issueProject: "api" })).toEqual({
      issue: "BACK-1",
      issueProject: API,
    });
    expect(parseKanbanSearch({ issueProject: "api" })).toEqual({});
  });

  it("tells a bare visit from one that says something", () => {
    expect(hasKanbanSearch(parseKanbanSearch({}))).toBe(false);
    expect(hasKanbanSearch(parseKanbanSearch({ view: "all" }))).toBe(true);
  });
});

describe("views of a scope", () => {
  it("shows every-board views plus the project's, in server order", () => {
    expect(viewsForScope(views, API).map((v) => v.id)).toEqual(["all", "api_mine"]);
    expect(viewsForScope(views, null).map((v) => v.id)).toEqual(["all"]);
  });

  it("picks the URL's view, then the remembered one, then the first", () => {
    const shown = viewsForScope(views, API);
    expect(pickActiveView(shown, "api_mine", "all")?.id).toBe("api_mine");
    expect(pickActiveView(shown, "web_mine", "api_mine")?.id).toBe("api_mine");
    expect(pickActiveView(shown, undefined, "gone")?.id).toBe("all");
    expect(pickActiveView([], "all", "all")).toBeNull();
  });

  it("reorders the scope's tabs and leaves other projects' views in their slots", () => {
    expect(reorderedViewIds(views, [apiOnly.id, everywhere.id])).toEqual([
      "api_mine",
      "all",
      "web_mine",
    ]);
  });
});

describe("drafts", () => {
  it("is dirty while a draft differs and clean once it returns to the saved config", () => {
    let drafts: KanbanDrafts = new Map();
    expect(isDirty(apiOnly, drafts)).toBe(false);
    drafts = withDraft(drafts, apiOnly, listConfig);
    expect(isDirty(apiOnly, drafts)).toBe(true);
    expect(draftOf(apiOnly, drafts).layout).toBe("list");
    expect(isDirty(everywhere, drafts)).toBe(false);
    drafts = withDraft(drafts, apiOnly, KANBAN_DEFAULT_VIEW_CONFIG);
    expect(drafts.size).toBe(0);
    drafts = withoutDraft(withDraft(drafts, apiOnly, listConfig), apiOnly.id);
    expect(isDirty(apiOnly, drafts)).toBe(false);
  });

  it("keeps edits made while a save was running", () => {
    const saved = withDraft(new Map(), apiOnly, listConfig);
    expect(withoutSavedDraft(saved, apiOnly.id, listConfig).size).toBe(0);
    const editedMeanwhile = withDraft(saved, apiOnly, { ...listConfig, showSubIssues: false });
    expect(draftOf(apiOnly, withoutSavedDraft(editedMeanwhile, apiOnly.id, listConfig))).toEqual({
      ...listConfig,
      showSubIssues: false,
    });
  });

  it("shows a hidden column again, turning empty columns on when it was folded for being empty", () => {
    const hidden = { ...KANBAN_DEFAULT_VIEW_CONFIG, hiddenColumns: ["todo", "done"] };
    expect(withColumnShown(hidden, group("todo", [localTicket]))).toEqual({
      ...hidden,
      hiddenColumns: ["done"],
    });
    const shown = withColumnShown(KANBAN_DEFAULT_VIEW_CONFIG, group("backlog"));
    expect(shown.showEmptyColumns).toBe(true);
  });

  it("adds the search box as a content clause the saved view never gets", () => {
    const draft = { ...KANBAN_DEFAULT_VIEW_CONFIG, layout: "list" as const };
    const effective = effectiveConfig(draft, "  pix ");
    expect(effective.filters).toEqual([{ kind: "text", field: "content", value: "pix" }]);
    expect(effectiveConfig(draft, "   ")).toBe(draft);
    expect(saveViewInput(apiOnly, draft).config.filters).toEqual([]);
  });
});

describe("save payloads", () => {
  it("saves over a view keeping its scope, name and icon", () => {
    expect(saveViewInput(apiOnly, listConfig)).toEqual({
      id: apiOnly.id,
      projectId: API,
      name: "View api_mine",
      icon: "Zap",
      config: listConfig,
    });
  });

  it("saves a new view on every board or only on the scope's project", () => {
    expect(saveAsInput("Mine", true, API, listConfig)).toEqual({
      projectId: null,
      name: "Mine",
      icon: null,
      config: listConfig,
    });
    expect(saveAsInput("Mine", false, API, listConfig).projectId).toBe(API);
  });

  it("renames with the saved config, not the draft", () => {
    expect(renameViewInput(apiOnly, "Renamed")).toEqual({
      ...saveViewInput(apiOnly, apiOnly.config),
      name: "Renamed",
    });
  });

  it("summarizes an import with the skipped views' reasons", () => {
    expect(importSummary({ imported: [apiOnly, webOnly], skipped: [] })).toEqual({
      title: "Imported 2 views",
      description: null,
    });
    expect(
      importSummary({
        imported: [apiOnly],
        skipped: [{ name: "Triage", reason: "already imported" }],
      }),
    ).toEqual({ title: "Imported 1 view, skipped 1", description: "Triage: already imported" });
  });
});

describe("open issue", () => {
  it("finds the identifier in the scope first, then anywhere", () => {
    const tickets = [
      { id: "a", identifier: "T-1", projectId: WEB },
      { id: "b", identifier: "T-1", projectId: API },
      { id: "c", identifier: "BACK-169", projectId: WEB },
    ];
    const find = (scope: ProjectId | null, identifier: string) =>
      findIssue(tickets, scope, identifier)?.id ?? null;
    expect(find(API, "T-1")).toBe("b");
    expect(find(API, "BACK-169")).toBe("c");
    expect(find(null, "T-1")).toBe("a");
    expect(find(API, "NOPE-1")).toBeNull();
    expect(findIssue(tickets, null, "T-1", API)?.id).toBe("b");
  });

  it("names the project in the URL only when the identifier alone opens another ticket", () => {
    const inWeb = { id: KanbanTicketId.make("a"), identifier: "T-1", projectId: WEB };
    const inApi = { id: KanbanTicketId.make("b"), identifier: "T-1", projectId: API };
    const unique = { id: KanbanTicketId.make("c"), identifier: "BACK-169", projectId: WEB };
    const tickets = [inWeb, inApi, unique];
    expect(withIssue({ view: everywhere.id, full: 1 }, tickets, null, unique)).toEqual({
      view: everywhere.id,
      issue: "BACK-169",
      full: 1,
    });
    expect(withIssue({}, tickets, null, inWeb)).toEqual({ issue: "T-1" });
    const ambiguous = withIssue({ issueProject: WEB }, tickets, null, inApi);
    expect(ambiguous).toEqual({ issue: "T-1", issueProject: API });
    expect(findIssue(tickets, null, "T-1", ambiguous.issueProject)).toBe(inApi);
    expect(withIssue({ project: API }, tickets, API, inApi)).toEqual({
      project: API,
      issue: "T-1",
    });
  });
});

const at = "2026-10-01T00:00:00.000Z";
const localTicket: KanbanTicket = {
  id: KanbanTicketId.make("t1"),
  projectId: API,
  linear: null,
  identifier: "T-1",
  title: "Work",
  status: { kind: "local", state: "todo" },
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
};
const board: KanbanSnapshot = {
  accounts: [],
  workspaces: [],
  links: [],
  states: [],
  tickets: [localTicket],
  people: [],
  labels: [],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
};
const group = (id: string, tickets: ReadonlyArray<KanbanTicket> = []): KanbanGroup => ({
  id,
  title: id,
  icon: { kind: "none" },
  tickets,
});

describe("board drops", () => {
  it("moves by column and updates by lane, merging two updates into one", () => {
    const statusByAssignee = { groupBy: "status", subGroupBy: "assignee" } as const;
    expect(
      cellDropActions(board, localTicket, statusByAssignee, group("done"), group("owner")),
    ).toEqual([
      { kind: "move", to: { kind: "local", state: "done" } },
      { kind: "update", patch: { assigneeId: "owner" } },
    ]);
    const priorityByAssignee = { groupBy: "priority", subGroupBy: "assignee" } as const;
    expect(
      cellDropActions(board, localTicket, priorityByAssignee, group("1"), group("owner")),
    ).toEqual([{ kind: "update", patch: { priority: 1, assigneeId: "owner" } }]);
    expect(
      cellDropActions(
        board,
        localTicket,
        statusByAssignee,
        group("todo", [localTicket]),
        group("none", [localTicket]),
      ),
    ).toEqual([]);
  });

  it("refuses the whole drop when the lane cannot take the ticket", () => {
    const statusByAssignee = { groupBy: "status", subGroupBy: "assignee" } as const;
    expect(
      cellDropActions(board, localTicket, statusByAssignee, group("done"), group("someone-else")),
    ).toEqual([]);
    expect(
      cellDropActions(
        board,
        localTicket,
        statusByAssignee,
        group("done"),
        group("none", [localTicket]),
      ),
    ).toEqual([{ kind: "move", to: { kind: "local", state: "done" } }]);
  });

  it("moves within a thread status lane and refuses changing the thread status", () => {
    const statusByThread = { groupBy: "status", subGroupBy: "threadStatus" } as const;
    expect(
      cellDropActions(
        board,
        localTicket,
        statusByThread,
        group("done"),
        group("none", [localTicket]),
      ),
    ).toEqual([{ kind: "move", to: { kind: "local", state: "done" } }]);
    expect(
      cellDropActions(board, localTicket, statusByThread, group("done"), group("working")),
    ).toEqual([]);
    const threadByAssignee = { groupBy: "threadStatus", subGroupBy: "assignee" } as const;
    expect(
      cellDropActions(board, localTicket, threadByAssignee, group("approval"), group("owner")),
    ).toEqual([]);
    expect(
      cellDropActions(
        board,
        localTicket,
        threadByAssignee,
        group("none", [localTicket]),
        group("owner"),
      ),
    ).toEqual([{ kind: "update", patch: { assigneeId: "owner" } }]);
  });

  it("shows pending drops on the snapshot until they settle", () => {
    const shown = applyPendingDrops(
      board,
      new Map([
        [
          localTicket.id,
          [
            { kind: "move", to: { kind: "local", state: "done" } },
            { kind: "update", patch: { priority: 2 } },
          ],
        ],
      ]),
    );
    expect(shown.tickets[0]).toMatchObject({
      status: { kind: "local", state: "done" },
      priority: 2,
    });
    expect(applyPendingDrops(board, new Map())).toBe(board);
  });
});
