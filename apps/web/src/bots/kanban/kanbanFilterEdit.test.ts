import { isoDay } from "@t3tools/client-runtime/kanban-display";
import {
  KANBAN_DEFAULT_VIEW_CONFIG,
  KANBAN_LIMITS,
  type KanbanFilterClause,
  type KanbanViewConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  configEquals,
  datePresets,
  mergeClauses,
  removeClause,
  setClauseOp,
  setDateClause,
  setDateClauseAt,
  setFlag,
  setText,
  toggleClauseValue,
  toggleSetValue,
} from "./kanbanFilterEdit";

const assigneeMe: KanbanFilterClause = { kind: "set", field: "assignee", op: "in", values: ["me"] };
const urgent: KanbanFilterClause = { kind: "set", field: "priority", op: "in", values: ["1"] };

describe("toggleSetValue", () => {
  it("creates an `in` clause for a field without one", () => {
    expect(toggleSetValue([urgent], "assignee", "me")).toEqual([urgent, assigneeMe]);
  });

  it("adds and removes values in the field's existing clause, keeping its op", () => {
    const notMe: KanbanFilterClause = { ...assigneeMe, op: "notIn" };
    const both = toggleSetValue([notMe], "assignee", "none");
    expect(both).toEqual([{ ...notMe, values: ["me", "none"] }]);
    expect(toggleSetValue(both, "assignee", "me")).toEqual([{ ...notMe, values: ["none"] }]);
  });

  it("drops the clause when its last value is removed", () => {
    expect(toggleSetValue([assigneeMe, urgent], "assignee", "me")).toEqual([urgent]);
  });

  it("stops adding clauses at the view's clause limit", () => {
    const full = Array.from({ length: KANBAN_LIMITS.filterClauses }, () => urgent);
    expect(toggleSetValue(full, "assignee", "me")).toHaveLength(KANBAN_LIMITS.filterClauses);
  });
});

describe("toggleClauseValue", () => {
  it("edits the clause at the index, not the field's first", () => {
    const second: KanbanFilterClause = { ...assigneeMe, op: "notIn", values: ["owner"] };
    expect(toggleClauseValue([assigneeMe, second], 1, "none")).toEqual([
      assigneeMe,
      { ...second, values: ["owner", "none"] },
    ]);
  });
});

describe("setClauseOp", () => {
  it("switches a set clause between is and is not and ignores other kinds", () => {
    const flag: KanbanFilterClause = { kind: "flag", field: "hasThreads", value: true };
    expect(setClauseOp([assigneeMe, flag], 0, "notIn")[0]).toEqual({ ...assigneeMe, op: "notIn" });
    expect(setClauseOp([assigneeMe, flag], 1, "notIn")[1]).toBe(flag);
  });
});

describe("removeClause", () => {
  it("removes only the clause at the index", () => {
    expect(removeClause([assigneeMe, urgent], 0)).toEqual([urgent]);
  });
});

describe("setDateClause", () => {
  it("keeps one condition per date field", () => {
    const week = setDateClause([], "createdAt", "pastDays", 7);
    const before = setDateClause(week, "createdAt", "before", "2026-10-01");
    expect(before).toEqual([
      { kind: "date", field: "createdAt", op: "before", value: "2026-10-01" },
    ]);
    expect(setDateClause(before, "dueDate", "isEmpty", "ignored")).toEqual([
      ...before,
      { kind: "date", field: "dueDate", op: "isEmpty", value: null },
    ]);
  });
});

describe("setDateClauseAt", () => {
  it("edits the date clause at the index, not the field's first", () => {
    const after: KanbanFilterClause = {
      kind: "date",
      field: "createdAt",
      op: "after",
      value: "2026-10-01",
    };
    const before: KanbanFilterClause = { ...after, op: "before", value: "2026-10-20" };
    expect(setDateClauseAt([after, before], 1, "before", "2026-10-25")).toEqual([
      after,
      { ...before, value: "2026-10-25" },
    ]);
    expect(setDateClauseAt([after, before], 0, "isSet", "ignored")).toEqual([
      { ...after, op: "isSet", value: null },
      before,
    ]);
  });
});

