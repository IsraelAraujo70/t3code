/**
 * Pure edits the kanban filter bar, display menu and view tabs make to a view's filters and
 * config. Every function returns a new array and leaves its input alone.
 */
import {
  KANBAN_LIMITS,
  type KanbanDateFilterField,
  type KanbanFilterClause,
  type KanbanFlagFilterField,
  type KanbanSetFilterField,
  type KanbanViewConfig,
} from "@t3tools/contracts";

type Filters = ReadonlyArray<KanbanFilterClause>;
type SetClause = Extract<KanbanFilterClause, { kind: "set" }>;
type DateClause = Extract<KanbanFilterClause, { kind: "date" }>;
export type KanbanSetOp = SetClause["op"];
export type KanbanDateOp = DateClause["op"];

const TEXT_LIMIT = 200;

const append = (filters: Filters, clause: KanbanFilterClause): KanbanFilterClause[] =>
  filters.length >= KANBAN_LIMITS.filterClauses ? [...filters] : [...filters, clause];

/** Replaces the field's first clause of that kind, or appends one. */
const upsert = (
  filters: Filters,
  kind: KanbanFilterClause["kind"],
  field: KanbanFilterClause["field"],
  clause: KanbanFilterClause,
): KanbanFilterClause[] => {
  const index = filters.findIndex((current) => current.kind === kind && current.field === field);
  return index === -1 ? append(filters, clause) : replaceClause(filters, index, clause);
};

export function replaceClause(
  filters: Filters,
  index: number,
  clause: KanbanFilterClause,
): KanbanFilterClause[] {
  return filters.map((current, at) => (at === index ? clause : current));
}

export function removeClause(filters: Filters, index: number): KanbanFilterClause[] {
  return filters.filter((_, at) => at !== index);
}

/** The values the field's first set clause holds (what the value menu checks). */
export function selectedSetValues(filters: Filters, field: KanbanSetFilterField): Set<string> {
  const clause = filters.find((current) => current.kind === "set" && current.field === field);
  return new Set(clause?.kind === "set" ? clause.values : []);
}

/** Toggles a value of the set clause at `index`; removing its last value drops the clause. */
export function toggleClauseValue(
  filters: Filters,
  index: number,
  value: string,
): KanbanFilterClause[] {
  const clause = filters[index];
  if (clause?.kind !== "set") return [...filters];
  if (clause.values.includes(value)) {
    const values = clause.values.filter((current) => current !== value);
    return values.length === 0
      ? removeClause(filters, index)
      : replaceClause(filters, index, { ...clause, values });
  }
  if (clause.values.length >= KANBAN_LIMITS.filterValues) return [...filters];
  return replaceClause(filters, index, { ...clause, values: [...clause.values, value] });
}

/** Toggles a value in the field's first set clause, creating an `in` clause when there is none. */
export function toggleSetValue(
  filters: Filters,
  field: KanbanSetFilterField,
  value: string,
): KanbanFilterClause[] {
  const index = filters.findIndex((clause) => clause.kind === "set" && clause.field === field);
  return index === -1
    ? append(filters, { kind: "set", field, op: "in", values: [value] })
    : toggleClauseValue(filters, index, value);
}

/** Sets is / is not on the set clause at `index`; other kinds are left as they are. */
export function setClauseOp(
  filters: Filters,
  index: number,
  op: KanbanSetOp,
): KanbanFilterClause[] {
  const clause = filters[index];
  return clause?.kind === "set" ? replaceClause(filters, index, { ...clause, op }) : [...filters];
}

/** One date condition per field: replaces the field's date clause, or adds it. */
export function setDateClause(
  filters: Filters,
  field: KanbanDateFilterField,
  op: KanbanDateOp,
  value: string | number | null,
): KanbanFilterClause[] {
  const clause: DateClause = {
    kind: "date",
    field,
    op,
    value: op === "isSet" || op === "isEmpty" ? null : value,
  };
  return upsert(filters, "date", field, clause);
}

