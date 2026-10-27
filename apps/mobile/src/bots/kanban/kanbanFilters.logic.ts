import type {
  KanbanFilterClause,
  KanbanSetFilterField,
  KanbanView,
  KanbanViewConfig,
  ProjectId,
} from "@t3tools/contracts";

/** The filters a phone edits from chips, in chip order. */
export const KANBAN_OVERLAY_FIELDS = [
  "status",
  "assignee",
  "priority",
  "label",
  "workspace",
  "account",
] as const satisfies ReadonlyArray<KanbanSetFilterField>;
export type KanbanOverlayField = (typeof KANBAN_OVERLAY_FIELDS)[number];

/**
 * The phone's edits over the selected view: for each field it touched, the values it keeps
 * (empty: no filter on that field). Untouched fields keep the view's own clauses.
 */
export type KanbanFilterOverlay = Partial<Record<KanbanOverlayField, ReadonlyArray<string>>>;

const isInClause = (clause: KanbanFilterClause, field: KanbanOverlayField) =>
  clause.kind === "set" && clause.op === "in" && clause.field === field;

/** The values a field's chip shows: the overlay's, else the view's own "is any of" values. */
export function overlayValues(
  config: KanbanViewConfig,
  overlay: KanbanFilterOverlay,
  field: KanbanOverlayField,
): ReadonlyArray<string> {
  const edited = overlay[field];
  if (edited !== undefined) return edited;
  return config.filters.flatMap((clause) =>
    clause.kind === "set" && isInClause(clause, field) ? clause.values : [],
  );
}

/**
 * The view's config with the overlay applied: a touched field's "is any of" clauses give way to
 * one clause with the overlay's values (none when empty). "Is not" clauses and every other
 * setting stay as the view saved them.
 */
export function applyFilterOverlay(
  config: KanbanViewConfig,
  overlay: KanbanFilterOverlay,
): KanbanViewConfig {
  const touched = KANBAN_OVERLAY_FIELDS.filter((field) => overlay[field] !== undefined);
  if (touched.length === 0) return config;
  const added: KanbanFilterClause[] = [];
  for (const field of touched) {
    const values = overlay[field] ?? [];
    if (values.length > 0) added.push({ kind: "set", field, op: "in", values });
  }
  return {
    ...config,
    filters: [
      ...config.filters.filter((clause) => !touched.some((field) => isInClause(clause, field))),
      ...added,
    ],
  };
}

/** Adds or removes one value of a field, starting from what its chip shows. */
export function toggleOverlayValue(
  config: KanbanViewConfig,
  overlay: KanbanFilterOverlay,
  field: KanbanOverlayField,
  value: string,
): KanbanFilterOverlay {
  const current = overlayValues(config, overlay, field);
  return {
    ...overlay,
    [field]: current.includes(value)
      ? current.filter((candidate) => candidate !== value)
      : [...current, value],
  };
}

/** "Status", "Status: Todo", or "Status: 3". */
export function filterChipLabel(
  fieldLabel: string,
  values: ReadonlyArray<string>,
  labelOf: (value: string) => string,
): string {
  const [first] = values;
  if (first === undefined) return fieldLabel;
  return values.length === 1
    ? `${fieldLabel}: ${labelOf(first)}`
    : `${fieldLabel}: ${values.length}`;
}

/** Views shown on a board scope: views of every board, plus the scoped project's own. */
export function scopeViews(
  views: ReadonlyArray<KanbanView>,
  projectId: ProjectId | null,
): ReadonlyArray<KanbanView> {
  return views.filter((view) => view.projectId === null || view.projectId === projectId);
}

/** The picked view while it is still in scope, else the scope's first view. */
export function selectedView(
  views: ReadonlyArray<KanbanView>,
  pickedId: string | null,
): KanbanView | null {
  return views.find((view) => view.id === pickedId) ?? views[0] ?? null;
}
