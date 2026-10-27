import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  formatKanbanDate,
  KanbanLabelList,
  KanbanTicketMenu,
  responsibleBots,
  ticketLabels,
  ticketOpenHandlers,
  type KanbanTicketViewProps,
} from "./KanbanCard";
import { personDisplay, ticketStatusDisplay } from "./kanbanLookups";
import {
  KanbanAvatar,
  KanbanChip,
  KanbanPriorityIcon,
  KanbanPullRequestBadge,
  KanbanResponsibleBots,
  KanbanStatusIcon,
  KanbanSwatch,
  KanbanThreadsBadge,
} from "./KanbanPrimitives";

/** One ticket as a dense list line: priority, identifier, status, title, then its properties. */
export const KanbanListRow = memo(function KanbanListRow(props: KanbanTicketViewProps) {
  const { ticket, lookups, properties: show } = props;
  const status = ticketStatusDisplay(lookups, ticket);
  const linearProject =
    ticket.linearProjectId === null ? undefined : lookups.projectsById.get(ticket.linearProjectId);
  const labels = show.has("labels") ? ticketLabels(ticket, lookups) : [];

  return (
    <div
      role="button"
      tabIndex={0}
      {...ticketOpenHandlers(props.onOpen)}
      className={cn(
        "group/row flex h-9 w-full cursor-pointer items-center gap-2 border-b px-3 text-sm outline-none hover:bg-accent/50 focus-visible:bg-accent/50",
        props.selected && "bg-accent",
      )}
      data-testid="kanban-list-row"
    >
      {show.has("priority") ? <KanbanPriorityIcon priority={ticket.priority} /> : null}
      {show.has("id") ? (
        <span className="w-16 shrink-0 truncate text-muted-foreground text-xs">
          {ticket.identifier}
        </span>
      ) : null}
      {show.has("status") ? (
        <KanbanStatusIcon
          stateType={status.stateType}
          color={status.color}
          progress={status.progress}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate font-medium">{ticket.title}</span>
        {ticket.parent !== null ? (
          <span className="min-w-0 shrink-[4] truncate text-muted-foreground text-xs">
            › {ticket.parent.identifier} {ticket.parent.title}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {labels.length > 0 ? <KanbanLabelList labels={labels} max={2} /> : null}
        {show.has("pullRequests") ? (
          <KanbanPullRequestBadge pullRequests={ticket.pullRequests} />
        ) : null}
        {show.has("project") && linearProject !== undefined ? (
          <KanbanChip className="max-w-36">
            <KanbanSwatch color={linearProject.color} shape="square" size={9} />
            <span className="truncate">{linearProject.name}</span>
          </KanbanChip>
        ) : null}
        {show.has("project") && props.projectTitle !== null ? (
          <KanbanChip className="max-w-36">
            <span className="truncate">{props.projectTitle}</span>
          </KanbanChip>
        ) : null}
        {show.has("threads") ? (
          <KanbanThreadsBadge threads={props.threads} onOpenThread={props.onOpenThread} />
        ) : null}
        {show.has("bot") ? (
          <KanbanResponsibleBots bots={responsibleBots(ticket, lookups, props.workspaceBots)} />
        ) : null}
        {show.has("assignee") ? (
          <KanbanAvatar
            person={ticket.assigneeId === null ? null : personDisplay(lookups, ticket.assigneeId)}
          />
        ) : null}
        {show.has("created") ? (
          <span className="w-12 text-right text-2xs text-muted-foreground">
            {formatKanbanDate(new Date(ticket.createdAt))}
          </span>
        ) : null}
        <span className="opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100">
          <KanbanTicketMenu
            ticket={ticket}
            canEdit={props.canEdit}
            threads={props.threads}
            linkableThreads={props.linkableThreads}
            onOpen={props.onOpen}
            onLinkThread={props.onLinkThread}
            onUnlinkThread={props.onUnlinkThread}
            onDelete={props.onDelete}
          />
        </span>
      </span>
    </div>
  );
});
