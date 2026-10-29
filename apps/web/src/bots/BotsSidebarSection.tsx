import {
  closestCenter,
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import {
  BOT_LIMITS,
  BotId,
  BotSectionId,
  parseBotThreadId,
  type BotDirectory,
  type BotsArrangeInput,
  type BotSection,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { readLocalApi } from "../localApi";
import { botsEnvironment, useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "~/lib/utils";
import { BotAvatar } from "./BotAvatar";
import {
  applyArrangement,
  botGroupKey,
  countBotsNeedingYou,
  DEFAULT_BOT_GROUP,
  currentArrangement,
  groupBotRows,
  moveBot,
  moveSection,
  resolveBotRows,
  type BotGroup,
  type BotRowModel,
  type BotThreadShell,
} from "@t3tools/client-runtime/bot-directory";
import { confirmDestructive, useRestartBotSession } from "./botsSettingsShared";

const BOTS_SECTION_EXPANDED_KEY = "t3code:bots:bots-section-expanded";
const BOTS_TAB_KEY = "t3code:bots:sidebar-tab";
const COLLAPSED_GROUPS_KEY = "t3code:bots:collapsed-groups";
const SidebarBotsTab = Schema.Literals(["bots", "threads"]);
type SidebarBotsTab = typeof SidebarBotsTab.Type;
const CollapsedGroups = Schema.Array(Schema.String);

/** A bot's main conversation is a `bot:<botId>:<generation>` thread; thread lists skip it. */
export function isBotThreadId(threadId: string): boolean {
  return parseBotThreadId(threadId) !== null;
}

/** The selected sidebar tab in the "tabs" layout, kept per device. */
export function useSidebarBotsTab() {
  return useLocalStorage<SidebarBotsTab, SidebarBotsTab>(BOTS_TAB_KEY, "bots", SidebarBotsTab);
}

/**
 * The bots host environment's directory and its bots matched to their main thread shells.
 * `rows` is null until the directory loads; `environmentId` is null when no connected environment
 * hosts bots. The section and the tabs both call this; they share one directory subscription.
 */
function useBotRows(threads: ReadonlyArray<BotThreadShell>): {
  readonly environmentId: EnvironmentId | null;
  readonly directory: BotDirectory | null;
  readonly rows: ReadonlyArray<BotRowModel> | null;
  readonly error: string | null;
} {
  const environmentId = useBotsEnvironmentId();
  const { directory, error } = useBotDirectory(environmentId);
  const rows =
    environmentId === null || directory === null
      ? null
      : resolveBotRows(directory.bots, environmentId, threads);
  return { environmentId, directory, rows, error };
}

function countRowsNeedingYou(rows: ReadonlyArray<BotRowModel> | null): number {
  return rows === null ? 0 : countBotsNeedingYou(rows.map((row) => row.status));
}

function compactTimeLabel(isoDate: string): string {
  const label = formatRelativeTimeLabel(isoDate);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function useOpenBotsSettings() {
  const navigate = useNavigate();
  return () => void navigate({ to: "/settings/bots" });
}

/** A small dot on the avatar's corner: blue while working, amber for an unseen reply. */
function StatusDot(props: { row: BotRowModel }) {
  const { status } = props.row;
  const tone =
    status.kind === "working"
      ? "bg-primary"
      : status.kind === "needs-you" && status.attention === "unseen"
        ? "bg-warning"
        : null;
  if (tone === null) return null;
  return (
    <span
      aria-label={status.kind === "working" ? "Working" : "New reply"}
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
        tone,
      )}
    />
  );
}

function BotRow(props: {
  row: BotRowModel;
  selected: boolean;
  draggable: boolean;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const { bot, status, activityAt, preview } = props.row;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `bot:${bot.id}`,
    disabled: !props.draggable,
  });
  const timeLabel =
    status.kind === "working" || activityAt === null ? "" : compactTimeLabel(activityAt);
  const settled = status.kind === "settled";
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 opacity-80")}
      {...attributes}
      {...listeners}
      role={undefined}
      tabIndex={undefined}
    >
      <button
        type="button"
        onClick={props.onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "group/bot flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          props.selected ? "bg-sidebar-row-selected" : "hover:bg-sidebar-row-hover",
        )}
      >
        <span className={cn("relative flex shrink-0", settled && "opacity-50")}>
          <BotAvatar
            botId={bot.id}
            size={34}
            alert={status.kind === "needs-you" && status.attention === "request"}
          />
          <StatusDot row={props.row} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium",
                settled ? "text-sidebar-muted-foreground" : "text-sidebar-foreground",
              )}
            >
              {bot.name}
            </span>
            {timeLabel !== "" ? (
              <span className="shrink-0 text-2xs text-sidebar-muted-foreground">{timeLabel}</span>
            ) : null}
          </span>
          {preview !== null ? (
            <span
              className={cn(
                "block truncate text-xs",
                status.kind === "needs-you" && status.attention === "request"
                  ? "text-warning-foreground"
                  : "text-sidebar-muted-foreground",
                settled && "opacity-70",
              )}
            >
              {preview}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function BotsNotice(props: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground">{props.children}</p>;
}

/** A one-line name field for creating or renaming a section; Enter saves, Escape cancels. */
function SectionNameInput(props: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const submit = () => {
    const name = value.trim();
    if (name === "" || name === props.initial) props.onCancel();
    else props.onSubmit(name);
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={BOT_LIMITS.sectionName}
      placeholder="Section name"
      aria-label="Section name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={submit}
      onKeyDown={(event) => {
        if (event.key === "Enter") submit();
        if (event.key === "Escape") props.onCancel();
      }}
      className="h-6 w-full min-w-0 rounded border border-sidebar-border bg-transparent px-1.5 text-xs text-sidebar-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-ring/70"
    />
  );
}

function GroupHeader(props: {
  group: BotGroup;
  collapsed: boolean;
  draggable: boolean;
  renaming: boolean;
  onToggle: () => void;
  onMenu: (position: { x: number; y: number }) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const { section } = props.group;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: `section:${botGroupKey(section)}`,
    disabled: !props.draggable || section === null,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="flex h-7 items-center gap-1 px-2"
      {...attributes}
      {...listeners}
      role={undefined}
      tabIndex={undefined}
    >
      {props.renaming && section !== null ? (
        <SectionNameInput
          initial={section.name}
          onSubmit={props.onRename}
          onCancel={props.onCancelRename}
        />
      ) : (
        <button
          type="button"
          onClick={props.onToggle}
          onContextMenu={(event) => {
            if (section === null) return;
            event.preventDefault();
            props.onMenu({ x: event.clientX, y: event.clientY });
          }}
          aria-expanded={!props.collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-xs font-medium text-sidebar-muted-foreground hover:text-sidebar-foreground"
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", !props.collapsed && "rotate-90")}
          />
          <span className="truncate">{section?.name ?? "Bots"}</span>
          {props.collapsed && props.group.rows.length > 0 ? (
            <span className="text-2xs font-normal">{props.group.rows.length}</span>
          ) : null}
        </button>
      )}
    </div>
  );
}

/** The rows of one group, droppable as a whole so an empty or collapsed group takes a bot. */
function GroupBody(props: { group: BotGroup; collapsed: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${botGroupKey(props.group.section)}` });
  return (
    <ul
      ref={setNodeRef}
      className={cn("flex min-h-1 flex-col gap-px rounded-lg", isOver && "bg-sidebar-row-hover/50")}
    >
      {props.collapsed ? null : props.group.rows.length === 0 ? (
        <li className="px-2 py-1 text-2xs text-sidebar-muted-foreground">Drag bots here</li>
      ) : (
        props.children
      )}
    </ul>
  );
}

type Creating = { readonly moveBot: BotId | null };

/** Bot dock and section management share the existing bot commands. */
export function BotsSidebarSection(props: {
  collapsible: boolean;
  threads: ReadonlyArray<BotThreadShell>;
  activeThreadRef: ScopedThreadRef | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [storedExpanded, setExpanded] = useLocalStorage(
    BOTS_SECTION_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage(
    COLLAPSED_GROUPS_KEY,
    [],
    CollapsedGroups,
  );
  const { environmentId, directory, rows: liveRows, error } = useBotRows(props.threads);
  const openBotsSettings = useOpenBotsSettings();
  const { settleThread, unsettleThread } = useThreadActions();
  const arrange = useAtomCommand(botsEnvironment.arrange, { label: "bots arrange" });
  const createSection = useAtomCommand(botsEnvironment.createSection, {
    label: "bot section create",
  });
  const renameSection = useAtomCommand(botsEnvironment.renameSection, {
    label: "bot section rename",
  });
  const deleteSection = useAtomCommand(botsEnvironment.deleteSection, {
    label: "bot section delete",
  });
  const canArrange = useAtomValue(botsEnvironment.arrange.permissionAtom(environmentId));
  const canRestart = useAtomValue(botsEnvironment.restartSession.permissionAtom(environmentId));
  const restartSession = useRestartBotSession();
  const canEditSections = useAtomValue(botsEnvironment.createSection.permissionAtom(environmentId));
  // A move shows at once and holds until the server's next directory replaces it: it is kept
  // with the directory it was made from and ignored once another one arrives.
  const [pendingMove, setPendingMove] = useState<{
    readonly from: BotDirectory;
    readonly arrangement: BotsArrangeInput;
  } | null>(null);
  const pending =
    pendingMove !== null && pendingMove.from === directory ? pendingMove.arrangement : null;
  const [creating, setCreating] = useState<Creating | null>(null);
  const [manageDock, setManageDock] = useState(false);
  const [renamingId, setRenamingId] = useState<BotSectionId | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // Re-renders the relative times once a minute.
  useNowMinute();

  const shown =
    directory === null ? null : applyArrangement(directory.sections, directory.bots, pending);
  const rows =
    shown === null || environmentId === null || liveRows === null
      ? null
      : resolveBotRows(shown.bots, environmentId, props.threads);
  const groups = shown === null || rows === null ? [] : groupBotRows(shown.sections, rows);
  const needsYou = countRowsNeedingYou(liveRows);
  const expanded = !props.collapsible || storedExpanded;
  const activeThreadRef = props.activeThreadRef;

  const applyMove = async (next: BotsArrangeInput) => {
    if (environmentId === null || directory === null) return;
    setPendingMove({ from: directory, arrangement: next });
    const result = await arrange({ environmentId, input: next });
    if (result._tag === "Failure") setPendingMove(null);
  };

  const baseArrangement = () =>
    pending ?? (directory === null ? null : currentArrangement(directory.sections, directory.bots));

  const sectionOfBot = (botId: string): BotSectionId | null =>
    shown?.bots.find((bot) => bot.id === botId)?.sectionId ?? null;

  const handleDragEnd = (event: DragEndEvent) => {
    const base = baseArrangement();
    const over = event.over === null ? null : String(event.over.id);
    const active = String(event.active.id);
    if (base === null || over === null || active === over) return;
    const [activeKind, activeId] = splitDragId(active);
    const [overKind, overId] = splitDragId(over);
    const overSection: BotSectionId | null =
      overKind === "bot"
        ? sectionOfBot(overId)
        : overId === DEFAULT_BOT_GROUP
          ? null
          : BotSectionId.make(overId);
    if (activeKind === "section") {
      if (overSection !== null) {
        void applyMove(moveSection(base, BotSectionId.make(activeId), overSection));
      }
      return;
    }
    if (overKind !== "bot") {
      void applyMove(moveBot(base, BotId.make(activeId), overSection, null));
      return;
    }
    // Within one section, dragging down lands after the target, as in any sortable list.
    const sameSection = base.bots.filter((bot) => bot.sectionId === overSection);
    const from = sameSection.findIndex((bot) => bot.botId === activeId);
    const to = sameSection.findIndex((bot) => bot.botId === overId);
    const before =
      from !== -1 && from < to ? (sameSection[to + 1]?.botId ?? null) : BotId.make(overId);
    void applyMove(moveBot(base, BotId.make(activeId), overSection, before));
  };

  const submitNewSection = async (name: string) => {
    const moving = creating?.moveBot ?? null;
    setCreating(null);
    if (environmentId === null) return;
    const result = await createSection({ environmentId, input: { name } });
    if (result._tag !== "Success" || moving === null) return;
    const base = baseArrangement();
    if (base === null) return;
    void applyMove(
      moveBot(
        { ...base, sectionIds: [...base.sectionIds, result.value.id] },
        moving,
        result.value.id,
        null,
      ),
    );
  };

  const showBotMenu = async (row: BotRowModel, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || shown === null) return;
    const current = row.bot.sectionId;
    const targets = [
      ...shown.sections.map((section) => ({ id: section.id as string, label: section.name })),
      { id: DEFAULT_BOT_GROUP, label: "Bots (no section)" },
    ];
    const clicked = await api.contextMenu.show(
      [
        row.status.kind === "settled"
          ? { id: "reopen", label: "Reopen" }
          : { id: "settle", label: "Settle", disabled: row.status.kind === "working" },
        {
          id: "restart",
          label: "Restart session",
          // Cutting a running turn short would lose its work; the server refuses it too.
          disabled: !canRestart || row.status.kind === "working",
        },
        {
          id: "move",
          label: "Move to",
          disabled: !canArrange,
          children: [
            ...targets.map((target) => ({
              id: `move:${target.id}`,
              label: target.label,
              checked: (current ?? DEFAULT_BOT_GROUP) === target.id,
            })),
            {
              id: "move:new",
              label: "New section…",
              separatorBefore: true,
              disabled: !canEditSections,
            },
          ],
        },
      ],
      position,
    );
    if (clicked === null) return;
    if (clicked === "settle") void settleThread(row.threadRef);
    else if (clicked === "reopen") void unsettleThread(row.threadRef);
    else if (clicked === "restart") {
      if (environmentId !== null) void restartSession(environmentId, row.bot);
    } else if (clicked === "move:new") setCreating({ moveBot: row.bot.id });
    else if (clicked.startsWith("move:")) {
      const target = clicked.slice("move:".length);
      const base = baseArrangement();
      if (base === null) return;
      const sectionId = target === DEFAULT_BOT_GROUP ? null : BotSectionId.make(target);
      if (sectionId !== current) void applyMove(moveBot(base, row.bot.id, sectionId, null));
    }
  };

  const showSectionMenu = async (section: BotSection, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || environmentId === null) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "rename", label: "Rename", disabled: !canEditSections },
        { id: "new", label: "New section…", disabled: !canEditSections },
        { id: "delete", label: "Delete section", destructive: true, disabled: !canEditSections },
      ],
      position,
    );
    if (clicked === "rename") setRenamingId(section.id);
    else if (clicked === "new") setCreating({ moveBot: null });
    else if (
      clicked === "delete" &&
      (await confirmDestructive(`Delete "${section.name}"? Its bots move back to Bots.`))
    ) {
      void deleteSection({ environmentId, input: { sectionId: section.id } });
    }
  };

  const toggleGroup = (key: string) =>
    setCollapsedGroups((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );

  // Without sections the default list needs no header: it is the whole list.
  const showGroupHeaders = shown !== null && shown.sections.length > 0;

  if (!manageDock && rows !== null) {
    return (
      <section aria-label="Bot dock" className="border-b border-sidebar-border pb-2">
        <div className="flex max-h-20 flex-wrap gap-1 overflow-auto p-1">
          {shown?.bots.map((bot, index) => {
            const row = rows.find((entry) => entry.bot.id === bot.id);
            if (!row) return null;
            return (
              <button
                key={bot.id}
                type="button"
                aria-label={bot.name}
                onClick={() => props.onOpenThread(row.threadRef)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void showBotMenu(row, { x: event.clientX, y: event.clientY });
                }}
                className={cn(
                  "relative flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  row.status.kind === "settled" && "opacity-50",
                  index > 0 && shown.bots[index - 1]?.sectionId !== bot.sectionId && "ml-2",
                )}
              >
                <BotAvatar
                  botId={bot.id}
                  size={28}
                  alert={row.status.kind === "needs-you" && row.status.attention === "request"}
                />
                <StatusDot row={row} />
              </button>
            );
          })}
          <button
            type="button"
            aria-label="New bot"
            onClick={openBotsSettings}
            className="flex size-8 items-center justify-center rounded-lg text-sidebar-muted-foreground hover:bg-sidebar-row-hover"
          >
            <PlusIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Manage bot sections"
            onClick={() => setManageDock(true)}
            className="size-8 rounded-lg text-sidebar-muted-foreground hover:bg-sidebar-row-hover"
          >
            …
          </button>
        </div>
        {creating !== null && (
          <SectionNameInput
            initial=""
            onSubmit={(name) => void submitNewSection(name)}
            onCancel={() => setCreating(null)}
          />
        )}
      </section>
    );
  }

  return (
    <section aria-label="Bots" className="flex flex-col gap-px">
      <button
        type="button"
        onClick={() => setManageDock(false)}
        className="px-2 py-1 text-left text-xs text-sidebar-muted-foreground"
      >
        ← Back to inbox dock
      </button>
      {props.collapsible ? (
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          tone="emphasized"
          accessory={
            <span className="flex items-center gap-1.5">
              {needsYou > 0 ? (
                <span className="rounded-full bg-warning-surface px-1.5 text-3xs leading-4 text-warning-foreground">
                  {needsYou}
                </span>
              ) : null}
              <span
                role="button"
                tabIndex={-1}
                aria-label="New bot"
                onClick={(event) => {
                  event.stopPropagation();
                  openBotsSettings();
                }}
                className="flex size-4 items-center justify-center rounded hover:bg-sidebar-row-hover"
              >
                <PlusIcon className="size-3" />
              </span>
            </span>
          }
        >
          Bots
        </CollapsibleSectionHeader>
      ) : null}
      {!expanded ? null : rows === null ? (
        <BotsNotice>
          {environmentId === null
            ? "Bots live on another machine that is not connected."
            : error === null
              ? "Loading bots…"
              : `Bots unavailable: ${error}`}
        </BotsNotice>
      ) : rows.length === 0 ? (
        <BotsNotice>
          No bots yet.{" "}
          <button
            type="button"
            onClick={openBotsSettings}
            className="cursor-pointer text-sidebar-foreground underline underline-offset-2"
          >
            Create one
          </button>
        </BotsNotice>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={groups.map((group) => `section:${botGroupKey(group.section)}`)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-1.5">
              {groups.map((group) => {
                const key = botGroupKey(group.section);
                const collapsed = showGroupHeaders && collapsedGroups.includes(key);
                return (
                  <div key={key} className="flex flex-col gap-px">
                    {showGroupHeaders ? (
                      <GroupHeader
                        group={group}
                        collapsed={collapsed}
                        draggable={canArrange}
                        renaming={group.section !== null && renamingId === group.section.id}
                        onToggle={() => toggleGroup(key)}
                        onMenu={(position) => {
                          if (group.section !== null) void showSectionMenu(group.section, position);
                        }}
                        onRename={(name) => {
                          setRenamingId(null);
                          if (environmentId !== null && group.section !== null) {
                            void renameSection({
                              environmentId,
                              input: { sectionId: group.section.id, name },
                            });
                          }
                        }}
                        onCancelRename={() => setRenamingId(null)}
                      />
                    ) : null}
                    <SortableContext
                      items={group.rows.map((row) => `bot:${row.bot.id}`)}
                      strategy={verticalListSortingStrategy}
                    >
                      <GroupBody group={group} collapsed={collapsed}>
                        {group.rows.map((row) => (
                          <BotRow
                            key={row.bot.id}
                            row={row}
                            draggable={canArrange}
                            selected={
                              activeThreadRef !== null &&
                              activeThreadRef.environmentId === row.threadRef.environmentId &&
                              activeThreadRef.threadId === row.threadRef.threadId
                            }
                            onOpen={() => props.onOpenThread(row.threadRef)}
                            onContextMenu={(position) => void showBotMenu(row, position)}
                          />
                        ))}
                      </GroupBody>
                    </SortableContext>
                  </div>
                );
              })}
            </div>
          </SortableContext>
          {creating !== null ? (
            <div className="px-2 py-1">
              <SectionNameInput
                initial=""
                onSubmit={(name) => void submitNewSection(name)}
                onCancel={() => setCreating(null)}
              />
            </div>
          ) : canEditSections ? (
            <button
              type="button"
              onClick={() => setCreating({ moveBot: null })}
              className="flex cursor-pointer items-center gap-1 px-2 py-1 text-2xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
            >
              <PlusIcon className="size-3" />
              New section
            </button>
          ) : null}
        </DndContext>
      )}
    </section>
  );
}

/** `bot:<id>`, `section:<id>` or `group:<id>` split into its kind and id. */
function splitDragId(id: string): readonly [kind: string, id: string] {
  const colon = id.indexOf(":");
  return [id.slice(0, colon), id.slice(colon + 1)];
}

/** Heading that separates the Bots block from the thread list in the "sections" layout. */
export function SidebarThreadsHeading() {
  return (
    <div className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-foreground/80">
      <span className="shrink-0">Threads</span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-foreground/25" />
    </div>
  );
}

/** Bots | Threads switch for the "tabs" layout, with a needs-you badge on each side. */
export function SidebarBotsTabs(props: {
  value: SidebarBotsTab;
  onChange: (tab: SidebarBotsTab) => void;
  threads: ReadonlyArray<BotThreadShell>;
  threadsNeedingYou: number;
}) {
  const { rows } = useBotRows(props.threads);
  const tabs = [
    { id: "bots", label: "Bots", badge: countRowsNeedingYou(rows) },
    { id: "threads", label: "Threads", badge: props.threadsNeedingYou },
  ] as const;
  return (
    <div
      role="tablist"
      className="mt-1.5 grid grid-cols-2 gap-0.5 rounded-md bg-sidebar-control-surface p-0.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={props.value === tab.id}
          onClick={() => props.onChange(tab.id)}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium",
            props.value === tab.id
              ? "bg-sidebar text-sidebar-foreground shadow-xs"
              : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
          )}
        >
          {tab.label}
          {tab.badge > 0 ? (
            <span className="rounded-full bg-warning-surface px-1.5 text-3xs leading-4 text-warning-foreground">
              {tab.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