describe("setFlag", () => {
  it("replaces the flag's value instead of adding a second clause", () => {
    const yes = setFlag([], "isSubIssue", true);
    expect(setFlag(yes, "isSubIssue", false)).toEqual([
      { kind: "flag", field: "isSubIssue", value: false },
    ]);
  });
});

describe("setText", () => {
  it("sets trimmed content and removes it when blank", () => {
    const text = setText([urgent], "  login bug ");
    expect(text).toEqual([urgent, { kind: "text", field: "content", value: "login bug" }]);
    expect(setText(text, "   ")).toEqual([urgent]);
  });
});

describe("mergeClauses", () => {
  it("joins set values with the same field and op, and replaces other kinds", () => {
    const current = [assigneeMe, setFlag([], "hasThreads", true)[0]!];
    const merged = mergeClauses(current, [
      { kind: "set", field: "assignee", op: "in", values: ["me", "owner"] },
      { kind: "set", field: "assignee", op: "notIn", values: ["none"] },
      { kind: "flag", field: "hasThreads", value: false },
    ]);
    expect(merged).toEqual([
      { ...assigneeMe, values: ["me", "owner"] },
      { kind: "flag", field: "hasThreads", value: false },
      { kind: "set", field: "assignee", op: "notIn", values: ["none"] },
    ]);
  });

  it("keeps both bounds of a date range and replaces only the same field and op", () => {
    const after: KanbanFilterClause = {
      kind: "date",
      field: "createdAt",
      op: "after",
      value: "2026-10-01",
    };
    const before: KanbanFilterClause = { ...after, op: "before", value: "2026-10-20" };
    const range = mergeClauses([after], [before]);
    expect(range).toEqual([after, before]);
    expect(mergeClauses(range, [{ ...after, value: "2026-10-05" }])).toEqual([
      { ...after, value: "2026-10-05" },
      before,
    ]);
  });
});

describe("configEquals", () => {
  const config: KanbanViewConfig = {
    ...KANBAN_DEFAULT_VIEW_CONFIG,
    filters: [{ kind: "set", field: "priority", op: "in", values: ["1", "2"] }, assigneeMe],
  };

  it("ignores the order of clauses, values and properties", () => {
    expect(
      configEquals(config, {
        ...config,
        filters: [assigneeMe, { kind: "set", field: "priority", op: "in", values: ["2", "1"] }],
        properties: [...config.properties].reverse(),
      }),
    ).toBe(true);
  });

  it("sees a changed op, value, display setting or property", () => {
    expect(configEquals(config, { ...config, filters: [assigneeMe] })).toBe(false);
    expect(
      configEquals(config, {
        ...config,
        filters: [config.filters[0]!, { ...assigneeMe, op: "notIn" }],
      }),
    ).toBe(false);
    expect(configEquals(config, { ...config, layout: "list" })).toBe(false);
    expect(configEquals(config, { ...config, properties: config.properties.slice(1) })).toBe(false);
  });

  it("tells a numeric day count from the same text", () => {
    const days = setDateClause([], "updatedAt", "pastDays", 7);
    const text = setDateClause([], "updatedAt", "pastDays", "7");
    expect(configEquals({ ...config, filters: days }, { ...config, filters: text })).toBe(false);
  });
});

describe("datePresets", () => {
  it("offers future ranges only for the due date", () => {
    expect(datePresets("createdAt").every((preset) => preset.op === "pastDays")).toBe(true);
    expect(datePresets("dueDate").some((preset) => preset.op === "nextDays")).toBe(true);
  });
});

describe("isoDay", () => {
  it("formats the local calendar day", () => {
    expect(isoDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
