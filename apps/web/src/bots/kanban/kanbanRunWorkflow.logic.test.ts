import type { KanbanGroup, KanbanViewResult } from "@t3tools/client-runtime/kanban-board";
import {
  KanbanTicketId,
  ProjectId,
  WorkflowDocRevision,
  WorkflowId,
  type KanbanTicket,
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowParamSpec,
  type WorkflowSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SELECTION,
  selectedTickets,
  selectionBlockReason,
  selectRange,
  ticketsRunCheck,
  ticketWorkflowOption,
  toggleTicket,
  visibleTickets,
  workflowModelLabels,
} from "./kanbanRunWorkflow.logic";

const at = "2026-11-01T00:00:00.000Z";
const API = ProjectId.make("api");
const ticket = (n: number, identifier = `BACK-${n}`, projectId = API): KanbanTicket => ({
  id: KanbanTicketId.make(`t${n}`),
  projectId,
  linear: null,
  identifier,
  title: `Ticket ${n}`,
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
  sortOrder: n,
  closedAt: null,
  autoClosed: false,
  threadIds: [],
  createdAt: at,
  updatedAt: at,
});
const tickets = Array.from({ length: 12 }, (_, index) => ticket(index + 1));
const ids = tickets.map((candidate) => candidate.id);
const group = (id: string, members: ReadonlyArray<KanbanTicket>): KanbanGroup => ({
  id,
  title: id,
  icon: { kind: "none" },
  tickets: members,
});

const workflowId = Schema.decodeSync(WorkflowId)("ticket-fleet");
const revision = Schema.decodeSync(WorkflowDocRevision)("a".repeat(40));
const ticketsSpec: WorkflowParamSpec = {
  type: "string[]",
  maxItems: 10,
  pattern: "[A-Z]+-\\d+",
};
const definition = (params: WorkflowDefinition["params"]): WorkflowDefinition => ({
  schema: "t3.workflow/v1",
  id: "ticket-fleet",
  title: "Ticket fleet",
  home: { project: "api" },
  params,
  triggers: { run: { kind: "manual" } },
  budget: { steps: 10, wall: "1h", tokens: 1000 },
  fatigue: { consecutiveFailures: 3 },
  models: { impl: { provider: "claude", model: "claude-opus-5-5", effort: "high" } },
  nodes: {},
  edges: [],
});
const summary: WorkflowSummary = {
  workflowId,
  title: "Ticket fleet",
  description: null,
  path: "ticket-fleet.yaml",
  valid: true,
  dirty: false,
  enabled: true,
  suspended: false,
  diagnostics: 0,
  triggers: [],
  headCommit: null,
  revision: null,
  updatedAt: null,
  lastRun: null,
  bot: { id: "b_1", name: "Moneria PM" },
};
const document = (overrides: Partial<WorkflowDocument> = {}): WorkflowDocument => ({
  workflowId,
  source: "",
  definition: definition({ tickets: ticketsSpec }),
  revision,
  headCommit: null,
  hash: null,
  valid: true,
  dirty: false,
  diagnostics: [],
  enabled: true,
  suspended: false,
  triggers: [],
  updatedBy: null,
  updatedAt: null,
  ...overrides,
});
const runnable = (doc = document()) => {
  const option = ticketWorkflowOption(summary, doc);
  if (option?.kind !== "runnable") throw new Error(`expected runnable, got ${option?.kind}`);
  return option;
};

describe("selection", () => {
  it("toggles cards and selects a shift-click range from the last card clicked", () => {
    const one = toggleTicket(EMPTY_SELECTION, ids[1]!);
    const range = selectRange(one, ids[4]!, ids);
    expect(range.ids).toEqual([ids[1], ids[2], ids[3], ids[4]]);
    expect(selectRange(range, ids[0]!, ids).ids).toEqual([ids[1], ids[2], ids[3], ids[4], ids[0]]);
    expect(toggleTicket(range, ids[2]!).ids).toEqual([ids[1], ids[3], ids[4]]);
    // No anchor yet: a shift-click selects just that card.
    expect(selectRange(EMPTY_SELECTION, ids[3]!, ids).ids).toEqual([ids[3]]);
  });

  it("keeps the selected cards on screen, in selection order, each once", () => {
    const view: KanbanViewResult = {
      teamId: null,
      columns: [group("todo", tickets.slice(0, 2)), group("done", tickets.slice(1, 4))],
      hiddenColumns: [],
      swimlanes: null,
      total: 4,
    };
    const onScreen = visibleTickets(view);
    expect(onScreen.map((candidate) => candidate.id)).toEqual(ids.slice(0, 4));
    const selection = { ids: [ids[3]!, ids[9]!, ids[0]!], anchor: ids[0]! };
    expect(selectedTickets(selection, onScreen).map((candidate) => candidate.id)).toEqual([
      ids[3],
      ids[0],
    ]);
  });
});

