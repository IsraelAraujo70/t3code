/**
 * Several kanban cards selected at once and handed to one workflow run as `params.tickets`
 * (docs/friend/workflows-design.md §6.2). Pure rules; the page and dialog only render them.
 */
import type { KanbanViewResult } from "@t3tools/client-runtime/kanban-board";
import { parseRunParam } from "@t3tools/client-runtime/workflows";
import type {
  KanbanTicket,
  KanbanTicketId,
  WorkflowDefinition,
  WorkflowDocument,
  WorkflowParamSpec,
  WorkflowSummary,
} from "@t3tools/contracts";

/** The param a workflow declares to take kanban cards. */
export const TICKETS_PARAM = "tickets";
/** No run takes more cards than this, whatever its `maxItems` says. */
export const MAX_TICKETS_PER_RUN = 10;

export interface KanbanSelection {
  /** In the order they were selected. */
  readonly ids: ReadonlyArray<KanbanTicketId>;
  /** The last card clicked; a shift-click selects from it. */
  readonly anchor: KanbanTicketId | null;
}

export const EMPTY_SELECTION: KanbanSelection = { ids: [], anchor: null };

/** Adds or removes one card. */
export function toggleTicket(selection: KanbanSelection, id: KanbanTicketId): KanbanSelection {
  const ids = selection.ids.includes(id)
    ? selection.ids.filter((candidate) => candidate !== id)
    : [...selection.ids, id];
  return { ids, anchor: id };
}

/**
 * Shift-click: adds every card between the anchor and `id` in `order` (the cards as shown).
 * Without an anchor on screen it toggles `id` alone.
 */
export function selectRange(
  selection: KanbanSelection,
  id: KanbanTicketId,
  order: ReadonlyArray<KanbanTicketId>,
): KanbanSelection {
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const to = order.indexOf(id);
  if (from === -1 || to === -1) return toggleTicket(selection, id);
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  const ids = [
    ...selection.ids,
    ...range.filter((candidate) => !selection.ids.includes(candidate)),
  ];
  return { ids, anchor: id };
}

/** Cards as the view shows them: column by column, or lane by lane; each card once. */
export function visibleTickets(view: KanbanViewResult): ReadonlyArray<KanbanTicket> {
  const groups =
    view.swimlanes === null
      ? view.columns.map((column) => column.tickets)
      : view.swimlanes.flatMap((lane) =>
          view.columns.map((column) => lane.cells.get(column.id) ?? []),
        );
  const seen = new Set<KanbanTicketId>();
  return groups.flat().filter((ticket) => !seen.has(ticket.id) && seen.add(ticket.id));
}

/** The selected cards still on screen, in selection order; a card filtered out drops out. */
export function selectedTickets(
  selection: KanbanSelection,
  visible: ReadonlyArray<KanbanTicket>,
): ReadonlyArray<KanbanTicket> {
  const byId = new Map(visible.map((ticket) => [ticket.id, ticket]));
  return selection.ids.flatMap((id) => byId.get(id) ?? []);
}

/** Why the selection cannot go to any workflow; null when it can. */
export function selectionBlockReason(count: number): string | null {
  return count > MAX_TICKETS_PER_RUN
    ? `A run takes at most ${MAX_TICKETS_PER_RUN} cards; ${count} are selected.`
    : null;
}

export type TicketWorkflowOption =
  | { readonly kind: "loading"; readonly summary: WorkflowSummary }
  | { readonly kind: "unavailable"; readonly summary: WorkflowSummary; readonly reason: string }
  | {
      readonly kind: "runnable";
      readonly summary: WorkflowSummary;
      readonly definition: WorkflowDefinition;
      readonly spec: WorkflowParamSpec;
      /** `maxItems`, capped at {@link MAX_TICKETS_PER_RUN}. */
      readonly limit: number;
    };

/**
 * How a workflow shows in the "Run workflow" menu: null when it takes no `tickets: string[]`
 * (or its file does not compile, so its params are unknown), `loading` until its document arrives.
 */
export function ticketWorkflowOption(
  summary: WorkflowSummary,
  document: WorkflowDocument | null,
): TicketWorkflowOption | null {
  if (!summary.valid) return null;
  if (document === null) return { kind: "loading", summary };
  const definition = document.definition;
  const spec = definition?.params?.[TICKETS_PARAM];
  if (definition === null || spec === undefined || spec.type !== "string[]") return null;
  const reason = !document.enabled
    ? "Turned off. Turn it on in Workflows."
    : document.suspended
      ? "Paused after repeated failures. Resume it in Workflows."
      : !Object.values(definition.triggers ?? {}).some((trigger) => trigger.kind === "manual")
        ? "Has no manual trigger."
        : null;
  if (reason !== null) return { kind: "unavailable", summary, reason };
  const limit = Math.min(spec.maxItems ?? MAX_TICKETS_PER_RUN, MAX_TICKETS_PER_RUN);
  return { kind: "runnable", summary, definition, spec, limit };
}

export type TicketsRunCheck =
  | { readonly ok: true; readonly params: { readonly [TICKETS_PARAM]: ReadonlyArray<string> } }
  | { readonly ok: false; readonly reason: string };

/**
 * The run's params: each card's identifier (`BACK-222`), which `kanbanCard: "{{ item }}"` reads.
 * Refuses more cards than the limit and never cuts the selection.
 */
export function ticketsRunCheck(
  option: Extract<TicketWorkflowOption, { kind: "runnable" }>,
  tickets: ReadonlyArray<KanbanTicket>,
): TicketsRunCheck {
  if (tickets.length === 0) return { ok: false, reason: "Select at least one card." };
  if (tickets.length > option.limit) {
    return {
      ok: false,
      reason: `${option.summary.title} takes at most ${option.limit} cards; ${tickets.length} are selected.`,
    };
  }
  const identifiers = tickets.map((ticket) => ticket.identifier);
  const repeated = identifiers.find((identifier, index) => identifiers.indexOf(identifier) < index);
  if (repeated !== undefined) {
    return {
      ok: false,
      reason: `Two selected cards are both ${repeated}. Run them from one project at a time.`,
    };
  }
  const parsed = parseRunParam(option.spec, identifiers.join(" "));
  if (!parsed.ok) return { ok: false, reason: parsed.message };
  return { ok: true, params: { [TICKETS_PARAM]: identifiers } };
}

/** `claude-opus-5-5 (high)` for each of the workflow's named models; empty when it names none. */
export function workflowModelLabels(definition: WorkflowDefinition): ReadonlyArray<string> {
  return Object.values(definition.models ?? {}).map((model) =>
    model.effort === undefined ? model.model : `${model.model} (${model.effort})`,
  );
}
