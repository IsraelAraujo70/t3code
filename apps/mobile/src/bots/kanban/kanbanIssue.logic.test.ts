import { KanbanTicketId, LinearAccountId, ProjectId, type KanbanTicket } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addPendingWrite,
  draftedLabelIds,
  reconcileLabelDraft,
  removePendingWrite,
  toggleDraftLabel,
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

describe("label draft", () => {
  const ticket = baseTicket(true);
  const withLabels = (labelIds: ReadonlyArray<string>) => ({ ...ticket, labelIds });

  it("sends every label tapped before the snapshot catches up", () => {
    const first = toggleDraftLabel(null, ticket, "a");
    expect(draftedLabelIds(first, ticket)).toEqual(["a"]);
    const second = toggleDraftLabel(first, ticket, "b");
    expect(draftedLabelIds(second, ticket)).toEqual(["a", "b"]);
  });

  it("keeps later taps while an earlier save shows up, then gives way to the snapshot", () => {
    const draft = toggleDraftLabel(toggleDraftLabel(null, ticket, "a"), ticket, "b");
    const echoedA = withLabels(["a"]);
    const afterA = reconcileLabelDraft(draft, echoedA);
    expect(draftedLabelIds(afterA, echoedA)).toEqual(["a", "b"]);
    expect(draftedLabelIds(toggleDraftLabel(afterA, echoedA, "c"), echoedA)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(reconcileLabelDraft(afterA, withLabels(["a", "b"]))).toBeNull();
  });

  it("lets a later edit from elsewhere show through once the save has landed", () => {
    const draft = toggleDraftLabel(null, ticket, "a");
    const landed = reconcileLabelDraft(draft, withLabels(["a"]));
    const removedElsewhere = withLabels([]);
    expect(
      draftedLabelIds(reconcileLabelDraft(landed, removedElsewhere), removedElsewhere),
    ).toEqual([]);
  });

  it("keeps a label off when the save that added it shows up after it was untapped", () => {
    const off = toggleDraftLabel(toggleDraftLabel(null, ticket, "a"), ticket, "a");
    expect(draftedLabelIds(off, ticket)).toEqual([]);
    const staleEcho = withLabels(["a"]);
    const reconciled = reconcileLabelDraft(off, staleEcho);
    expect(draftedLabelIds(reconciled, staleEcho)).toEqual([]);
    expect(reconcileLabelDraft(reconciled, withLabels([]))).toBeNull();
  });

  it("ignores another ticket's draft", () => {
    const other = { ...ticket, id: KanbanTicketId.make("t_other") };
    const draft = toggleDraftLabel(null, other, "a");
    expect(draftedLabelIds(draft, ticket)).toEqual([]);
    expect(reconcileLabelDraft(draft, ticket)).toBeNull();
    expect(draftedLabelIds(toggleDraftLabel(draft, ticket, "b"), ticket)).toEqual(["b"]);
  });
});

describe("pending writes", () => {
  it("keeps one write pending when another finishes", () => {
    const both = addPendingWrite(addPendingWrite(new Map(), "comment"), "priority");
    const afterPriority = removePendingWrite(both, "priority");
    expect(afterPriority.has("comment")).toBe(true);
    expect(afterPriority.has("priority")).toBe(false);
  });

  it("counts the same key in flight twice", () => {
    const twice = addPendingWrite(addPendingWrite(new Map(), "labels"), "labels");
    const once = removePendingWrite(twice, "labels");
    expect(once.has("labels")).toBe(true);
    expect(removePendingWrite(once, "labels").size).toBe(0);
  });
});
