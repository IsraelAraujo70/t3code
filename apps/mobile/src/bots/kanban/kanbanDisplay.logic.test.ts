import type { KanbanPullRequestRef, KanbanSnapshot, LinearWorkflowState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildKanbanLookups,
  dueDatePresets,
  formatDueDate,
  formatKanbanDate,
  isOverdue,
  personDisplay,
  personInitials,
  priorityGlyph,
  pullRequestBadge,
  statusDisplay,
  statusGlyph,
} from "./kanbanDisplay.logic";

const state = (id: string, type: LinearWorkflowState["type"], position: number) => ({
  id,
  teamId: "back",
  name: id,
  type,
  position,
  color: "#f2c94c",
});

const snapshot: KanbanSnapshot = {
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
const lookups = buildKanbanLookups(snapshot, [], "Israel");

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
    expect(formatDueDate("2026-10-26", now)).toBe("Oct 26");
    expect(formatDueDate("2026-99-99", now)).toBe("2026-99-99");
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
