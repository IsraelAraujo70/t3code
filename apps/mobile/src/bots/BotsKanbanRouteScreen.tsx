import { useAtomValue } from "@effect/atom-react";
import {
  buildKanbanView,
  filterOptions,
  KANBAN_FILTER_FIELD_LABELS,
  threadCardStatus,
  type KanbanFilterOption,
  type KanbanGroup,
  type KanbanViewContext,
} from "@t3tools/client-runtime/kanban-board";
import {
  EnvironmentId,
  KANBAN_DEFAULT_VIEW_CONFIG,
  KANBAN_LOCAL_STATES,
  KANBAN_OWNER_PERSON_ID,
  KanbanTicketTitle,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Schema } from "effect";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Linking, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useResolveClassNames } from "uniwind";

import { AppBar } from "../components/ui/AppBar";
import { AppText as Text } from "../components/ui/AppText";
import { Chip } from "../components/ui/Chip";
import { ControlPill } from "../components/ui/ControlPill";
import * as Dialog from "../components/ui/Dialog";
import { Menu } from "../components/ui/Menu";
import { Notice } from "../components/ui/Notice";
import { useProjects, useThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import {
  moveTarget,
  parseTicketMenuChoice,
  shownColumnId,
  statusGroupsOf,
  ticketMenuActions,
  type TicketMenuThread,
} from "./kanban.logic";
import { KanbanCard, type KanbanCardThread } from "./kanban/KanbanCard";
import { buildKanbanLookups, type KanbanLookups } from "./kanban/kanbanDisplay.logic";
import {
  applyFilterOverlay,
  filterChipLabel,
  KANBAN_OVERLAY_FIELDS,
  overlayValues,
  scopeViews,
  selectedView,
  toggleOverlayValue,
  type KanbanFilterOverlay,
  type KanbanOverlayField,
} from "./kanban/kanbanFilters.logic";
import { KanbanGroupIconView, type KanbanGlyphColors } from "./kanban/KanbanGlyphs";
import { responsibleBotIds } from "./kanban/kanbanIssue.logic";
import { KanbanPickerSheet, reportKanbanResult } from "./kanban/KanbanPickerSheet";
import { botsEnvironment, useBotDirectory, useKanbanSnapshot } from "./state";
import type { ThreadReturnTab } from "./threadReturnTab";

type BotsKanbanRouteScreenProps = StaticScreenProps<{
  /** The bots host whose kanban is shown. */
  readonly environmentId: string;
}>;

const ALL = "all";
const isTitle = Schema.is(KanbanTicketTitle);
const VIEWS_NOTE = "Saved views are created and edited in T3 Code on your computer.";

/** Glyph colors from the theme, read once per screen. */
export function useKanbanGlyphColors(): KanbanGlyphColors {
  const muted = useResolveClassNames("text-icon-muted").color ?? "gray";
  const urgent = useResolveClassNames("text-warning-foreground").color ?? "orange";
  return useMemo(() => ({ muted, urgent }), [muted, urgent]);
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
    reportKanbanResult("Could not sync with Linear", await sync({ environmentId, input: {} }));
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
 * The bots host's kanban on a phone, below its header. Saved views and filter chips narrow it,
 * one column shows at a time, a tap opens the issue, and a card moves through its long-press
 * menu, since dragging across a phone screen is clumsy. Linear accounts, project links and saved
 * views are edited on the computer.
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

function ProjectChip(props: {
  readonly value: ProjectId | null;
  readonly options: ReadonlyArray<{ readonly id: ProjectId; readonly label: string }>;
  readonly onChange: (value: ProjectId | null) => void;
}) {
  const current = props.options.find((option) => option.id === props.value);
  const actions: MenuAction[] = [
    { id: ALL, title: "All projects", state: props.value === null ? "on" : "off" },
    ...props.options.map((option) => ({
      id: option.id,
      title: option.label,
      state: option.id === props.value ? ("on" as const) : ("off" as const),
    })),
  ];
  return (
    <Menu
      accessible
      accessibilityLabel="Project"
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) =>
        props.onChange(props.options.find((option) => option.id === nativeEvent.event)?.id ?? null)
      }
    >
      <Chip
        size="small"
        label={current?.label ?? "All projects"}
        selected={props.value !== null}
        trailingIcon="chevron.down"
        accessibilityLabel="Project"
      />
    </Menu>
  );
}

