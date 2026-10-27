import type { KanbanGroup } from "@t3tools/client-runtime/kanban-board";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { KanbanLookups } from "./kanbanLookups";
import { KanbanGroupIconView } from "./KanbanPrimitives";

/** Columns folded out of the board (empty or hidden), one row each; a row shows its column again. */
export function KanbanHiddenColumns(props: {
  readonly groups: ReadonlyArray<KanbanGroup>;
  readonly lookups: KanbanLookups;
  readonly onShow: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (props.groups.length === 0) return null;
  const Caret = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section className="flex w-full flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-8 cursor-pointer items-center gap-1.5 px-1.5 text-left font-medium text-sm hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <Caret aria-hidden className="size-3.5 text-muted-foreground" />
        Hidden columns
      </button>
      {open
        ? props.groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border bg-card px-3 text-left text-sm hover:bg-accent/50"
              onClick={() => props.onShow(group.id)}
            >
              <KanbanGroupIconView icon={group.icon} lookups={props.lookups} />
              <span className="min-w-0 flex-1 truncate">{group.title}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {group.tickets.length}
              </span>
            </button>
          ))
        : null}
    </section>
  );
}
