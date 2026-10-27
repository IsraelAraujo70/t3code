import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type {
  KanbanDropAction,
  KanbanGroup,
  KanbanSwimlane,
  KanbanViewResult,
} from "@t3tools/client-runtime/kanban-board";
import {
  KanbanTicketTitle,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanViewConfig,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Input } from "../../components/ui/input";
import { KanbanCard, type KanbanTicketViewProps } from "./KanbanCard";
import { KanbanColumnHeader } from "./KanbanColumnHeader";
import { KanbanHiddenColumns } from "./KanbanHiddenColumns";
import type { KanbanLookups } from "./kanbanLookups";
import { cellDropActions } from "./kanbanPageState";
import { KanbanGroupIconView } from "./KanbanPrimitives";

const isTitle = Schema.is(KanbanTicketTitle);

/** What the board and the list both take. */
export interface KanbanLayoutProps {
  readonly view: KanbanViewResult;
  readonly lookups: KanbanLookups;
  /** A stable props object per ticket, so memoized cards skip unrelated renders. */
  readonly ticketProps: (ticket: KanbanTicket) => KanbanTicketViewProps;
  /** Whether a group offers "+" to create a ticket in it. */
  readonly canAddTo: (group: KanbanGroup) => boolean;
  readonly onCreate: (group: KanbanGroup, title: string) => Promise<boolean>;
}

/** An inline title field for a new ticket; Enter creates, Esc or an empty blur cancels. */
export function KanbanNewTicketInput(props: {
  readonly onCreate: (title: string) => Promise<boolean>;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const title = draft.trim();
    if (!isTitle(title) || saving) return;
    setSaving(true);
    const ok = await props.onCreate(title);
    setSaving(false);
    if (ok) props.onDone();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        size="sm"
        placeholder="Ticket title"
        aria-label="New ticket title"
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onDone();
        }}
        onBlur={() => {
          if (draft.trim() === "" && !saving) props.onDone();
        }}
      />
    </form>
  );
}

interface DropCell {
  readonly column: KanbanGroup;
  readonly lane: KanbanSwimlane | null;
}

const cellId = (laneIndex: number | null, columnIndex: number) =>
  laneIndex === null ? `c:${columnIndex}` : `l:${laneIndex}:${columnIndex}`;

function cellOf(view: KanbanViewResult, id: string): DropCell | null {
  const [kind, first, second] = id.split(":");
  if (kind === "c") {
    const column = view.columns[Number(first)];
    return column === undefined ? null : { column, lane: null };
  }
  const lane = view.swimlanes?.[Number(first)];
  const column = view.columns[Number(second)];
  return lane === undefined || column === undefined ? null : { column, lane };
}

/**
 * The board layout: fixed-width columns that scroll on their own, or swimlanes of cells aligned
 * under the column headers. Cards drag between cells; a drop changes what the cell groups by.
 */
