import { type KanbanLookups } from "@t3tools/client-runtime/kanban-display";
import type { KanbanGroupIcon } from "@t3tools/client-runtime/kanban-board";
import { EyeOffIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { KanbanGroupIconView } from "./KanbanPrimitives";

/** A column's title row: icon, name, muted count, and its menu and add button. */
export function KanbanColumnHeader(props: {
  readonly icon: KanbanGroupIcon;
  readonly title: string;
  readonly count: number;
  readonly lookups: KanbanLookups;
  readonly onHide?: () => void;
  readonly onAdd?: () => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2 px-1.5">
      <KanbanGroupIconView icon={props.icon} lookups={props.lookups} />
      <span className="min-w-0 truncate font-medium text-sm">{props.title}</span>
      <span className="shrink-0 text-muted-foreground text-sm tabular-nums">{props.count}</span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {props.onHide ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Actions for ${props.title}`}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={props.onHide}>
                <EyeOffIcon />
                Hide column
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {props.onAdd ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`New ticket in ${props.title}`}
            onClick={props.onAdd}
          >
            <PlusIcon />
          </Button>
        ) : null}
      </span>
    </div>
  );
}