export function setFlag(
  filters: Filters,
  field: KanbanFlagFilterField,
  value: boolean,
): KanbanFilterClause[] {
  return upsert(filters, "flag", field, { kind: "flag", field, value });
}

/** The content clause; empty (or blank) text removes it. */
export function setText(filters: Filters, text: string): KanbanFilterClause[] {
  const value = text.trim().slice(0, TEXT_LIMIT);
  if (value === "") return filters.filter((clause) => clause.kind !== "text");
  return upsert(filters, "text", "content", { kind: "text", field: "content", value });
}

/**
 * Adds clauses (the AI filter's) to the current ones: a set clause joins the values of one with
 * the same field and op, and a date, flag or text clause replaces the field's own.
 */
export function mergeClauses(filters: Filters, incoming: Filters): KanbanFilterClause[] {
  let merged = [...filters];
  for (const clause of incoming) {
    if (clause.kind !== "set") {
      merged = upsert(merged, clause.kind, clause.field, clause);
      continue;
    }
    const index = merged.findIndex(
      (current) =>
        current.kind === "set" && current.field === clause.field && current.op === clause.op,
    );
    const current = merged[index];
    if (current?.kind !== "set") {
      merged = append(merged, clause);
      continue;
    }
    const values = [...new Set([...current.values, ...clause.values])].slice(
      0,
      KANBAN_LIMITS.filterValues,
    );
    merged = replaceClause(merged, index, { ...current, values });
  }
  return merged;
}

const clauseKey = (clause: KanbanFilterClause): string => {
  switch (clause.kind) {
    case "set":
      return ["set", clause.field, clause.op, ...[...clause.values].sort()].join("\u0000");
    case "date":
      return ["date", clause.field, clause.op, typeof clause.value, String(clause.value)].join(
        "\u0000",
      );
    case "flag":
      return ["flag", clause.field, String(clause.value)].join("\u0000");
    case "text":
      return ["text", clause.field, clause.value].join("\u0000");
  }
};

const sameMembers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
};

/**
 * Whether two view configs show the same board (the tabs' unsaved-changes dot). Clause order,
 * a clause's value order, property order and hidden column order do not count.
 */
export function configEquals(a: KanbanViewConfig, b: KanbanViewConfig): boolean {
  return (
    a.layout === b.layout &&
    a.groupBy === b.groupBy &&
    a.subGroupBy === b.subGroupBy &&
    a.orderBy === b.orderBy &&
    a.completedByRecency === b.completedByRecency &&
    a.completed === b.completed &&
    a.showSubIssues === b.showSubIssues &&
    a.showEmptyColumns === b.showEmptyColumns &&
    sameMembers(a.hiddenColumns, b.hiddenColumns) &&
    sameMembers(a.properties, b.properties) &&
    sameMembers(a.filters.map(clauseKey), b.filters.map(clauseKey))
  );
}

export interface KanbanDatePreset {
  readonly label: string;
  readonly op: "pastDays" | "nextDays";
  readonly days: number;
}

const PAST_PRESETS: ReadonlyArray<KanbanDatePreset> = [
  { label: "Past day", op: "pastDays", days: 1 },
  { label: "Past week", op: "pastDays", days: 7 },
  { label: "Past month", op: "pastDays", days: 30 },
  { label: "Past 3 months", op: "pastDays", days: 90 },
];

const NEXT_PRESETS: ReadonlyArray<KanbanDatePreset> = [
  { label: "Next week", op: "nextDays", days: 7 },
  { label: "Next month", op: "nextDays", days: 30 },
];

/** Relative ranges a date field offers; only the due date looks ahead. */
export function datePresets(field: KanbanDateFilterField): ReadonlyArray<KanbanDatePreset> {
  return field === "dueDate" ? [...PAST_PRESETS, ...NEXT_PRESETS] : PAST_PRESETS;
}

/** A calendar day as the `YYYY-MM-DD` a before/after clause stores (local time). */
export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
