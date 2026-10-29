import { type KanbanTicket, type KanbanTicketId } from "@t3tools/contracts";

/**
 * One ticket's label taps the snapshot has not shown yet, as a change against it. Taps
 * accumulate here, so each save sends every label picked so far, not just the last tap.
 */
export interface KanbanLabelDraft {
  readonly ticketId: KanbanTicketId;
  /** The snapshot labels this draft was last reconciled with. */
  readonly basis: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/** The ticket's labels with the draft applied: what the screen shows and the next save sends. */
export function draftedLabelIds(
  draft: KanbanLabelDraft | null,
  ticket: Pick<KanbanTicket, "id" | "labelIds">,
): ReadonlyArray<string> {
  if (draft === null || draft.ticketId !== ticket.id) return ticket.labelIds;
  return [
    ...ticket.labelIds.filter((id) => !draft.removed.includes(id)),
    ...draft.added.filter((id) => !ticket.labelIds.includes(id)),
  ];
}

/** Flips one label against what the screen shows. */
export function toggleDraftLabel(
  draft: KanbanLabelDraft | null,
  ticket: Pick<KanbanTicket, "id" | "labelIds">,
  labelId: string,
): KanbanLabelDraft {
  const own = draft !== null && draft.ticketId === ticket.id ? draft : null;
  const added = own?.added ?? [];
  const removed = own?.removed ?? [];
  const selected = draftedLabelIds(own, ticket).includes(labelId);
  return {
    ticketId: ticket.id,
    basis: ticket.labelIds,
    added: selected ? added.filter((id) => id !== labelId) : [...added, labelId],
    removed: selected ? [...removed, labelId] : removed.filter((id) => id !== labelId),
  };
}

/**
 * Drops the parts of the draft a new snapshot already shows, so later edits from elsewhere
 * show through. Returns the same draft while the snapshot labels are unchanged.
 */
export function reconcileLabelDraft(
  draft: KanbanLabelDraft | null,
  ticket: Pick<KanbanTicket, "id" | "labelIds">,
): KanbanLabelDraft | null {
  if (draft === null || draft.ticketId !== ticket.id) return null;
  if (draft.basis === ticket.labelIds) return draft;
  const added = draft.added.filter((id) => !ticket.labelIds.includes(id));
  const removed = draft.removed.filter((id) => ticket.labelIds.includes(id));
  if (added.length === 0 && removed.length === 0) return null;
  return { ticketId: draft.ticketId, basis: ticket.labelIds, added, removed };
}

/** Writes in flight by key; the same key can be in flight more than once. */
export type PendingWrites = ReadonlyMap<string, number>;

export function addPendingWrite(pending: PendingWrites, key: string): PendingWrites {
  return new Map(pending).set(key, (pending.get(key) ?? 0) + 1);
}

export function removePendingWrite(pending: PendingWrites, key: string): PendingWrites {
  const next = new Map(pending);
  const count = (next.get(key) ?? 0) - 1;
  if (count > 0) next.set(key, count);
  else next.delete(key);
  return next;
}