type BoardSheet =
  | { readonly kind: "filter"; readonly field: KanbanOverlayField }
  | { readonly kind: "hidden" };

type BoardRow =
  | { readonly kind: "columns" }
  | { readonly kind: "ticket"; readonly ticket: KanbanTicket };

function KanbanBoardView(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KanbanSnapshot;
  readonly returnTab: ThreadReturnTab | undefined;
  readonly bottomPadding: number;
}) {
  const { environmentId, snapshot, returnTab } = props;
  const navigation = useNavigation();
  const colors = useKanbanGlyphColors();
  const { directory } = useBotDirectory(environmentId);
  const allProjects = useProjects();
  const shells = useThreadShells();
  const move = useAtomCommand(botsEnvironment.kanbanMoveTicket, { label: "kanban move" });
  const create = useAtomCommand(botsEnvironment.kanbanCreateTicket, { label: "kanban create" });
  const remove = useAtomCommand(botsEnvironment.kanbanDeleteTicket, { label: "kanban delete" });
  const link = useAtomCommand(botsEnvironment.kanbanLinkThread, { label: "kanban link" });
  const unlink = useAtomCommand(botsEnvironment.kanbanUnlinkThread, { label: "kanban unlink" });
  const canEdit = useAtomValue(botsEnvironment.kanbanMoveTicket.permissionAtom(environmentId));
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [pickedViewId, setPickedViewId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<KanbanFilterOverlay>({});
  const [pickedColumn, setPickedColumn] = useState<string | null>(null);
  const [sheet, setSheet] = useState<BoardSheet | null>(null);
  // Date windows ("past week", "current cycle") use the time of the last board interaction.
  const [now, setNow] = useState(Date.now);
  // A move shows at once and holds until the server answers.
  const [pending, setPending] = useState<ReadonlyMap<string, KanbanTicketStatus>>(new Map());

  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const bots = directory?.bots;
  const lookups = useMemo(() => buildKanbanLookups(snapshot, bots ?? []), [snapshot, bots]);
  const threadsById = useMemo(
    () =>
      new Map(
        shells
          .filter((shell) => shell.environmentId === environmentId && shell.archivedAt === null)
          .map((shell) => [shell.id, shell]),
      ),
    [shells, environmentId],
  );

  const shown = useMemo<KanbanSnapshot>(
    () =>
      pending.size === 0
        ? snapshot
        : {
            ...snapshot,
            tickets: snapshot.tickets.map((ticket) => {
              const status = pending.get(ticket.id);
              return status === undefined ? ticket : { ...ticket, status };
            }),
          },
    [snapshot, pending],
  );
  const views = useMemo(() => scopeViews(snapshot.views, projectId), [snapshot.views, projectId]);
  const view = selectedView(views, pickedViewId);
  const baseConfig = view?.config ?? KANBAN_DEFAULT_VIEW_CONFIG;
  const config = useMemo(() => applyFilterOverlay(baseConfig, overlay), [baseConfig, overlay]);
  const context = useMemo<KanbanViewContext>(
    () => ({
      now,
      threadStatus: (threadId: ThreadId) => {
        const shell = threadsById.get(threadId);
        return shell === undefined ? null : threadCardStatus(shell);
      },
      personName: (personId: string) =>
        personId === KANBAN_OWNER_PERSON_ID
          ? lookups.ownerName
          : personId.startsWith("bot:")
            ? (lookups.botsById.get(personId.slice("bot:".length))?.name ?? null)
            : null,
    }),
    [now, threadsById, lookups],
  );
  const result = useMemo(
    () => buildKanbanView(shown, projectId, config, context),
    [shown, projectId, config, context],
  );
  const statusGroups = useMemo(() => statusGroupsOf(shown, projectId), [shown, projectId]);
  const optionsByField = useMemo(
    () =>
      new Map(
        KANBAN_OVERLAY_FIELDS.map((field) => [
          field,
          filterOptions(snapshot, projectId, field, context),
        ]),
      ),
    [snapshot, projectId, context],
  );
  const properties = useMemo(() => new Set(config.properties), [config.properties]);
  const nowDate = useMemo(() => new Date(now), [now]);
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const columnId = shownColumnId(result, pickedColumn);
  const column: KanbanGroup | null =
    [...result.columns, ...result.hiddenColumns].find((candidate) => candidate.id === columnId) ??
    null;
  const columnIsHidden = result.hiddenColumns.some((candidate) => candidate.id === columnId);
  const projectLink = snapshot.links.find((candidate) => candidate.projectId === projectId);
  const rows = useMemo<ReadonlyArray<BoardRow>>(
    () => [
      { kind: "columns" },
      ...(column?.tickets ?? []).map((ticket) => ({ kind: "ticket" as const, ticket })),
    ],
    [column],
  );

  const moveTicket = async (ticket: KanbanTicket, to: KanbanTicketStatus) => {
    setPending((current) => new Map(current).set(ticket.id, to));
    const moved = await move({ environmentId, input: { ticketId: ticket.id, to } });
    setPending((current) => {
      const next = new Map(current);
      next.delete(ticket.id);
      return next;
    });
    reportKanbanResult(`Could not move ${ticket.identifier}`, moved);
  };

  const openTicket = useCallback(
    (ticket: KanbanTicket) =>
      navigation.dispatch(
        StackActions.push("BotsKanbanIssue", {
          environmentId,
          ticketId: ticket.id,
          ...(returnTab === undefined ? {} : { returnTab }),
        }),
      ),
    [navigation, environmentId, returnTab],
  );

  const onChoice = async (ticket: KanbanTicket, id: string) => {
    const choice = parseTicketMenuChoice(id);
    if (choice === null) return;
    switch (choice.kind) {
      case "open":
        openTicket(ticket);
        return;
      case "move": {
        const to = moveTarget(shown, statusGroups, ticket, choice.columnId);
        if (to !== null) await moveTicket(ticket, to);
        return;
      }
      case "link":
        reportKanbanResult(
          "Could not link the thread",
          await link({ environmentId, input: { ticketId: ticket.id, threadId: choice.threadId } }),
        );
        return;
      case "unlink":
        reportKanbanResult(
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
            void remove({ environmentId, input: { ticketId: ticket.id } }).then((removed) =>
              reportKanbanResult("Could not delete the ticket", removed),
            ),
        });
        return;
    }
  };

  const newTicket = () => {
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
        // A local ticket starts in the shown status column; Linear picks a new issue's column.
        const state =
          projectLink === undefined && config.groupBy === "status"
            ? KANBAN_LOCAL_STATES.find((candidate) => candidate === column?.id)
            : undefined;
        void create({
          environmentId,
          input: { projectId, title, ...(state === undefined ? {} : { state }) },
        }).then((created) => reportKanbanResult("Could not create the ticket", created));
      },
    });
  };

  const menuThreads = (ids: ReadonlyArray<ThreadId>): TicketMenuThread[] =>
    ids.flatMap((id) => {
      const shell = threadsById.get(id);
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
  const cardThreads = (ticket: KanbanTicket): KanbanCardThread[] =>
    ticket.threadIds.flatMap((id) => {
      const shell = threadsById.get(id);
      return shell === undefined ? [] : [{ id, status: threadCardStatus(shell) }];
    });

  const fieldShown = (field: KanbanOverlayField) =>
    field === "workspace"
      ? snapshot.workspaces.length > 1
      : field === "account"
        ? snapshot.accounts.length > 0
        : true;
  const optionLabel = (field: KanbanOverlayField) => {
    const labels = new Map(
      (optionsByField.get(field) ?? []).map((option) => [option.value, option.label]),
    );
    return (value: string) => labels.get(value) ?? value;
  };
  const overlayActive = Object.keys(overlay).length > 0;

  const header = (
    <View className="gap-2 pb-2">
      {snapshot.accounts.length === 0 ? (
        <View className="px-4">
          <Notice
            icon="info.circle"
            message="No Linear account yet. Add one in T3 Code on your computer: Settings → Bots → Kanban & Linear. Local boards work without one."
          />
        </View>
      ) : null}
      {views.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4"
        >
          {views.map((candidate) => (
            <Chip
              key={candidate.id}
              label={candidate.name}
              selected={candidate.id === view?.id}
              onPress={() => {
                setPickedViewId(candidate.id);
                setOverlay({});
                setNow(Date.now());
                setPickedColumn(null);
              }}
              accessibilityLabel={`View ${candidate.name}`}
            />
          ))}
        </ScrollView>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-4"
      >
        <ProjectChip
          value={projectId}
          options={projects.map((project) => ({ id: project.id, label: project.title }))}
          onChange={(value) => {
            setProjectId(value);
            setNow(Date.now());
            setPickedColumn(null);
          }}
        />
        {KANBAN_OVERLAY_FIELDS.filter(fieldShown).map((field) => {
          const values = overlayValues(baseConfig, overlay, field);
          const fieldLabel = KANBAN_FILTER_FIELD_LABELS[field];
          return (
            <Chip
              key={field}
              size="small"
              label={filterChipLabel(fieldLabel, values, optionLabel(field))}
              selected={values.length > 0}
              trailingIcon="chevron.down"
              onPress={() => setSheet({ kind: "filter", field })}
              accessibilityLabel={`Filter by ${fieldLabel}`}
            />
          );
        })}
        {overlayActive ? (
          <Chip
            size="small"
            label="Clear"
            icon="xmark"
            onPress={() => {
              setOverlay({});
              setNow(Date.now());
            }}
            accessibilityLabel="Clear filters back to the view"
          />
        ) : null}
      </ScrollView>
      {projectLink ? (
        <Text className="px-4 text-xs text-foreground-muted">
          {`${projectLink.teamName} on Linear${projectLink.syncError ? ` · sync failed: ${projectLink.syncError}` : ""}`}
        </Text>
      ) : projectId !== null ? (
        <Text className="px-4 text-xs text-foreground-muted">Local board</Text>
      ) : null}
    </View>
  );

  const footer = (
    <View className="gap-2 px-4 pt-2">
      {column === null || column.tickets.length === 0 ? (
        <Text className="py-6 text-center text-sm text-foreground-muted">
          {result.total === 0 ? "No tickets match this view." : "No tickets in this column."}
        </Text>
      ) : null}
      {projectId === null ? (
        <Text className="pt-2 text-center text-xs text-foreground-muted">
          Pick a project to add tickets.
        </Text>
      ) : canEdit ? (
        <View className="items-start pt-1">
          <ControlPill variant="pill" icon="plus" label="New ticket" onPress={newTicket} />
        </View>
      ) : null}
    </View>
  );

  const renderRow = ({ item }: { readonly item: BoardRow }) => {
    if (item.kind === "columns") {
      return (
        <View className="bg-screen py-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 px-4"
          >
            {result.columns.map((candidate) => (
              <Chip
                key={candidate.id}
                label={`${candidate.title} ${candidate.tickets.length}`}
                selected={candidate.id === columnId}
                onPress={() => setPickedColumn(candidate.id)}
                accessibilityLabel={`${candidate.title}, ${candidate.tickets.length} tickets`}
              />
            ))}
            {result.hiddenColumns.length > 0 ? (
              <Chip
                label={
                  columnIsHidden && column !== null
                    ? `${column.title} ${column.tickets.length}`
                    : `Hidden ${result.hiddenColumns.length}`
                }
                icon="eye.slash"
                selected={columnIsHidden}
                onPress={() => setSheet({ kind: "hidden" })}
                accessibilityLabel={`${result.hiddenColumns.length} hidden columns`}
              />
            ) : null}
          </ScrollView>
        </View>
      );
    }
    const { ticket } = item;
    return (
      <View className="px-4 pb-2">
        <KanbanCard
          ticket={ticket}
          lookups={lookups}
          colors={colors}
          properties={properties}
          bots={responsibleBotIds(snapshot, ticket).flatMap((botId) => {
            const bot = lookups.botsById.get(botId);
            return bot === undefined ? [] : [bot];
          })}
          threads={cardThreads(ticket)}
          projectTitle={projectId === null ? (projectTitles.get(ticket.projectId) ?? null) : null}
          now={nowDate}
          actions={ticketMenuActions({
            snapshot: shown,
            statusGroups,
            ticket,
            linkable: linkableThreads(ticket),
            linked: menuThreads(ticket.threadIds),
            canEdit,
          })}
          onChoice={(choiceTicket, id) => void onChoice(choiceTicket, id)}
          onOpen={openTicket}
        />
      </View>
    );
  };

  return (
    <>
      <FlatList
        data={rows}
        keyExtractor={(row) => (row.kind === "columns" ? "columns" : row.ticket.id)}
        renderItem={renderRow}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        // The column chips (first row, after the header) stay on top while cards scroll.
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: props.bottomPadding + 24 }}
        keyboardShouldPersistTaps="handled"
      />
      {sheet?.kind === "filter" ? (
        <FilterSheet
          field={sheet.field}
          options={optionsByField.get(sheet.field) ?? []}
          selected={overlayValues(baseConfig, overlay, sheet.field)}
          lookups={lookups}
          colors={colors}
          onToggle={(value) => {
            setOverlay((current) => toggleOverlayValue(baseConfig, current, sheet.field, value));
            setNow(Date.now());
          }}
          onClose={() => setSheet(null)}
        />
      ) : sheet?.kind === "hidden" ? (
        <KanbanPickerSheet
          title="Hidden columns"
          options={result.hiddenColumns.map((group) => ({
            value: group.id,
            label: group.title,
            subtitle: `${group.tickets.length} ${group.tickets.length === 1 ? "ticket" : "tickets"}`,
            leading: (
              <KanbanGroupIconView icon={group.icon} lookups={lookups} colors={colors} size={18} />
            ),
          }))}
          selected={columnIsHidden && columnId !== null ? [columnId] : []}
          footer="Columns the view hides, and empty ones. Pick one to show its tickets."
          onPick={(value) => {
            setPickedColumn(value);
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

function FilterSheet(props: {
  readonly field: KanbanOverlayField;
  readonly options: ReadonlyArray<KanbanFilterOption>;
  readonly selected: ReadonlyArray<string>;
  readonly lookups: KanbanLookups;
  readonly colors: KanbanGlyphColors;
  readonly onToggle: (value: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <KanbanPickerSheet
      title={KANBAN_FILTER_FIELD_LABELS[props.field]}
      multi
      options={props.options.map((option) => ({
        value: option.value,
        label: option.label,
        subtitle: `${option.count} ${option.count === 1 ? "ticket" : "tickets"}`,
        leading: (
          <KanbanGroupIconView
            icon={option.icon}
            lookups={props.lookups}
            colors={props.colors}
            size={18}
          />
        ),
      }))}
      selected={props.selected}
      footer={`Applies on this phone until you pick another view. ${VIEWS_NOTE}`}
      onPick={props.onToggle}
      onClose={props.onClose}
    />
  );
}
