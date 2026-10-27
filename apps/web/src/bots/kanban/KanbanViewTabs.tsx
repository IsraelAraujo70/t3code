/**
 * Saved views as Linear-style tabs: select, rename, move, delete, drag to reorder, save the
 * active view's changes or save them as a new view, and import Linear's custom views.
 * Controlled: the page owns the views and runs every change.
 */
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  KANBAN_LIMITS,
  kanbanPersonBotId,
  type KanbanView,
  type KanbanViewId,
  type LinearAccountId,
} from "@t3tools/contracts";
import {
  BugIcon,
  CircleCheckIcon,
  ClockIcon,
  EllipsisIcon,
  EyeIcon,
  FlagIcon,
  FlameIcon,
  InboxIcon,
  LayersIcon,
  PlusIcon,
  RocketIcon,
  StarIcon,
  TargetIcon,
  UserRoundIcon,
  ZapIcon,
} from "lucide-react";
import { useRef, useState, type ReactElement } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { BotAvatar } from "../BotAvatar";
import { confirmDestructive } from "../botsSettingsShared";

export interface KanbanViewTabsProps {
  readonly views: ReadonlyArray<KanbanView>;
  readonly activeViewId: KanbanViewId | null;
  /** The active view's filters or display differ from what is saved. */
  readonly dirty: boolean;
  readonly canEdit: boolean;
  /** A view's filters in words, for its tooltip ("Assignee is Me"). */
  readonly lookupsDescribe: (view: KanbanView) => string;
  /** A bot's name for the marker on views a bot created or last saved. */
  readonly botName: (botId: string) => string;
  readonly onSelect: (id: KanbanViewId) => void;
  readonly onSaveChanges: () => void;
  readonly onDiscardChanges: () => void;
  readonly onSaveAs: (name: string, everywhere: boolean) => void;
  readonly onRename: (id: KanbanViewId, name: string) => void;
  readonly onDelete: (id: KanbanViewId) => void;
  readonly onReorder: (ids: KanbanViewId[]) => void;
  readonly linearAccounts: ReadonlyArray<{ readonly id: LinearAccountId; readonly name: string }>;
  readonly onImportLinear: (accountId: LinearAccountId) => void;
}

/** The icons a view can carry, by the Lucide name it stores (Linear's imported names included). */
const VIEW_ICONS: Readonly<Record<string, ReactElement>> = {
  Bug: <BugIcon aria-hidden />,
  CircleCheck: <CircleCheckIcon aria-hidden />,
  Clock: <ClockIcon aria-hidden />,
  Eye: <EyeIcon aria-hidden />,
  Flag: <FlagIcon aria-hidden />,
  Flame: <FlameIcon aria-hidden />,
  Inbox: <InboxIcon aria-hidden />,
  Layers: <LayersIcon aria-hidden />,
  Rocket: <RocketIcon aria-hidden />,
  Star: <StarIcon aria-hidden />,
  Target: <TargetIcon aria-hidden />,
  User: <UserRoundIcon aria-hidden />,
  Zap: <ZapIcon aria-hidden />,
};

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis];

const moved = (ids: ReadonlyArray<KanbanViewId>, from: number, to: number): KanbanViewId[] => {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  if (id !== undefined) next.splice(to, 0, id);
  return next;
};

function RenameInput(props: {
  readonly name: string;
  readonly onDone: (name: string | null) => void;
}) {
  const commit = (value: string) => {
    const name = value.trim();
    props.onDone(name === "" || name === props.name ? null : name);
  };
  return (
    <Input
      autoFocus
      size="sm"
      className="w-36"
      defaultValue={props.name}
      maxLength={KANBAN_LIMITS.viewName}
      aria-label="View name"
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing)
          commit(event.currentTarget.value);
        if (event.key === "Escape") props.onDone(null);
      }}
    />
  );
}

