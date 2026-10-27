import { useAtomValue } from "@effect/atom-react";
import {
  buildBoard,
  THREAD_CARD_STATUS_LABELS,
  threadCardStatus,
  workspaceOf,
  type KanbanBoard,
  type KanbanFilter,
  type ThreadCardStatus,
} from "@t3tools/client-runtime/kanban-board";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  KanbanTicketTitle,
  type BotDirectoryEntry,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type KanbanWorkspaceId,
  type LinearAccountId,
  type ProjectId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Schema } from "effect";
import { useCallback, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../components/ui/AppBar";
import { AppText as Text } from "../components/ui/AppText";
import { Chip } from "../components/ui/Chip";
import { ControlPill } from "../components/ui/ControlPill";
import * as Dialog from "../components/ui/Dialog";
import { Menu } from "../components/ui/Menu";
import { Notice } from "../components/ui/Notice";
import { cn } from "../lib/cn";
import { useProjects, useThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { BotAvatar } from "./BotAvatar";
import {
  moveTarget,
  parseTicketMenuChoice,
  shownColumnId,
  ticketMenuActions,
  type TicketMenuThread,
} from "./kanban.logic";
import { botsEnvironment, useBotDirectory, useKanbanSnapshot } from "./state";
import type { ThreadReturnTab } from "./threadReturnTab";

type BotsKanbanRouteScreenProps = StaticScreenProps<{
  /** The bots host whose kanban is shown. */
  readonly environmentId: string;
}>;

const ALL = "all";
const isTitle = Schema.is(KanbanTicketTitle);
const PRIORITY_LABELS = ["", "Urgent", "High", "Medium", "Low"];

const STATUS_DOT: Record<ThreadCardStatus, string> = {
  approval: "bg-amber-500",
  input: "bg-indigo-500",
  failed: "bg-red-500",
  working: "bg-sky-500",
  settled: "bg-emerald-500",
};

/** Reports a failed command in a dialog; returns whether it succeeded. */
function reportResult(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : String(error));
  }
  return false;
}

/** The header's "Sync with Linear now" button, once a project is linked to Linear. */
export function useKanbanSyncActions(
  environmentId: EnvironmentId,
  snapshot: KanbanSnapshot | null,
) {
  const sync = useAtomCommand(botsEnvironment.kanbanSync, { label: "kanban sync" });
  const canSync = useAtomValue(botsEnvironment.kanbanSync.permissionAtom(environmentId));
  const [syncing, setSyncing] = useState(false);
  const runSync = async () => {
    setSyncing(true);
    reportResult("Could not sync with Linear", await sync({ environmentId, input: {} }));
    setSyncing(false);
  };
  return (snapshot?.links.length ?? 0) > 0
    ? [
        {
          accessibilityLabel: "Sync with Linear now",
          icon: "arrow.clockwise" as const,
          disabled: !canSync,
          loading: syncing,
          onPress: () => void runSync(),
        },
      ]
    : [];
}

/**
 * The bots host's kanban on a phone, below its header. One column shows at a time, picked from a
 * row of chips, and a card moves through its menu (long-press or ⋯), since dragging across a phone
 * screen is clumsy. Linear accounts and project links are edited on the computer.
 */
export function KanbanBoardContent(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KanbanSnapshot | null;
  readonly error: string | null;
  /** Set when the board is a top-level tab, so Back from a thread opened here returns to it. */
  readonly returnTab?: ThreadReturnTab;
  readonly bottomPadding?: number;
}) {
  return props.error !== null ? (
    <View className="px-4 py-3">
      <Notice tone="danger" message={`Kanban unavailable: ${props.error}`} />
    </View>
  ) : props.snapshot === null ? (
    <Text className="px-4 py-3 text-sm text-foreground-muted">Loading the board…</Text>
  ) : (
    <KanbanBoardView
      environmentId={props.environmentId}
      snapshot={props.snapshot}
      returnTab={props.returnTab}
      bottomPadding={props.bottomPadding ?? 0}
    />
  );
}

/** The kanban as a pushed screen, opened from the Bots list where there is no Kanban tab (iOS). */
export function BotsKanbanRouteScreen({ route }: BotsKanbanRouteScreenProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { snapshot, error } = useKanbanSnapshot(environmentId);
  const actions = useKanbanSyncActions(environmentId, snapshot);
  const onClose = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <View className="flex-1 bg-screen" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title="Kanban"
        sidebar={false}
        onBack={onClose}
        options={{ headerBackVisible: false }}
        actions={actions}
      />
      <KanbanBoardContent environmentId={environmentId} snapshot={snapshot} error={error} />
    </View>
  );
}

