import { useDraggable } from "@dnd-kit/core";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotThreadShell } from "@t3tools/client-runtime/bot-directory";
import type { BotDirectoryEntry, EnvironmentId, KanbanTicket, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, LinkIcon, MoreHorizontalIcon, Trash2Icon, XIcon } from "lucide-react";

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
import { buildThreadRouteParams } from "../../threadRoutes";
import { BotAvatar } from "../BotAvatar";
import {
  THREAD_CARD_STATUS_LABELS,
  threadCardStatus,
  type ThreadCardStatus,
} from "@t3tools/client-runtime/kanban-board";

const STATUS_DOT: Record<ThreadCardStatus, string> = {
  approval: "bg-amber-500 dark:bg-amber-300/90",
  input: "bg-indigo-500 dark:bg-indigo-300/90",
  failed: "bg-red-500 dark:bg-red-400/90",
  working: "bg-sky-500 dark:bg-sky-300/90",
  settled: "bg-emerald-500 dark:bg-emerald-400/80",
};

const PRIORITY_LABELS = ["", "Urgent", "High", "Medium", "Low"];

export interface KanbanThreadOption {
  readonly id: ThreadId;
  readonly title: string;
}

/** One ticket: identifier and title, the workspace's bots, and its threads with their status. */
export function KanbanCard(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
  readonly projectTitle: string | null;
  readonly threadsById: ReadonlyMap<string, BotThreadShell & { readonly title: string }>;
  /** Threads of the ticket's project that are not linked yet, newest first. */
  readonly linkableThreads: ReadonlyArray<KanbanThreadOption>;
  readonly canEdit: boolean;
  readonly onLinkThread: (threadId: ThreadId) => void;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
  readonly onDelete: () => void;
}) {
  const { ticket } = props;
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: ticket.id,
    disabled: !props.canEdit,
  });
  // Threads deleted since they were linked are not shown.
  const threads = ticket.threadIds.flatMap((threadId) => {
    const shell = props.threadsById.get(threadId);
    return shell === undefined ? [] : [shell];
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "rounded-lg border bg-card p-2.5 text-card-foreground shadow-xs/5",
        props.canEdit && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
      data-testid="kanban-card"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="font-mono">{ticket.identifier}</span>
            {ticket.priority > 0 ? <span>· {PRIORITY_LABELS[ticket.priority]}</span> : null}
            {props.projectTitle ? <span className="truncate">· {props.projectTitle}</span> : null}
          </div>
          <div className="mt-0.5 text-sm leading-snug">{ticket.title}</div>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Actions for ${ticket.identifier}`}
                // Opening the menu must not start a drag.
                onPointerDown={(event) => event.stopPropagation()}
              >
                <MoreHorizontalIcon />
              </Button>
            }
          />
          <MenuPopup align="end">
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
      </div>

      {threads.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {threads.map((thread) => {
            const status = threadCardStatus(thread);
            return (
              <li key={thread.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(props.environmentId, thread.id),
                      ),
                    })
                  }
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
                  <span className="truncate">{thread.title}</span>
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                    {THREAD_CARD_STATUS_LABELS[status]}
                  </span>
                </button>
                {props.canEdit ? (
                  <Button
                    size="icon-tiny"
                    variant="ghost-muted"
                    aria-label={`Unlink ${thread.title}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => props.onUnlinkThread(thread.id)}
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {props.bots.length > 0 || ticket.assigneeName ? (
        <div className="mt-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
          {props.bots.map((bot) => (
            <Tooltip key={bot.id}>
              <TooltipTrigger
                render={
                  <span className="flex items-center gap-1">
                    <BotAvatar botId={bot.id} size={14} />
                    {props.bots.length === 1 ? bot.name : null}
                  </span>
                }
              />
              <TooltipPopup side="top">{bot.name} is responsible</TooltipPopup>
            </Tooltip>
          ))}
          {ticket.assigneeName ? (
            <span className="ml-auto truncate">{ticket.assigneeName}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
