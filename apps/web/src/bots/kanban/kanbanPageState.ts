/**
 * The kanban page's pure state: the URL it reads and writes, which views a board scope shows,
 * the active view, per-view drafts, the effective config with the search box, the payloads that
 * save views, and the optimistic drops a board shows until the server answers.
 */
import {
  KanbanViewId,
  ProjectId,
  type KanbanFilterClause,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanView,
  type KanbanViewConfig,
  type KanbanViewImportResult,
  type KanbanViewSaveInput,
} from "@t3tools/contracts";
import {
  dropActionFor,
  type KanbanDropAction,
  type KanbanGroup,
} from "@t3tools/client-runtime/kanban-board";
import { Schema } from "effect";

import { configEquals } from "./kanbanFilterEdit";

/** `/kanban` search params: board scope, view, the open issue and whether it is maximized. */
export interface KanbanSearch {
  /** Absent: every project (or, with no param at all, the remembered scope). */
  readonly project?: ProjectId;
  readonly view?: KanbanViewId;
  /** A ticket identifier such as `BACK-169`. */
  readonly issue?: string;
  readonly full?: 1;
}

const isViewId = Schema.is(KanbanViewId);
const ISSUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseKanbanSearch(raw: Record<string, unknown>): KanbanSearch {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const project = text(raw.project);
  const view = text(raw.view);
  const issue = text(raw.issue);
  return {
    ...(project !== "" && project.length <= 200 ? { project: ProjectId.make(project) } : {}),
    ...(isViewId(view) ? { view } : {}),
    ...(ISSUE_PATTERN.test(issue) ? { issue: issue.toUpperCase() } : {}),
    ...(issue !== "" && (raw.full === 1 || raw.full === "1") ? { full: 1 as const } : {}),
  };
}

/** Whether the URL says anything; a bare `/kanban` falls back to what the user last saw. */
export const hasKanbanSearch = (search: KanbanSearch): boolean =>
  search.project !== undefined ||
  search.view !== undefined ||
  search.issue !== undefined ||
  search.full !== undefined;

/** What the page remembers between visits, per scope (`all` or a project id). */
export const KanbanRemembered = Schema.Struct({
  project: Schema.NullOr(Schema.String),
  views: Schema.Record(Schema.String, Schema.String),
});
export type KanbanRemembered = typeof KanbanRemembered.Type;

export const scopeKey = (projectId: ProjectId | null): string => projectId ?? "all";

/** The views a scope shows, in server order: the views of every board, then the project's. */
export function viewsForScope(
  views: ReadonlyArray<KanbanView>,
  projectId: ProjectId | null,
): ReadonlyArray<KanbanView> {
  return views.filter((view) => view.projectId === null || view.projectId === projectId);
}

/** The URL's view when the scope shows it, else the remembered one, else the first. */
export function pickActiveView(
  views: ReadonlyArray<KanbanView>,
  fromUrl: string | undefined,
  remembered: string | undefined,
): KanbanView | null {
  return (
    views.find((view) => view.id === fromUrl) ??
    views.find((view) => view.id === remembered) ??
    views[0] ??
    null
  );
}

/** The whole tab order after the scope's tabs were reordered: other views keep their slots. */
export function reorderedViewIds(
  all: ReadonlyArray<KanbanView>,
  scopeOrder: ReadonlyArray<KanbanViewId>,
): KanbanViewId[] {
  const shown = new Set(scopeOrder);
  let next = 0;
  return all.map((view) => (shown.has(view.id) ? (scopeOrder[next++] ?? view.id) : view.id));
}

/** Unsaved changes per view id, kept while the page lives. */
export type KanbanDrafts = ReadonlyMap<KanbanViewId, KanbanViewConfig>;

export const draftOf = (view: KanbanView, drafts: KanbanDrafts): KanbanViewConfig =>
  drafts.get(view.id) ?? view.config;

export const isDirty = (view: KanbanView, drafts: KanbanDrafts): boolean =>
  !configEquals(view.config, draftOf(view, drafts));

/** Records a view's new draft; a draft back at the saved config is dropped. */
export function withDraft(
  drafts: KanbanDrafts,
  view: KanbanView,
  config: KanbanViewConfig,
): KanbanDrafts {
  const next = new Map(drafts);
  if (configEquals(view.config, config)) next.delete(view.id);
  else next.set(view.id, config);
  return next;
}