function FilterChip(props: {
  readonly label: string;
  readonly value: string | null;
  readonly allLabel: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly onChange: (value: string | null) => void;
}) {
  const current = props.options.find((option) => option.id === props.value);
  const actions: MenuAction[] = [
    { id: ALL, title: props.allLabel, state: props.value === null ? "on" : "off" },
    ...props.options.map((option) => ({
      id: option.id,
      title: option.label,
      state: option.id === props.value ? ("on" as const) : ("off" as const),
    })),
  ];
  return (
    <Menu
      accessible
      accessibilityLabel={props.label}
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) =>
        props.onChange(nativeEvent.event === ALL ? null : nativeEvent.event)
      }
    >
      <Chip
        size="small"
        label={current?.label ?? props.allLabel}
        selected={props.value !== null}
        trailingIcon="chevron.down"
        accessibilityLabel={props.label}
      />
    </Menu>
  );
}

function KanbanBoardView(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KanbanSnapshot;
  readonly returnTab: ThreadReturnTab | undefined;
  readonly bottomPadding: number;
}) {
  const { environmentId, snapshot } = props;
  const navigation = useNavigation();
  const { directory } = useBotDirectory(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const shells = useThreadShells();
  const move = useAtomCommand(botsEnvironment.kanbanMoveTicket, { label: "kanban move" });
  const create = useAtomCommand(botsEnvironment.kanbanCreateTicket, { label: "kanban create" });
  const remove = useAtomCommand(botsEnvironment.kanbanDeleteTicket, { label: "kanban delete" });
  const link = useAtomCommand(botsEnvironment.kanbanLinkThread, { label: "kanban link" });
  const unlink = useAtomCommand(botsEnvironment.kanbanUnlinkThread, { label: "kanban unlink" });
  const canEdit = useAtomValue(botsEnvironment.kanbanMoveTicket.permissionAtom(environmentId));
  const [filter, setFilter] = useState<KanbanFilter>({
    projectId: null,
    workspaceId: null,
    accountId: null,
  });
  const [pickedColumn, setPickedColumn] = useState<string | null>(null);
  // A move shows at once and holds until the server answers.
  const [pending, setPending] = useState<ReadonlyMap<string, KanbanTicketStatus>>(new Map());

  const shown: KanbanSnapshot =
    pending.size === 0
      ? snapshot
      : {
          ...snapshot,
          tickets: snapshot.tickets.map((ticket) => {
            const status = pending.get(ticket.id);
            return status === undefined ? ticket : { ...ticket, status };
          }),
        };
  const board = buildBoard(shown, filter);
  const columnId = shownColumnId(board, pickedColumn);
  const column = board.columns.find((candidate) => candidate.id === columnId) ?? null;

  const threadsById = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId && shell.archivedAt === null)
      .map((shell) => [shell.id, shell]),
  );
  const botsById = new Map((directory?.bots ?? []).map((bot) => [bot.id, bot]));
  const workspaceBots = new Map(
    snapshot.workspaces.map((workspace) => [
      workspace.id,
      workspace.botIds.flatMap((botId) => {
        const bot = botsById.get(botId);
        return bot === undefined ? [] : [bot];
      }),
    ]),
  );
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
  const projectLink = snapshot.links.find((candidate) => candidate.projectId === filter.projectId);

  const moveTicket = async (ticket: KanbanTicket, to: KanbanTicketStatus) => {
    setPending((current) => new Map(current).set(ticket.id, to));
    const result = await move({ environmentId, input: { ticketId: ticket.id, to } });
    setPending((current) => {
      const next = new Map(current);
      next.delete(ticket.id);
      return next;
    });
    reportResult(`Could not move ${ticket.identifier}`, result);
  };

  const onChoice = async (ticket: KanbanTicket, id: string) => {
    const choice = parseTicketMenuChoice(id);
    if (choice === null) return;
    switch (choice.kind) {
      case "move": {
        const to = moveTarget(shown, board, ticket, choice.columnId);
        if (to !== null) await moveTicket(ticket, to);
        return;
      }
      case "link":
        reportResult(
          "Could not link the thread",
          await link({ environmentId, input: { ticketId: ticket.id, threadId: choice.threadId } }),
        );
        return;
      case "unlink":
        reportResult(
          "Could not unlink the thread",
          await unlink({
            environmentId,
            input: { ticketId: ticket.id, threadId: choice.threadId },
          }),
        );
        return;
      case "open-linear":
        if (ticket.linear) void Linking.openURL(ticket.linear.url);
        return;
      case "delete":
        Dialog.confirm({
          title: `Delete ${ticket.identifier}?`,
          message: ticket.title,
          confirmText: "Delete",
          destructive: true,
          onConfirm: () =>
            void remove({ environmentId, input: { ticketId: ticket.id } }).then((result) =>
              reportResult("Could not delete the ticket", result),
            ),
        });
        return;
    }
  };

  const newTicket = () => {
    const projectId = filter.projectId;
    if (projectId === null) return;
    Dialog.prompt({
      title: "New ticket",
      message: projectLink ? `Created in Linear (${projectLink.teamName}).` : undefined,
      placeholder: "Title",
      initialValue: "",
      confirmText: "Create",
      onConfirm: (value) => {
        const title = value.trim();
        if (!isTitle(title)) return;
        void create({
          environmentId,
          input: {
            projectId,
            title,
            ...(column?.kind === "local" ? { state: column.state } : {}),
          },
        }).then((result) => reportResult("Could not create the ticket", result));
      },
    });
  };

  const menuThreads = (ids: ReadonlyArray<string>): TicketMenuThread[] =>
    ids.flatMap((id) => {
      const shell = threadsById.get(id as EnvironmentThreadShell["id"]);
      return shell === undefined ? [] : [{ id: shell.id, title: shell.title }];
    });
  const linkableThreads = (ticket: KanbanTicket): TicketMenuThread[] =>
    [...threadsById.values()]
      .filter(
        (shell) =>
          shell.projectId === ticket.projectId &&
          !ticket.threadIds.includes(shell.id) &&
          !shell.id.startsWith("bot:"),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20)
      .map((shell) => ({ id: shell.id, title: shell.title }));

  return (
    <ScrollView
      contentContainerStyle={{ paddingBottom: props.bottomPadding + 24 }}
      stickyHeaderIndices={[1]}
    >
      <View className="gap-2 px-4 pb-2">
        {snapshot.accounts.length === 0 ? (
          <Notice
            icon="info.circle"
            message="No Linear account yet. Add one in T3 Code on your computer: Settings → Bots → Kanban & Linear. Local boards work without one."
          />
        ) : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
        >
          <FilterChip
            label="Project"
            value={filter.projectId}
            allLabel="All projects"
            options={projects.map((project) => ({ id: project.id, label: project.title }))}
            onChange={(value) => setFilter({ ...filter, projectId: value as ProjectId | null })}
          />
          <FilterChip
            label="Workspace"
            value={filter.workspaceId}
            allLabel="All workspaces"
            options={snapshot.workspaces.map((workspace) => ({
              id: workspace.id,
              label: workspace.name,
            }))}
            onChange={(value) =>
              setFilter({ ...filter, workspaceId: value as KanbanWorkspaceId | null })
            }
          />
          {snapshot.accounts.length > 0 ? (
            <FilterChip
              label="Linear account"
              value={filter.accountId}
              allLabel="All accounts"
              options={snapshot.accounts.map((account) => ({
                id: account.id,
                label: account.name,
              }))}
              onChange={(value) =>
                setFilter({ ...filter, accountId: value as LinearAccountId | null })
              }
            />
          ) : null}
        </ScrollView>
        {projectLink ? (
          <Text className="text-xs text-foreground-muted">
            {`${projectLink.teamName} on Linear${projectLink.syncError ? ` · sync failed: ${projectLink.syncError}` : ""}`}
          </Text>
        ) : filter.projectId !== null ? (
          <Text className="text-xs text-foreground-muted">Local board</Text>
        ) : null}
      </View>
      <ColumnPicker board={board} columnId={columnId} onPick={setPickedColumn} />
      <View className="gap-2 px-4 pt-2">
        {column === null || column.tickets.length === 0 ? (
          <Text className="py-6 text-center text-sm text-foreground-muted">
            No tickets in this column.
          </Text>
        ) : (
          column.tickets.map((ticket) => (
            <KanbanCard
              key={ticket.id}
              ticket={ticket}
              projectTitle={
                filter.projectId === null ? (projectTitles.get(ticket.projectId) ?? null) : null
              }
              bots={workspaceBots.get(workspaceOf(snapshot, ticket)) ?? []}
              threads={ticket.threadIds.flatMap((id) => {
                const shell = threadsById.get(id);
                return shell === undefined ? [] : [shell];
              })}
              actions={ticketMenuActions({
                snapshot: shown,
                board,
                ticket,
                linkable: linkableThreads(ticket),
                linked: menuThreads(ticket.threadIds),
                canEdit,
              })}
              onChoice={(id) => void onChoice(ticket, id)}
              onOpenThread={(threadId) =>
                navigation.dispatch(
                  StackActions.push("Thread", {
                    environmentId,
                    threadId,
                    ...(props.returnTab === undefined ? {} : { returnTab: props.returnTab }),
                  }),
                )
              }
            />
          ))
        )}
        {filter.projectId === null ? (
          <Text className="pt-2 text-center text-xs text-foreground-muted">
            Pick a project to add tickets.
          </Text>
        ) : canEdit ? (
          <View className="items-start pt-1">
            <ControlPill variant="pill" icon="plus" label="New ticket" onPress={newTicket} />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

/** One chip per column, with its count; the board shows the picked column below. */
function ColumnPicker(props: {
  readonly board: KanbanBoard;
  readonly columnId: string | null;
  readonly onPick: (columnId: string) => void;
}) {
  return (
    <View className="bg-screen py-2">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-4"
      >
        {props.board.columns.map((column) => (
          <Chip
            key={column.id}
            label={`${column.title} ${column.tickets.length}`}
            selected={column.id === props.columnId}
            onPress={() => props.onPick(column.id)}
            accessibilityLabel={`${column.title}, ${column.tickets.length} tickets`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function KanbanCard(props: {
  readonly ticket: KanbanTicket;
  readonly projectTitle: string | null;
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly actions: MenuAction[];
  readonly onChoice: (id: string) => void;
  readonly onOpenThread: (threadId: EnvironmentThreadShell["id"]) => void;
}) {
  const { ticket } = props;
  const meta = [
    ticket.priority > 0 ? PRIORITY_LABELS[ticket.priority] : null,
    props.projectTitle,
  ].filter((part) => part !== null);
  return (
    <Menu
      shouldOpenOnLongPress
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onChoice(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ticket.identifier}, ${ticket.title}`}
        accessibilityHint="Long-press for move and link actions"
        className="rounded-2xl border border-border bg-card p-3"
      >
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1">
            <Text className="text-xs text-foreground-muted">
              {[ticket.identifier, ...meta].join(" · ")}
            </Text>
            <Text className="mt-0.5 text-base text-foreground">{ticket.title}</Text>
          </View>
          {props.actions.length > 0 ? (
            <Menu
              accessible
              accessibilityLabel={`Actions for ${ticket.identifier}`}
              accessibilityRole="button"
              actions={props.actions}
              onPressAction={({ nativeEvent }) => props.onChoice(nativeEvent.event)}
            >
              <ControlPill
                icon="ellipsis"
                accessibilityLabel={`Actions for ${ticket.identifier}`}
              />
            </Menu>
          ) : null}
        </View>
        {props.threads.length > 0 ? (
          <View className="mt-2 gap-1">
            {props.threads.map((thread) => {
              const status = threadCardStatus(thread);
              return (
                <Pressable
                  key={thread.id}
                  accessibilityRole="link"
                  accessibilityLabel={`${thread.title}, ${THREAD_CARD_STATUS_LABELS[status]}`}
                  onPress={() => props.onOpenThread(thread.id)}
                  className="flex-row items-center gap-2 rounded-lg bg-subtle px-2 py-1.5"
                >
                  <View className={cn("size-2 rounded-full", STATUS_DOT[status])} />
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                    {thread.title}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {THREAD_CARD_STATUS_LABELS[status]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {props.bots.length > 0 || ticket.assigneeName ? (
          <View className="mt-2 flex-row items-center gap-2">
            {props.bots.map((bot) => (
              <View key={bot.id} className="flex-row items-center gap-1">
                <BotAvatar botId={bot.id} size={16} />
                <Text className="text-xs text-foreground-muted">{bot.name}</Text>
              </View>
            ))}
            {ticket.assigneeName ? (
              <Text className="ml-auto text-xs text-foreground-muted" numberOfLines={1}>
                {ticket.assigneeName}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </Menu>
  );
}