describe("workflows that take cards", () => {
  it("lists only workflows with a string[] tickets param, and says why one cannot run", () => {
    expect(ticketWorkflowOption(summary, null)?.kind).toBe("loading");
    expect(ticketWorkflowOption({ ...summary, valid: false }, null)).toBeNull();
    expect(ticketWorkflowOption(summary, document({ definition: definition({}) }))).toBeNull();
    expect(
      ticketWorkflowOption(
        summary,
        document({ definition: definition({ tickets: { type: "string" } }) }),
      ),
    ).toBeNull();
    expect(ticketWorkflowOption(summary, document({ enabled: false }))).toMatchObject({
      kind: "unavailable",
      reason: "Turned off. Turn it on in Workflows.",
    });
    expect(ticketWorkflowOption(summary, document({ suspended: true }))?.kind).toBe("unavailable");
    const noManual = { ...definition({ tickets: ticketsSpec }), triggers: {} };
    expect(ticketWorkflowOption(summary, document({ definition: noManual }))).toMatchObject({
      kind: "unavailable",
      reason: "Has no manual trigger.",
    });
  });

  it("caps the limit at 10 whatever maxItems says", () => {
    expect(runnable().limit).toBe(10);
    const wide = { ...ticketsSpec, maxItems: 50 };
    expect(runnable(document({ definition: definition({ tickets: wide }) })).limit).toBe(10);
    const unbounded = { type: "string[]" } as const;
    expect(runnable(document({ definition: definition({ tickets: unbounded }) })).limit).toBe(10);
  });
});

describe("run params", () => {
  it("three selected cards become one run with their three identifiers", () => {
    let selection = EMPTY_SELECTION;
    for (const id of [ids[0]!, ids[4]!, ids[2]!]) selection = toggleTicket(selection, id);
    expect(ticketsRunCheck(runnable(), selectedTickets(selection, tickets))).toEqual({
      ok: true,
      params: { tickets: ["BACK-1", "BACK-5", "BACK-3"] },
    });
  });

  it("refuses more cards than the limit and never cuts the selection", () => {
    expect(selectionBlockReason(10)).toBeNull();
    expect(selectionBlockReason(11)).toBe("A run takes at most 10 cards; 11 are selected.");
    expect(ticketsRunCheck(runnable(), tickets.slice(0, 11))).toEqual({
      ok: false,
      reason: "Ticket fleet takes at most 10 cards; 11 are selected.",
    });
    const five = { ...ticketsSpec, maxItems: 5 };
    expect(
      ticketsRunCheck(
        runnable(document({ definition: definition({ tickets: five }) })),
        tickets.slice(0, 6),
      ),
    ).toEqual({ ok: false, reason: "Ticket fleet takes at most 5 cards; 6 are selected." });
    expect(ticketsRunCheck(runnable(), [])).toMatchObject({ ok: false });
  });

  it("refuses identifiers the pattern rejects and the same identifier from two projects", () => {
    expect(ticketsRunCheck(runnable(), [ticket(1), ticket(2, "local_2")])).toEqual({
      ok: false,
      reason: '"local_2" doesn\'t match [A-Z]+-\\d+.',
    });
    const twin = { ...ticket(9, "T-7", ProjectId.make("web")) };
    expect(ticketsRunCheck(runnable(), [ticket(8, "T-7"), twin])).toMatchObject({ ok: false });
  });

  it("names the workflow's models for the preview", () => {
    expect(workflowModelLabels(runnable().definition)).toEqual(["claude-opus-5-5 (high)"]);
  });
});
