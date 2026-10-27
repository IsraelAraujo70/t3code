/**
 * Turns a Linear custom view's `filterData` (Linear's IssueFilter JSON) into board filter
 * clauses. Only filters the board can reproduce exactly are imported; anything else rejects the
 * whole view, so an import never shows more tickets than the view it came from.
 */
import {
  KANBAN_LIMITS,
  type KanbanFilterClause,
  type KanbanFlagFilterField,
  type KanbanSetFilterField,
} from "@t3tools/contracts";

export interface LinearFilterContext {
  /** Case-insensitive; includes the labels of a label group with that name. */
  readonly labelIdsByName: (name: string) => ReadonlyArray<string>;
  readonly statesByName: (name: string) => ReadonlyArray<string>;
  /** What `isMe` becomes: the importing account's Linear user id (`me` is every account's). */
  readonly me: string;
}

export type LinearViewImport =
  | { readonly ok: true; readonly filters: ReadonlyArray<KanbanFilterClause> }
  | { readonly ok: false; readonly reason: string };

type SetClause = Extract<KanbanFilterClause, { readonly kind: "set" }>;
type JsonObject = Readonly<Record<string, unknown>>;

class Unsupported {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const unsupported = (what: string) => new Unsupported(`${what}: not supported in T3`);

const asObject = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

function onlyEntry(field: string, value: unknown): readonly [string, unknown] {
  const entries = Object.entries(asObject(value) ?? {});
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) throw unsupported(field);
  return entry;
}

function setClause(
  field: KanbanSetFilterField,
  values: ReadonlyArray<string>,
  op: SetClause["op"] = "in",
): SetClause {
  const unique = [...new Set(values)];
  if (unique.length > KANBAN_LIMITS.filterValues) throw unsupported(`${field} with so many values`);
  return { kind: "set", field, op, values: unique };
}

const flagClause = (field: KanbanFlagFilterField, value: boolean): KanbanFilterClause => ({
  kind: "flag",
  field,
  value,
});

/** `{ eq: x }`, `{ in: [...] }` or `{ nin: [...] }` with string (or, for priority, number) values. */
function comparison(
  field: string,
  value: unknown,
  ops: ReadonlyArray<"eq" | "in" | "nin">,
): { readonly op: SetClause["op"]; readonly values: ReadonlyArray<string> } {
  const [op, operand] = onlyEntry(field, value);
  const list = op === "eq" ? [operand] : Array.isArray(operand) ? operand : null;
  if (!ops.some((allowed) => allowed === op) || list === null || list.length === 0) {
    throw unsupported(field);
  }
  const values = list.map((item) => {
    if (typeof item === "string" || (field === "priority" && typeof item === "number")) {
      return String(item);
    }
    throw unsupported(field);
  });
  return { op: op === "nin" ? "notIn" : "in", values };
}

function byName(
  field: string,
  value: unknown,
  lookup: (name: string) => ReadonlyArray<string>,
): ReadonlyArray<string> {
  return comparison(field, value, ["eq", "in"]).values.flatMap((name) => {
    const ids = lookup(name);
    if (ids.length === 0) throw new Unsupported(`${field} "${name}": not found in T3`);
    return ids;
  });
}

function nullFlag(field: string, value: unknown): boolean {
  const [key, isNull] = onlyEntry(field, value);
  if (key !== "null" || typeof isNull !== "boolean") throw unsupported(field);
  return !isNull;
}

function personClause(field: "assignee" | "creator", value: unknown, me: string): SetClause {
  const [key, operand] = onlyEntry(field, value);
  switch (key) {
    case "isMe": {
      const [op, isMe] = onlyEntry(field, operand);
      if (op !== "eq" || isMe !== true) throw unsupported(field);
      return setClause(field, [me]);
    }
    case "null":
      if (typeof operand !== "boolean") throw unsupported(field);
      return setClause(field, ["none"], operand ? "in" : "notIn");
    case "id":
      return setClause(field, comparison(field, operand, ["eq", "in"]).values);
    default:
      throw unsupported(`${field}.${key}`);
  }
}

