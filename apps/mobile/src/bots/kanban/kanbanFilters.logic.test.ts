import {
  KANBAN_DEFAULT_VIEW_CONFIG,
  KanbanViewId,
  ProjectId,
  type KanbanView,
  type KanbanViewConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFilterOverlay,
  filterChipLabel,
  overlayValues,
  scopeViews,
  selectedView,
  toggleOverlayValue,
} from "./kanbanFilters.logic";

const mine: KanbanViewConfig = {
  ...KANBAN_DEFAULT_VIEW_CONFIG,
  filters: [
    { kind: "set", field: "assignee", op: "in", values: ["me"] },
    { kind: "set", field: "priority", op: "notIn", values: ["0"] },
    { kind: "text", field: "content", value: "login" },
  ],
};

describe("filter overlay", () => {
  it("shows the view's own values until the phone edits a field", () => {
    expect(overlayValues(mine, {}, "assignee")).toEqual(["me"]);
    expect(overlayValues(mine, {}, "priority")).toEqual([]);
    expect(overlayValues(mine, { assignee: [] }, "assignee")).toEqual([]);
  });

  it("leaves the view untouched without edits", () => {
    expect(applyFilterOverlay(mine, {})).toBe(mine);
  });

  it("replaces a touched field's 'is any of' clause and keeps everything else", () => {
    const next = applyFilterOverlay(mine, { assignee: ["me", "u-ana"], status: ["todo"] });
    expect(next.filters).toEqual([
      { kind: "set", field: "priority", op: "notIn", values: ["0"] },
      { kind: "text", field: "content", value: "login" },
      { kind: "set", field: "status", op: "in", values: ["todo"] },
      { kind: "set", field: "assignee", op: "in", values: ["me", "u-ana"] },
    ]);
    expect(next.completed).toBe(mine.completed);
  });

  it("drops the field's filter when every value is unticked", () => {
    const next = applyFilterOverlay(mine, toggleOverlayValue(mine, {}, "assignee", "me"));
    expect(next.filters.some((clause) => clause.field === "assignee")).toBe(false);
  });

  it("toggles from what the chip shows", () => {
    expect(toggleOverlayValue(mine, {}, "assignee", "u-ana")).toEqual({
      assignee: ["me", "u-ana"],
    });
    expect(toggleOverlayValue(mine, { assignee: ["u-ana"] }, "assignee", "u-ana")).toEqual({
      assignee: [],
    });
  });
});

describe("filterChipLabel", () => {
  const labelOf = (value: string) => (value === "me" ? "Me" : value);
  it("names one value and counts several", () => {
    expect(filterChipLabel("Assignee", [], labelOf)).toBe("Assignee");
    expect(filterChipLabel("Assignee", ["me"], labelOf)).toBe("Assignee: Me");
    expect(filterChipLabel("Assignee", ["me", "u-ana"], labelOf)).toBe("Assignee: 2");
  });
});

describe("views of a scope", () => {
  const view = (id: string, projectId: string | null): KanbanView => ({
    id: KanbanViewId.make(id),
    projectId: projectId === null ? null : ProjectId.make(projectId),
    name: id,
    icon: null,
    config: KANBAN_DEFAULT_VIEW_CONFIG,
    linearViewId: null,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
  });
  const views = [view("v_all", null), view("v_api", "api"), view("v_web", "web")];

  it("keeps views of every board plus the project's own", () => {
    expect(scopeViews(views, null).map((candidate) => candidate.id)).toEqual(["v_all"]);
    expect(scopeViews(views, ProjectId.make("api")).map((candidate) => candidate.id)).toEqual([
      "v_all",
      "v_api",
    ]);
  });

  it("falls back to the first view when the picked one left the scope", () => {
    const scoped = scopeViews(views, null);
    expect(selectedView(scoped, "v_api")?.id).toBe("v_all");
    expect(selectedView([], null)).toBeNull();
  });
});
