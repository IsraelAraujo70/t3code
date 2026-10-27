/**
 * The kanban's small Linear-style pieces: status and priority icons, avatars, label pills and PR
 * badges. Shared by cards, list rows, column headers, pickers and the issue view.
 */
import type { KanbanPullRequestRef, LinearStateType } from "@t3tools/contracts";
import type { KanbanGroupIcon } from "@t3tools/client-runtime/kanban-board";

import type { KanbanLookups, KanbanPersonDisplay } from "./kanbanLookups";

/** Linear's status glyphs: dotted circle (backlog/triage), empty, half-filled, check, x, duplicate. */
export function KanbanStatusIcon(props: {
  readonly stateType: LinearStateType;
  readonly color: string;
  /** 0..1 fill for started states; Linear draws In Review fuller than In Progress. */
  readonly progress?: number;
  readonly size?: number;
}) {
  void props;
  return null;
}

/** Linear's priority glyphs: three bars filled by level, the exclamation box for urgent, dashes for none. */
export function KanbanPriorityIcon(props: { readonly priority: number; readonly size?: number }) {
  void props;
  return null;
}

/** An image avatar with initials fallback, or the bot's face for a bot. */
export function KanbanAvatar(props: {
  readonly person: KanbanPersonDisplay | null;
  readonly size?: number;
}) {
  void props;
  return null;
}

/** A label as Linear draws it: a colored dot and the name in a rounded outline pill. */
export function KanbanLabelPill(props: {
  readonly name: string;
  readonly color: string;
  readonly onRemove?: () => void;
}) {
  void props;
  return null;
}

/** The PR number for one PR, "N PRs" for several, colored by the most advanced state. */
export function KanbanPullRequestBadge(props: {
  readonly pullRequests: ReadonlyArray<KanbanPullRequestRef>;
}) {
  void props;
  return null;
}

/** A group's leading icon (columns, list sections, swimlanes, filter options). */
export function KanbanGroupIconView(props: {
  readonly icon: KanbanGroupIcon;
  readonly lookups: KanbanLookups;
  readonly size?: number;
}) {
  void props;
  return null;
}