function fieldClauses(
  field: string,
  value: unknown,
  ctx: LinearFilterContext,
): ReadonlyArray<KanbanFilterClause> {
  const node = asObject(value);
  if (node === null) throw unsupported(field);
  const [key, operand] = onlyEntry(field, node);
  if (key === "and" || key === "or") {
    if (!Array.isArray(operand) || operand.length === 0) throw unsupported(field);
    if (key === "and") return operand.flatMap((branch) => fieldClauses(field, branch, ctx));
    // Each alternative must be one clause: flattening an `and` inside an `or` would widen the view.
    const alternatives = operand.map((branch) => fieldClauses(field, branch, ctx));
    if (alternatives.some((clauses) => clauses.length !== 1)) {
      throw unsupported(`${field} with "and" inside "or"`);
    }
    return [mergeAlternatives(field, alternatives.flat())];
  }
  switch (field) {
    case "assignee":
    case "creator":
      return [personClause(field, node, ctx.me)];
    case "state": {
      if (key === "type") {
        const { op, values } = comparison("state", operand, ["eq", "in", "nin"]);
        return [setClause("statusType", values, op)];
      }
      if (key === "name") return [setClause("status", byName("state", operand, ctx.statesByName))];
      throw unsupported(`state.${key}`);
    }
    case "priority": {
      const { op, values } = comparison(field, node, ["eq", "in", "nin"]);
      return [setClause("priority", values, op)];
    }
    case "labels": {
      const name = key === "parent" ? onlyEntry("labels", operand) : ([key, operand] as const);
      if (name[0] !== "name") throw unsupported(`labels.${key}`);
      return [setClause("label", byName("label", name[1], ctx.labelIdsByName))];
    }
    case "project":
    case "cycle":
      if (key !== "id") throw unsupported(`${field}.${key}`);
      return [setClause(field, comparison(field, operand, ["eq", "in"]).values)];
    case "parent":
      return [flagClause("isSubIssue", nullFlag(field, node))];
    case "dueDate":
      return [flagClause("hasDueDate", nullFlag(field, node))];
    case "children": {
      if (key !== "length") throw unsupported(`children.${key}`);
      const [op, count] = onlyEntry(field, operand);
      if (op === "gt" && count === 0) return [flagClause("hasSubIssues", true)];
      if (op === "eq" && count === 0) return [flagClause("hasSubIssues", false)];
      throw unsupported(field);
    }
    default:
      throw unsupported(field);
  }
}

/** Linear writes "is any of" as an `or` of single matches on one field. */
function mergeAlternatives(
  field: string,
  clauses: ReadonlyArray<KanbanFilterClause>,
): KanbanFilterClause {
  const first = clauses[0];
  if (first === undefined || first.kind !== "set") throw unsupported(`${field} with "or"`);
  const sets = clauses.filter(
    (clause): clause is SetClause =>
      clause.kind === "set" && clause.field === first.field && clause.op === "in",
  );
  if (sets.length !== clauses.length) throw unsupported(`${field} with "or"`);
  return setClause(
    first.field,
    sets.flatMap((clause) => clause.values),
  );
}

function conjunction(value: unknown, ctx: LinearFilterContext): ReadonlyArray<KanbanFilterClause> {
  const node = asObject(value);
  if (node === null) throw unsupported("filter");
  return Object.entries(node).flatMap(([field, operand]) => {
    if (field !== "and") return fieldClauses(field, operand, ctx);
    if (!Array.isArray(operand)) throw unsupported("and");
    return operand.flatMap((part) => conjunction(part, ctx));
  });
}

export function linearFilterToClauses(
  filterData: unknown,
  ctx: LinearFilterContext,
): LinearViewImport {
  try {
    const filters = conjunction(filterData, ctx);
    if (filters.length > KANBAN_LIMITS.filterClauses) throw unsupported("so many filters");
    return { ok: true, filters };
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.reason };
    throw error;
  }
}
