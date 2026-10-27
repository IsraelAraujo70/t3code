import {
  KanbanTicketId,
  LinearAccountId,
  ProjectId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type LinearWorkflowState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBoard, dropTarget, filterTickets } from "./kanbanBoard.ts";

const LINKED = ProjectId.make("linked");
const LOCAL = ProjectId.make("local");
const ACCOUNT = LinearAccountId.make("la_1");
const at = "2026-10-24T10:00:00.000Z";

const state = (
  id: string,
  teamId: string,
  name: string,
  type: LinearWorkflowState["type"],
  position: number,
): LinearWorkflowState => ({ id, teamId, name, type, position, color: "#999" });

// Moneria's real Back-end workflow, in Linear's (unsorted) order.
const states = [
  state("cancel", "back", "Cancelado", "canceled", 4),
  state("doing", "back", "Em Progresso", "started", 2),
  state("backlog", "back", "Backlog", "backlog", 0),
  state("done", "back", "Concluído", "completed", 3),
  state("todo", "back", "A Fazer", "unstarted", 1),
  state("review", "back", "Em Revisão", "started", 1002),
  state("f-todo", "front", "Todo", "unstarted", 1),
];

let ticketCount = 0;
const ticket = (
  projectId: ProjectId,
  status: KanbanTicketStatus,
  teamId = "back",
): KanbanTicket => {
  ticketCount += 1;
  return {
    id: KanbanTicketId.make(`t_${ticketCount}`),
    projectId,
    linear:
      status.kind === "linear"
        ? { accountId: ACCOUNT, issueId: `i${ticketCount}`, teamId, url: "https://linear.app/x" }
        : null,
    identifier: `X-${ticketCount}`,
    title: `Ticket ${ticketCount}`,
    status,
    assigneeName: null,
    priority: 0,
    threadIds: [],
    createdAt: at,
    updatedAt: at,
  };
};

const doing = ticket(LINKED, { kind: "linear", stateId: "doing" });
const inReview = ticket(LINKED, { kind: "linear", stateId: "review" });
const canceled = ticket(LINKED, { kind: "linear", stateId: "cancel" });
const oldLocal = ticket(LINKED, { kind: "local", state: "in_progress" });
const local = ticket(LOCAL, { kind: "local", state: "todo" });

const snapshot: KanbanSnapshot = {
  accounts: [
    {
      id: ACCOUNT,
      name: "Moneria",
      keyLast4: "abcd",
      userName: "Israel",
      organizationId: "org-moneria",
      organizationName: "Moneria",
      organizationUrlKey: "moneria",
      createdAt: at,
      updatedAt: at,
    },
  ],
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
  states,
  tickets: [doing, inReview, canceled, oldLocal, local],
};

const all = { projectId: null, workspaceId: null, accountId: null };
const ids = (tickets: ReadonlyArray<KanbanTicket>) => tickets.map((t) => t.id);

describe("buildBoard", () => {
  it("follows the linked team's workflow, in Linear's category order", () => {
    const board = buildBoard(snapshot, { ...all, projectId: LINKED });
    expect(board.teamId).toBe("back");
    expect(board.columns.map((column) => column.title)).toEqual([
      "Backlog",
      "A Fazer",
      "Em Progresso",
      "Em Revisão",
      "Concluído",
      "Cancelado",
    ]);
    const byTitle = new Map(board.columns.map((column) => [column.title, ids(column.tickets)]));
    // A local ticket from before the link sits in the first state of its category.
    expect(byTitle.get("Em Progresso")).toEqual(ids([doing, oldLocal]));
    expect(byTitle.get("Em Revisão")).toEqual(ids([inReview]));
    expect(byTitle.get("Cancelado")).toEqual(ids([canceled]));
  });

  it("folds Linear states into the local columns on a mixed board and hides canceled", () => {
    const board = buildBoard(snapshot, all);
    expect(board.teamId).toBeNull();
    const byState = new Map(board.columns.map((column) => [column.id, ids(column.tickets)]));
    expect(byState.get("todo")).toEqual(ids([local]));
    expect(byState.get("in_progress")).toEqual(ids([doing, oldLocal]));
    expect(byState.get("in_review")).toEqual(ids([inReview]));
    expect(board.columns.flatMap((column) => ids(column.tickets))).not.toContain(canceled.id);
  });

  it("filters by workspace and account", () => {
    expect(ids(filterTickets(snapshot, { ...all, workspaceId: "local" as never }))).toEqual(
      ids([oldLocal, local]),
    );
    expect(ids(filterTickets(snapshot, { ...all, accountId: ACCOUNT }))).toEqual(
      ids([doing, inReview, canceled]),
    );
  });
});

describe("dropTarget", () => {
  const linkedBoard = buildBoard(snapshot, { ...all, projectId: LINKED });
  const mixedBoard = buildBoard(snapshot, all);
  const column = (board: typeof linkedBoard, id: string) =>
    board.columns.find((candidate) => candidate.id === id)!;

  it("moves a Linear ticket to the dropped state of its own team", () => {
    expect(dropTarget(snapshot, doing, column(linkedBoard, "done"))).toEqual({
      kind: "linear",
      stateId: "done",
    });
  });

  it("maps a mixed-board column to the first state of that category in the ticket's team", () => {
    expect(dropTarget(snapshot, doing, column(mixedBoard, "in_review"))).toEqual({
      kind: "linear",
      stateId: "review",
    });
    expect(dropTarget(snapshot, inReview, column(mixedBoard, "in_progress"))).toEqual({
      kind: "linear",
      stateId: "doing",
    });
    const frontTicket = ticket(LINKED, { kind: "linear", stateId: "f-todo" }, "front");
    expect(dropTarget(snapshot, frontTicket, column(mixedBoard, "done"))).toBeNull();
  });

  it("gives a local ticket the category of the column it lands in", () => {
    expect(dropTarget(snapshot, oldLocal, column(linkedBoard, "review"))).toEqual({
      kind: "local",
      state: "in_review",
    });
    expect(dropTarget(snapshot, oldLocal, column(linkedBoard, "cancel"))).toBeNull();
  });
});