function ViewTab(props: {
  readonly view: KanbanView;
  readonly index: number;
  readonly count: number;
  readonly active: boolean;
  readonly canEdit: boolean;
  readonly description: string;
  readonly botName: (botId: string) => string;
  readonly onSelect: () => void;
  readonly onRename: (name: string) => void;
  readonly onMove: (to: number) => void;
  readonly onDelete: () => void;
}) {
  const { view, index, active, canEdit } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: view.id,
    disabled: !canEdit || renaming,
  });
  const icon = view.icon === null ? null : (VIEW_ICONS[view.icon] ?? null);
  const creatorBot = kanbanPersonBotId(view.createdBy);
  const editorBot = kanbanPersonBotId(view.updatedBy);
  const markerBot = editorBot ?? creatorBot;

  if (renaming)
    return (
      <RenameInput
        name={view.name}
        onDone={(name) => {
          setRenaming(false);
          if (name !== null) props.onRename(name);
        }}
      />
    );

  return (
    <div
      ref={(node) => {
        tabRef.current = node;
        setNodeRef(node);
      }}
      className={`group/tab flex shrink-0 items-center ${isDragging ? "z-10 opacity-80" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onContextMenu={(event) => {
        if (!canEdit) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
      {...listeners}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={active ? "secondary" : "ghost-muted"}
              size="xs"
              aria-pressed={active}
              onClick={props.onSelect}
              onDoubleClick={() => {
                if (canEdit) setRenaming(true);
              }}
            />
          }
        >
          {icon}
          {view.name}
          {markerBot === null ? null : <BotAvatar botId={markerBot} size={14} />}
        </TooltipTrigger>
        <TooltipPopup side="bottom" align="start">
          <div className="flex flex-col gap-0.5">
            <span>View {view.name}</span>
            {props.description ? (
              <span className="text-muted-foreground">{props.description}</span>
            ) : null}
            {creatorBot === null ? null : (
              <span className="text-muted-foreground">Created by {props.botName(creatorBot)}</span>
            )}
            {editorBot === null ? null : (
              <span className="text-muted-foreground">
                Last edited by {props.botName(editorBot)}
              </span>
            )}
          </div>
        </TooltipPopup>
      </Tooltip>
      {canEdit ? (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <span className={menuOpen ? "flex" : active ? "hidden group-hover/tab:flex" : "hidden"}>
            <MenuTrigger
              render={
                <Button variant="ghost-muted" size="icon-xs" aria-label={`${view.name} options`} />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
          </span>
          <MenuPopup align="start" anchor={tabRef}>
            <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
            <MenuItem disabled={index === 0} onClick={() => props.onMove(index - 1)}>
              Move left
            </MenuItem>
            <MenuItem disabled={index === props.count - 1} onClick={() => props.onMove(index + 1)}>
              Move right
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onDelete}>
              Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

function SaveAsPopover(props: { readonly onSaveAs: (name: string, everywhere: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setName("");
      setEverywhere(false);
    }
  };
  const save = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    props.onSaveAs(trimmed, everywhere);
    onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="icon-xs" aria-label="Save as new view" />}
      >
        <PlusIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" width="sm" padding="compact">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <span className="font-medium text-sm">Save as new view</span>
          <Input
            autoFocus
            size="sm"
            value={name}
            maxLength={KANBAN_LIMITS.viewName}
            placeholder="View name"
            aria-label="View name"
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <label className="flex items-center justify-between gap-2 text-muted-foreground text-sm">
            Show on every board
            <Switch size="sm" checked={everywhere} onCheckedChange={setEverywhere} />
          </label>
          <div className="flex justify-end">
            <Button type="submit" size="xs" disabled={name.trim() === ""}>
              Save view
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

export function KanbanViewTabs(props: KanbanViewTabsProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const ids = props.views.map((view) => view.id);
  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= ids.length) return;
    props.onReorder(moved(ids, from, to));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    reorder(
      ids.findIndex((id) => id === active.id),
      ids.findIndex((id) => id === over.id),
    );
  };
  const remove = async (view: KanbanView) => {
    if (
      await confirmDestructive(`Delete the view "${view.name}"?\nIts filters and display are lost.`)
    )
      props.onDelete(view.id);
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={TAB_DRAG_MODIFIERS}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
            {props.views.map((view, index) => (
              <ViewTab
                key={view.id}
                view={view}
                index={index}
                count={props.views.length}
                active={view.id === props.activeViewId}
                canEdit={props.canEdit}
                description={props.lookupsDescribe(view)}
                botName={props.botName}
                onSelect={() => props.onSelect(view.id)}
                onRename={(name) => props.onRename(view.id, name)}
                onMove={(to) => reorder(index, to)}
                onDelete={() => void remove(view)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      {props.dirty && props.activeViewId !== null ? (
        <>
          {props.canEdit ? (
            <Button variant="outline" size="xs" onClick={props.onSaveChanges}>
              Save
            </Button>
          ) : null}
          <Button variant="ghost-muted" size="xs" onClick={props.onDiscardChanges}>
            Reset
          </Button>
        </>
      ) : null}
      {props.canEdit ? <SaveAsPopover onSaveAs={props.onSaveAs} /> : null}
      {props.canEdit && props.linearAccounts.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost-muted" size="icon-xs" aria-label="More view actions" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuSub>
              <MenuSubTrigger>Import views from Linear</MenuSubTrigger>
              <MenuSubPopup>
                {props.linearAccounts.map((account) => (
                  <MenuItem key={account.id} onClick={() => props.onImportLinear(account.id)}>
                    {account.name}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
