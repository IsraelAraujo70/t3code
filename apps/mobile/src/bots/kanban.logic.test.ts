import { buildBoard } from "@t3tools/client-runtime/kanban-board";
import {
  KanbanTicketId,
  LinearAccountId,
  ProjectId,
  ThreadId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type LinearWorkflowState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  moveTarget,
  parseTicketMenuChoice,
  shownColumnId,
  ticketMenuActions,
} from "./kanban.logic";

const LINKED = ProjectId.make("linked");
const LOCAL = ProjectId.make("local");
const ACCOUNT = LinearAccountId.make("la_1");
const at = "2026-10-26T10:00:00.000Z";

const state = (
  id: string,
  name: string,
  type: LinearWorkflowState["type"],
  position: number,
): LinearWorkflowState => ({ id, teamId: "back", name, type, position, color: "#999" });

const ticket = (id: string, projectId: ProjectId, status: KanbanTicketStatus): KanbanTicket => ({
  id: KanbanTicketId.make(id),
  projectId,
  linear:
    status.kind === "linear"
      ? { accountId: ACCOUNT, issueId: `i-${id}`, teamId: "back", url: "https://linear.app/x" }
      : null,
  identifier: id,
  title: id,
  status,
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

const issue = ticket("BACK-204", LINKED, { kind: "linear", stateId: "doing" });
const local = ticket("T-1", LOCAL, { kind: "local", state: "todo" });

const snapshot: KanbanSnapshot = {
  accounts: [],
  workspaces: [],
  links: [
    {
      projectId: LINKED,
      accountId: ACCOUNT,
      teamId: "back",
      teamKey: "BACK",
      teamName: "Back-end",
      linearProjectId: null,
      linearProjectName: null,
      lastSyncedAt: at,
      syncError: null,
      createdAt: at,
    },
  ],
  states: [
    state("todo", "A Fazer", "unstarted", 1),
    state("doing", "Em Progresso", "started", 2),
    state("review", "Em Revisão", "started", 3),
    state("cancel", "Cancelado", "canceled", 4),
  ],
  tickets: [issue, local],
  people: [],
  labels: [],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
};

const moveTitles = (actions: ReturnType<typeof ticketMenuActions>) =>
  actions.find((action) => action.id === "move")?.subactions?.map((action) => action.title);

describe("ticketMenuActions", () => {
  const linkedBoard = buildBoard(snapshot, {
    projectId: LINKED,
    workspaceId: null,
    accountId: null,
  });

  it("offers every other state of the ticket's team, and Linear instead of delete", () => {
    const actions = ticketMenuActions({
      snapshot,
      board: linkedBoard,
      ticket: issue,
      linkable: [],
      linked: [],
      canEdit: true,
    });
    expect(moveTitles(actions)).toEqual(["A Fazer", "Em Revisão", "Cancelado"]);
    expect(actions.map((action) => action.id)).toEqual(["move", "open-linear"]);
  });

  it("offers only the local columns a local ticket can take, plus thread links and delete", () => {
    const board = buildBoard(snapshot, { projectId: LOCAL, workspaceId: null, accountId: null });
    const actions = ticketMenuActions({
      snapshot,
      board,
      ticket: local,
      linkable: [{ id: ThreadId.make("thread-a"), title: "Thread A" }],
      linked: [{ id: ThreadId.make("thread-b"), title: "Thread B" }],
      canEdit: true,
    });
    expect(moveTitles(actions)).toEqual(["Backlog", "In progress", "In review", "Done"]);
    expect(actions.map((action) => action.id)).toEqual(["move", "link", "unlink", "delete"]);
  });

  it("lets a reader only open the issue", () => {
    const actions = ticketMenuActions({
      snapshot,
      board: linkedBoard,
      ticket: issue,
      linkable: [{ id: ThreadId.make("thread-a"), title: "Thread A" }],
      linked: [],
      canEdit: false,
    });
    expect(actions.map((action) => action.id)).toEqual(["open-linear"]);
  });
});

describe("menu choices", () => {
  it("round-trips through the menu ids", () => {
    expect(parseTicketMenuChoice("move:review")).toEqual({ kind: "move", columnId: "review" });
    expect(parseTicketMenuChoice("link:thread:project:1")).toEqual({
      kind: "link",
      threadId: "thread:project:1",
    });
    expect(parseTicketMenuChoice("move")).toBeNull();
    expect(parseTicketMenuChoice("other")).toBeNull();
  });

  it("maps a move to the column's state", () => {
    const board = buildBoard(snapshot, { projectId: LINKED, workspaceId: null, accountId: null });
    expect(moveTarget(snapshot, board, issue, "review")).toEqual({
      kind: "linear",
      stateId: "review",
    });
    expect(moveTarget(snapshot, board, issue, "missing")).toBeNull();
  });
});

describe("shownColumnId", () => {
  const board = buildBoard(snapshot, { projectId: LINKED, workspaceId: null, accountId: null });

  it("keeps the picked column, else opens the first one with tickets", () => {
    expect(shownColumnId(board, "review")).toBe("review");
    expect(shownColumnId(board, "gone")).toBe("doing");
    expect(shownColumnId(board, null)).toBe("doing");
  });
});