export function withoutDraft(drafts: KanbanDrafts, viewId: KanbanViewId): KanbanDrafts {
  if (!drafts.has(viewId)) return drafts;
  const next = new Map(drafts);
  next.delete(viewId);
  return next;
}

/** The config the board renders: the draft plus the search box as a content clause. */
export function effectiveConfig(draft: KanbanViewConfig, search: string): KanbanViewConfig {
  const value = search.trim();
  if (value === "") return draft;
  const clause: KanbanFilterClause = { kind: "text", field: "content", value: value.slice(0, 200) };
  return { ...draft, filters: [...draft.filters, clause] };
}

/** Saves the draft over the view, keeping its scope, name and icon. */
export const saveViewInput = (view: KanbanView, draft: KanbanViewConfig): KanbanViewSaveInput => ({
  id: view.id,
  projectId: view.projectId,
  name: view.name,
  icon: view.icon,
  config: draft,
});

/** A new view from the draft: on every board, or only on the scope's project. */
export const saveAsInput = (
  name: string,
  everywhere: boolean,
  scope: ProjectId | null,
  draft: KanbanViewConfig,
): KanbanViewSaveInput => ({
  projectId: everywhere ? null : scope,
  name,
  icon: null,
  config: draft,
});

/** A rename keeps the saved config; a draft stays a draft. */
export const renameViewInput = (view: KanbanView, name: string): KanbanViewSaveInput => ({
  ...saveViewInput(view, view.config),
  name,
});

/** "Imported 2 views, skipped 1" and why each skipped view was left out. */
export function importSummary(result: KanbanViewImportResult): {
  readonly title: string;
  readonly description: string | null;
} {
  const plural = (count: number) => `${count} view${count === 1 ? "" : "s"}`;
  const skipped = result.skipped.length;
  return {
    title: `Imported ${plural(result.imported.length)}${skipped > 0 ? `, skipped ${skipped}` : ""}`,
    description:
      skipped === 0
        ? null
        : result.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join("\n"),
  };
}

/** The open issue: in the scope first, then on any project's board. */
export function findIssue<T extends Pick<KanbanTicket, "identifier" | "projectId">>(
  tickets: ReadonlyArray<T>,
  scope: ProjectId | null,
  identifier: string,
): T | null {
  const matches = tickets.filter((ticket) => ticket.identifier.toUpperCase() === identifier);
  return (
    matches.find((ticket) => scope === null || ticket.projectId === scope) ?? matches[0] ?? null
  );
}

/**
 * What dropping a ticket on a board cell does: the column's change, then the swimlane's (a lane
 * grouped like the columns adds nothing). Two property changes go as one update.
 */
export function cellDropActions(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  config: Pick<KanbanViewConfig, "groupBy" | "subGroupBy">,
  column: KanbanGroup,
  lane: KanbanGroup | null,
): ReadonlyArray<KanbanDropAction> {
  const byColumn = dropActionFor(snapshot, ticket, config.groupBy, column);
  const byLane =
    lane === null || config.subGroupBy === config.groupBy
      ? null
      : dropActionFor(snapshot, ticket, config.subGroupBy, lane);
  if (byColumn?.kind === "update" && byLane?.kind === "update") {
    return [{ kind: "update", patch: { ...byColumn.patch, ...byLane.patch } }];
  }
  return [byColumn, byLane].filter((action) => action !== null);
}

/** Drops the board shows at once, by ticket id, until the server answers. */
export type KanbanPendingDrops = ReadonlyMap<string, ReadonlyArray<KanbanDropAction>>;

function applyDrop(ticket: KanbanTicket, action: KanbanDropAction): KanbanTicket {
  if (action.kind === "move") return { ...ticket, status: action.to };
  const { patch } = action;
  return {
    ...ticket,
    ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.labelIds !== undefined ? { labelIds: patch.labelIds } : {}),
    ...(patch.linearProjectId !== undefined ? { linearProjectId: patch.linearProjectId } : {}),
    ...(patch.cycleId !== undefined ? { cycleId: patch.cycleId } : {}),
  };
}

export function applyPendingDrops(
  snapshot: KanbanSnapshot,
  pending: KanbanPendingDrops,
): KanbanSnapshot {
  if (pending.size === 0) return snapshot;
  return {
    ...snapshot,
    tickets: snapshot.tickets.map((ticket) =>
      (pending.get(ticket.id) ?? []).reduce(applyDrop, ticket),
    ),
  };
}