export function KanbanBoard(
  props: KanbanLayoutProps & {
    readonly snapshot: KanbanSnapshot;
    readonly config: Pick<KanbanViewConfig, "groupBy" | "subGroupBy">;
    readonly onHideColumn: (groupId: string) => void;
    readonly onShowColumn: (groupId: string) => void;
    readonly onDrop: (ticket: KanbanTicket, actions: ReadonlyArray<KanbanDropAction>) => void;
  },
) {
  const { view, snapshot, config } = props;
  const [dragging, setDragging] = useState<KanbanTicket | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(new Set());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const accepts = (cell: DropCell) =>
    dragging !== null &&
    cellDropActions(snapshot, dragging, config, cell.column, cell.lane).length > 0;

  const onDragStart = (event: DragStartEvent) => {
    setDragging(snapshot.tickets.find((ticket) => ticket.id === event.active.id) ?? null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const ticket = snapshot.tickets.find((candidate) => candidate.id === event.active.id);
    const cell = event.over === null ? null : cellOf(view, String(event.over.id));
    if (ticket === undefined || cell === null) return;
    const actions = cellDropActions(snapshot, ticket, config, cell.column, cell.lane);
    if (actions.length > 0) props.onDrop(ticket, actions);
  };

  const header = (column: KanbanGroup) => (
    <>
      <KanbanColumnHeader
        icon={column.icon}
        title={column.title}
        count={column.tickets.length}
        lookups={props.lookups}
        onHide={() => props.onHideColumn(column.id)}
        {...(props.canAddTo(column) ? { onAdd: () => setAdding(column.id) } : {})}
      />
      {adding === column.id ? (
        <div className="px-0.5 pb-2">
          <KanbanNewTicketInput
            onCreate={(title) => props.onCreate(column, title)}
            onDone={() => setAdding(null)}
          />
        </div>
      ) : null}
    </>
  );
  const cards = (tickets: ReadonlyArray<KanbanTicket>) =>
    tickets.map((ticket) => <KanbanCard key={ticket.id} {...props.ticketProps(ticket)} />);
  const hidden =
    view.hiddenColumns.length > 0 ? (
      <div className="w-64 shrink-0">
        <KanbanHiddenColumns
          groups={view.hiddenColumns}
          lookups={props.lookups}
          onShow={props.onShowColumn}
        />
      </div>
    ) : null;

  return (
    <DndContext
      sensors={sensors}
      // The cell under the pointer takes the card, not the one the wide card overlaps most.
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {view.swimlanes === null ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-(--workspace-gutter-start) pb-4">
          {view.columns.map((column, index) => (
            <section
              key={column.id}
              aria-label={column.title}
              className="flex w-80 shrink-0 flex-col rounded-xl bg-muted/30 p-1.5"
            >
              {header(column)}
              <DropZone
                id={cellId(null, index)}
                dragging={dragging !== null}
                accepts={accepts({ column, lane: null })}
                className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto"
              >
                {cards(column.tickets)}
              </DropZone>
            </section>
          ))}
          {hidden}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-(--workspace-gutter-start) pb-4">
          <div className="flex w-max flex-col gap-1">
            <div className="sticky top-0 z-10 flex gap-3 bg-background">
              {view.columns.map((column) => (
                <div key={column.id} className="w-80 shrink-0">
                  {header(column)}
                </div>
              ))}
              {hidden}
            </div>
            {view.swimlanes.map((lane, laneIndex) => {
              const collapsed = collapsedLanes.has(lane.id);
              const Caret = collapsed ? ChevronRightIcon : ChevronDownIcon;
              return (
                <section key={lane.id} aria-label={lane.title} className="flex flex-col gap-1">
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    className="sticky left-0 flex h-8 w-fit cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent/50"
                    onClick={() =>
                      setCollapsedLanes((current) => {
                        const next = new Set(current);
                        if (!next.delete(lane.id)) next.add(lane.id);
                        return next;
                      })
                    }
                  >
                    <Caret aria-hidden className="size-3.5 text-muted-foreground" />
                    <KanbanGroupIconView icon={lane.icon} lookups={props.lookups} />
                    <span className="font-medium">{lane.title}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {lane.tickets.length}
                    </span>
                  </button>
                  {collapsed ? null : (
                    <div className="flex gap-3">
                      {view.columns.map((column, columnIndex) => (
                        <DropZone
                          key={column.id}
                          id={cellId(laneIndex, columnIndex)}
                          dragging={dragging !== null}
                          accepts={accepts({ column, lane })}
                          className="flex min-h-12 w-80 shrink-0 flex-col gap-2 rounded-xl bg-muted/30 p-1.5"
                        >
                          {cards(lane.cells.get(column.id) ?? [])}
                        </DropZone>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
      <DragOverlay>
        {dragging ? (
          <div className="w-80 rounded-lg border bg-card px-3 py-2.5 text-sm shadow-lg">
            <div className="text-muted-foreground text-xs">{dragging.identifier}</div>
            <div className="line-clamp-2 font-medium">{dragging.title}</div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DropZone(props: {
  readonly id: string;
  readonly dragging: boolean;
  readonly accepts: boolean;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.id, disabled: !props.accepts });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        props.className,
        props.dragging && !props.accepts && "opacity-50",
        isOver && props.accepts && "ring-2 ring-ring ring-inset",
      )}
    >
      {props.children}
    </div>
  );
}
