import { useDraggable } from "@dnd-kit/core";
import { KANBAN_PRIORITY_LABELS } from "@t3tools/client-runtime/kanban-board";
import type {
  BotDirectoryEntry,
  EnvironmentId,
  KanbanDisplayProperty,
  KanbanLabel,
  KanbanTicket,
  ThreadId,
} from "@t3tools/contracts";
import {
  CalendarIcon,
  ChevronRightIcon,
  DiamondIcon,
  ExternalLinkIcon,
  FolderIcon,
  IterationCcwIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  TriangleIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { personDisplay, ticketStatusDisplay, type KanbanLookups } from "./kanbanLookups";
import {
  KanbanAvatar,
  KanbanChip,
  KanbanLabelPill,
  KanbanPriorityIcon,
  KanbanPullRequestBadge,
  KanbanResponsibleBots,
  KanbanStatusIcon,
  KanbanSwatch,
  KanbanThreadsBadge,
  stopDragStart,
  type KanbanLinkedThread,
} from "./KanbanPrimitives";

export interface KanbanThreadOption {
  readonly id: ThreadId;
  readonly title: string;
}

/** What a card and a list row both take. */
export interface KanbanTicketViewProps {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly lookups: KanbanLookups;
  readonly properties: ReadonlySet<KanbanDisplayProperty>;
  /** The ticket's workspace bots, shown when the ticket has no bot of its own. */
  readonly workspaceBots: ReadonlyArray<BotDirectoryEntry>;
  /** Linked threads the client knows, oldest link first. */
  readonly threads: ReadonlyArray<KanbanLinkedThread>;
  /** The T3 project, on the board of every project; null on one project's board. */
  readonly projectTitle: string | null;
  readonly selected: boolean;
  readonly canEdit: boolean;
  /** Threads of the ticket's project that are not linked yet, newest first. */
  readonly linkableThreads: ReadonlyArray<KanbanThreadOption>;
  readonly onOpen: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onLinkThread: (threadId: ThreadId) => void;
  readonly onDelete: () => void;
}

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const SHORT_DATE_WITH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Oct 26", with the year when it is not this year. */
export function formatKanbanDate(date: Date): string {
  return date.getFullYear() === new Date().getFullYear()
    ? SHORT_DATE.format(date)
    : SHORT_DATE_WITH_YEAR.format(date);
}

/** A `YYYY-MM-DD` due date at local midnight. */
const dueDateOf = (dueDate: string) => new Date(`${dueDate}T00:00:00`);

const isOverdue = (ticket: KanbanTicket) =>
  ticket.dueDate !== null &&
  ticket.closedAt === null &&
  dueDateOf(ticket.dueDate).getTime() < new Date().setHours(0, 0, 0, 0);

/** The ticket's own bot when it has one, else its workspace's bots. */
export function responsibleBots(
  ticket: KanbanTicket,
  lookups: KanbanLookups,
  workspaceBots: ReadonlyArray<BotDirectoryEntry>,
): ReadonlyArray<BotDirectoryEntry> {
  if (ticket.botId === null) return workspaceBots;
  const bot = lookups.botsById.get(ticket.botId);
  return bot === undefined ? [] : [bot];
}

export function ticketLabels(
  ticket: KanbanTicket,
  lookups: KanbanLookups,
): ReadonlyArray<KanbanLabel> {
  return ticket.labelIds.flatMap((labelId) => {
    const label = lookups.labelsById.get(labelId);
    return label === undefined ? [] : [label];
  });
}

/** Up to `max` label pills, then "+N" with the rest in a tooltip. */
export function KanbanLabelList(props: {
  readonly labels: ReadonlyArray<KanbanLabel>;
  readonly max: number;
}) {
  const shown = props.labels.slice(0, props.max);
  const rest = props.labels.slice(props.max);
  return (
    <>
      {shown.map((label) => (
        <KanbanLabelPill key={label.id} name={label.name} color={label.color} />
      ))}
      {rest.length > 0 ? (
        <Tooltip>
          <TooltipTrigger render={<KanbanChip />}>+{rest.length}</TooltipTrigger>
          <TooltipPopup side="top">{rest.map((label) => label.name).join(", ")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

function WithTooltip(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** A click or Enter on the ticket itself opens it; its buttons, links and menus do their own thing. */
function opensTicket(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): boolean {
  const { target, currentTarget } = event;
  if (!(target instanceof Element) || !currentTarget.contains(target)) return false;
  if (event.type === "keydown") return target === currentTarget;
  return target.closest("button, a") === null;
}

export function ticketOpenHandlers(onOpen: () => void) {
  return {
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (opensTicket(event)) onOpen();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" || !opensTicket(event)) return;
      event.preventDefault();
      onOpen();
    },
  };
}

/** Open, link a thread, open in Linear, and delete for a local ticket. */
export function KanbanTicketMenu(
  props: Pick<
    KanbanTicketViewProps,
    "ticket" | "canEdit" | "linkableThreads" | "onOpen" | "onLinkThread" | "onDelete"
  >,
) {
  const { ticket } = props;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Actions for ${ticket.identifier}`}
            onPointerDown={stopDragStart}
          />
        }
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={props.onOpen}>
          <PanelRightOpenIcon />
          Open
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={!props.canEdit || props.linkableThreads.length === 0}>
            <LinkIcon />
            Link thread
          </MenuSubTrigger>
          <MenuSubPopup className="max-h-80 overflow-y-auto">
            <MenuGroup>
              <MenuGroupLabel>Threads of this project</MenuGroupLabel>
              {props.linkableThreads.map((thread) => (
                <MenuItem key={thread.id} onClick={() => props.onLinkThread(thread.id)}>
                  <span className="max-w-72 truncate">{thread.title}</span>
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuSubPopup>
        </MenuSub>
        {ticket.linear ? (
          <MenuItem onClick={() => window.open(ticket.linear?.url, "_blank", "noopener")}>
            <ExternalLinkIcon />
            Open in Linear
          </MenuItem>
        ) : (
          <>
            <MenuSeparator />
            <MenuItem disabled={!props.canEdit} onClick={props.onDelete}>
              <Trash2Icon />
              Delete ticket
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/** One ticket on the board, Linear-dense: identifier, status and title, property chips, dates. */
export const KanbanCard = memo(function KanbanCard(props: KanbanTicketViewProps) {
  const { ticket, lookups, properties: show } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: ticket.id,
    disabled: !props.canEdit,
  });
  const status = ticketStatusDisplay(lookups, ticket);
  const assignee = ticket.assigneeId === null ? null : personDisplay(lookups, ticket.assigneeId);
  const linearProject =
    ticket.linearProjectId === null ? undefined : lookups.projectsById.get(ticket.linearProjectId);
  const cycle = ticket.cycleId === null ? undefined : lookups.cyclesById.get(ticket.cycleId);
  const milestone =
    ticket.milestoneId === null ? undefined : lookups.milestonesById.get(ticket.milestoneId);
  const labels = show.has("labels") ? ticketLabels(ticket, lookups) : [];
  const bots = show.has("bot") ? responsibleBots(ticket, lookups, props.workspaceBots) : [];
  const threads = show.has("threads") ? props.threads : [];

  const chips: ReactNode[] = [];
  if (show.has("priority") && ticket.priority > 0) {
    chips.push(
      <WithTooltip key="priority" label={KANBAN_PRIORITY_LABELS[ticket.priority] ?? "Priority"}>
        <span className="inline-flex size-5 items-center justify-center rounded-md border">
          <KanbanPriorityIcon priority={ticket.priority} size={12} />
        </span>
      </WithTooltip>,
    );
  }
  if (show.has("project") && linearProject !== undefined) {
    chips.push(
      <KanbanChip key="linear-project" className="max-w-40">
        <KanbanSwatch color={linearProject.color} shape="square" size={9} />
        <span className="truncate">{linearProject.name}</span>
      </KanbanChip>,
    );
  }
  if (show.has("project") && props.projectTitle !== null) {
    chips.push(
      <KanbanChip key="project" className="max-w-40">
        <FolderIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{props.projectTitle}</span>
      </KanbanChip>,
    );
  }
  if (labels.length > 0) {
    chips.push(<KanbanLabelList key="labels" labels={labels} max={3} />);
  }
  if (show.has("subIssues") && ticket.subIssues !== null && ticket.subIssues.total > 0) {
    const { closed, total } = ticket.subIssues;
    chips.push(
      <KanbanChip key="sub-issues">
        <KanbanStatusIcon
          stateType={closed >= total ? "completed" : "started"}
          color="currentColor"
          progress={closed / total}
          size={11}
        />
        <span className="tabular-nums">
          {closed}/{total}
        </span>
      </KanbanChip>,
    );
  }
  if (show.has("pullRequests") && ticket.pullRequests.length > 0) {
    chips.push(<KanbanPullRequestBadge key="pull-requests" pullRequests={ticket.pullRequests} />);
  }
  if (show.has("dueDate") && ticket.dueDate !== null) {
    chips.push(
      <KanbanChip key="due" tone={isOverdue(ticket) ? "danger" : "default"}>
        <CalendarIcon aria-hidden className="size-3 shrink-0" />
        {formatKanbanDate(dueDateOf(ticket.dueDate))}
      </KanbanChip>,
    );
  }
  if (show.has("cycle") && cycle !== undefined) {
    chips.push(
      <KanbanChip key="cycle">
        <IterationCcwIcon aria-hidden className="size-3 shrink-0" />
        {cycle.name ?? `Cycle ${cycle.number}`}
      </KanbanChip>,
    );
  }
  if (show.has("milestone") && milestone !== undefined) {
    chips.push(
      <KanbanChip key="milestone" className="max-w-40">
        <DiamondIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{milestone.name}</span>
      </KanbanChip>,
    );
  }
  if (show.has("estimate") && ticket.estimate !== null) {
    chips.push(
      <KanbanChip key="estimate">
        <TriangleIcon aria-hidden className="size-3 shrink-0" />
        <span className="tabular-nums">{ticket.estimate}</span>
      </KanbanChip>,
    );
  }

  const dates = [
    show.has("created") ? `Created ${formatKanbanDate(new Date(ticket.createdAt))}` : null,
    show.has("updated") ? `Updated ${formatRelativeTimeLabel(ticket.updatedAt)}` : null,
  ].filter((part) => part !== null);
  const showHeader = show.has("id") || ticket.parent !== null || show.has("assignee");

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      {...ticketOpenHandlers(props.onOpen)}
      className={cn(
        "group/card relative w-full cursor-pointer rounded-lg border bg-card px-3 py-2.5 text-card-foreground shadow-xs/5 outline-none hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        props.selected && "ring-2 ring-ring ring-inset",
        isDragging && "opacity-40",
      )}
      data-testid="kanban-card"
    >
      {showHeader ? (
        <div className="flex h-4 items-center gap-1 text-muted-foreground text-xs">
          {show.has("id") ? <span className="shrink-0">{ticket.identifier}</span> : null}
          {ticket.parent !== null ? (
            <>
              {show.has("id") ? (
                <ChevronRightIcon aria-hidden className="size-3 shrink-0 opacity-70" />
              ) : null}
              <span className="min-w-0 truncate">
                {ticket.parent.identifier} {ticket.parent.title}
              </span>
            </>
          ) : null}
          {show.has("assignee") ? (
            <span className="ml-auto shrink-0 pl-2">
              <WithTooltip label={assignee === null ? "Unassigned" : assignee.name}>
                <KanbanAvatar person={assignee} size={16} />
              </WithTooltip>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={cn("flex items-start gap-1.5", showHeader ? "mt-1" : "pr-6")}>
        {show.has("status") ? (
          <span className="mt-0.5 flex shrink-0">
            <WithTooltip label={status.name}>
              <KanbanStatusIcon
                stateType={status.stateType}
                color={status.color}
                progress={status.progress}
              />
            </WithTooltip>
          </span>
        ) : null}
        <span className="line-clamp-2 min-w-0 font-medium text-sm leading-snug">
          {ticket.title}
        </span>
      </div>

      {chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">{chips}</div>
      ) : null}

      {dates.length > 0 || bots.length > 0 || threads.length > 0 ? (
        <div className="mt-2 flex h-5 items-center gap-2 text-2xs text-muted-foreground">
          <span className="min-w-0 truncate">{dates.join(" · ")}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <KanbanResponsibleBots bots={bots} />
            <KanbanThreadsBadge threads={threads} onOpenThread={props.onOpenThread} />
          </span>
        </div>
      ) : null}

      <span className="absolute top-1.5 right-1.5 rounded-md bg-card opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-data-popup-open:opacity-100">
        <KanbanTicketMenu
          ticket={ticket}
          canEdit={props.canEdit}
          linkableThreads={props.linkableThreads}
          onOpen={props.onOpen}
          onLinkThread={props.onLinkThread}
          onDelete={props.onDelete}
        />
      </span>
    </div>
  );
});
