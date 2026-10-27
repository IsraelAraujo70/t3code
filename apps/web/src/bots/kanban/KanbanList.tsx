import { LegendList } from "@legendapp/list/react";
import type { KanbanGroup } from "@t3tools/client-runtime/kanban-board";
import type { KanbanTicket } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { KanbanNewTicketInput, type KanbanLayoutProps } from "./KanbanBoard";
import { KanbanListRow } from "./KanbanListRow";
import { KanbanGroupIconView } from "./KanbanPrimitives";

type ListItem =
  | { readonly kind: "header"; readonly key: string; readonly group: KanbanGroup }
  | { readonly kind: "new"; readonly key: string; readonly group: KanbanGroup }
  | { readonly kind: "row"; readonly key: string; readonly ticket: KanbanTicket };

const ROW_HEIGHT = 36;

/**
 * The list layout: one collapsible section per group, rows virtualized so a long board scrolls
 * smoothly. Hidden columns stay out, as on the board.
 */
export function KanbanList(props: KanbanLayoutProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const items: ListItem[] = [];
  for (const group of props.view.columns) {
    items.push({ kind: "header", key: `h:${group.id}`, group });
    if (collapsed.has(group.id)) continue;
    if (adding === group.id) items.push({ kind: "new", key: `n:${group.id}`, group });
    for (const ticket of group.tickets) {
      items.push({ kind: "row", key: `r:${group.id}:${ticket.id}`, ticket });
    }
  }

  const toggle = (groupId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });

  if (items.length === 0) {
    return (
      <p className="px-(--workspace-gutter-start) py-4 text-muted-foreground text-sm">
        No tickets match this view.
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1">
      <LegendList<ListItem>
        data={items}
        extraData={props.ticketProps}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        estimatedItemSize={ROW_HEIGHT}
        drawDistance={720}
        className="h-full"
        renderItem={({ item }) => {
          switch (item.kind) {
            case "row":
              return <KanbanListRow {...props.ticketProps(item.ticket)} />;
            case "new":
              return (
                <div className="border-b px-3 py-1.5">
                  <KanbanNewTicketInput
                    onCreate={(title) => props.onCreate(item.group, title)}
                    onDone={() => setAdding(null)}
                  />
                </div>
              );
            case "header": {
              const open = !collapsed.has(item.group.id);
              const Caret = open ? ChevronDownIcon : ChevronRightIcon;
              return (
                <div className="flex h-9 items-center gap-2 border-b bg-muted/40 pr-2 pl-3 text-sm">
                  <button
                    type="button"
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    onClick={() => toggle(item.group.id)}
                  >
                    <Caret aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <KanbanGroupIconView icon={item.group.icon} lookups={props.lookups} />
                    <span className="truncate font-medium">{item.group.title}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {item.group.tickets.length}
                    </span>
                  </button>
                  {props.canAddTo(item.group) ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`New ticket in ${item.group.title}`}
                      onClick={() => {
                        setCollapsed((current) => {
                          const next = new Set(current);
                          next.delete(item.group.id);
                          return next;
                        });
                        setAdding(item.group.id);
                      }}
                    >
                      <PlusIcon />
                    </Button>
                  ) : null}
                </div>
              );
            }
          }
        }}
      />
    </div>
  );
}
