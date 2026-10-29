import { useAtomValue } from "@effect/atom-react";
import {
  buildKanbanView,
  describeClause,
  threadCardStatus,
  workspaceOf,
  type KanbanDropAction,
  type KanbanGroup,
  type KanbanViewContext,
} from "@t3tools/client-runtime/kanban-board";
import {
  KANBAN_DEFAULT_VIEW_CONFIG,
  KANBAN_LOCAL_STATES,
  ProjectId,
  type BotDirectoryEntry,
  type EnvironmentId,
  type KanbanFilterClause,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketId,
  type KanbanView,
  type KanbanViewConfig,
  type KanbanViewId,
  type LinearAccountId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  SquareKanbanIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { PreviewPanelShell } from "../../components/preview/PreviewPanelShell";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { SidebarInset, SidebarTrigger } from "../../components/ui/sidebar";
import { toastManager } from "../../components/ui/toast";
import { getLocalStorageItem, useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  botsEnvironment,
  useBotDirectory,
  useBotsEnvironmentId,
  useKanbanSnapshot,
} from "../../state/bots";
import { useProjects, useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  commandFailureMessage,
  confirmDestructive,
  reportCommandResult,
} from "../botsSettingsShared";
import { KanbanBoard, KanbanNewTicketInput } from "./KanbanBoard";
import type { KanbanThreadOption, KanbanTicketViewProps } from "./KanbanCard";
import { KanbanDisplayMenu } from "./KanbanDisplayMenu";
import { KanbanFilterBar, type KanbanAiFilterOutcome } from "./KanbanFilterBar";
import { KanbanIssueView } from "./KanbanIssueView";
import { KanbanList } from "./KanbanList";
import { buildKanbanLookups, personDisplay } from "./kanbanLookups";
import {
  applyPendingDrops,
  draftOf,
  effectiveConfig,
  findIssue,
  hasKanbanSearch,
  importSummary,
  isDirty,
  KanbanRemembered,
  pickActiveView,
  renameViewInput,
  reorderedViewIds,
  saveAsInput,
  saveViewInput,
  scopeKey,
  viewsForScope,
  withColumnShown,
  withDraft,
  withIssue,
  withoutDraft,
  withoutSavedDraft,
  type KanbanDrafts,
  type KanbanPendingDrops,
  type KanbanSearch,
} from "./kanbanPageState";
import type { KanbanLinkedThread } from "./KanbanPrimitives";
import { KanbanViewTabs } from "./KanbanViewTabs";

const REMEMBERED_KEY = "t3code:bots:kanban-page";
/** The v1 page's filter; only its project seeds the first remembered scope. */
const LEGACY_FILTER_KEY = "t3code:bots:kanban-filter";
const LegacyFilter = Schema.Struct({ projectId: Schema.NullOr(Schema.String) });
const ALL_PROJECTS = "all";
const NO_BOTS: ReadonlyArray<BotDirectoryEntry> = [];
const isLocalState = (id: string) => KANBAN_LOCAL_STATES.some((state) => state === id);

/**
 * The kanban of the bots host: tickets of every project, local or synced with Linear, with the
 * threads working on them. Bots and their kanban live on one machine, so the page always reads
 * the environment that hosts bots.
 */
export function KanbanPage() {
  const environmentId = useBotsEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {environmentId === null ? (
        <PageFrame title={<PageTitle />}>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SquareKanbanIcon />
              </EmptyMedia>
              <EmptyTitle>Bots host not connected</EmptyTitle>
              <EmptyDescription>
                The kanban lives with the bots on one machine. Connect to it to see the board.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </PageFrame>
      ) : (
        <KanbanBoardPage key={environmentId} environmentId={environmentId} />
      )}
    </SidebarInset>
  );
}

function PageTitle() {
  return <h1 className="shrink-0 truncate font-medium text-sm">Kanban</h1>;
}

function AccountsLink() {
  return (
    <Button size="xs" variant="ghost-muted" render={<Link to="/settings/kanban" />}>
      <SettingsIcon className="size-3.5" />
      Accounts & links
    </Button>
  );
}

function PageFrame(props: {
  title: ReactNode;
  actions?: ReactNode;
  reserveNativeControls?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col bg-background", props.className ?? "flex-1")}>
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls={props.reserveNativeControls ?? isElectron}
        className="relative bg-background"
      >
        <SidebarTrigger className="md:hidden" />
        <div className="flex min-w-0 items-center gap-1">{props.title}</div>
        <div className="min-w-0 flex-1" />
        {props.actions}
      </WorkspacePageHeader>
      {props.children}
    </div>
  );
}

function KanbanBoardPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { snapshot, error } = useKanbanSnapshot(environmentId);
  if (snapshot === null) {
    return (
      <PageFrame title={<PageTitle />} actions={<AccountsLink />}>
        {error ? (
          <p className="px-6 py-4 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : (
          <p className="px-6 py-4 text-muted-foreground text-sm" role="status">
            Loading the board…
          </p>
        )}
      </PageFrame>
    );
  }
  return <KanbanWorkspace environmentId={environmentId} snapshot={snapshot} error={error} />;
}

function KanbanWorkspace(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KanbanSnapshot;
  readonly error: string | null;
}) {
  const { environmentId, snapshot } = props;
  const search = useSearch({ from: "/_chat/kanban" });
  const navigate = useNavigate({ from: "/kanban" });
  const { directory } = useBotDirectory(environmentId);
  const bots = directory?.bots ?? NO_BOTS;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
  const shells = useThreadShells();
  const nowMinute = useNowMinute();

  const [initialRemembered] = useState((): KanbanRemembered => ({
    project: getLocalStorageItem(LEGACY_FILTER_KEY, LegacyFilter)?.projectId ?? null,
    views: {},
  }));
  const [remembered, setRemembered] = useLocalStorage(
    REMEMBERED_KEY,
    initialRemembered,
    KanbanRemembered,
  );
  const [drafts, setDrafts] = useState<KanbanDrafts>(new Map());
  const [searchText, setSearchText] = useState("");
  const [pending, setPending] = useState<KanbanPendingDrops>(new Map());

  const move = useAtomCommand(botsEnvironment.kanbanMoveTicket, { label: "kanban move" });
  const update = useAtomCommand(botsEnvironment.kanbanUpdateTicket, { label: "kanban update" });
  const create = useAtomCommand(botsEnvironment.kanbanCreateTicket, { label: "kanban create" });
  const remove = useAtomCommand(botsEnvironment.kanbanDeleteTicket, { label: "kanban delete" });
  const link = useAtomCommand(botsEnvironment.kanbanLinkThread, { label: "kanban link" });
  const unlink = useAtomCommand(botsEnvironment.kanbanUnlinkThread, { label: "kanban unlink" });
  const sync = useAtomCommand(botsEnvironment.kanbanSync, { label: "kanban sync" });
  const saveView = useAtomCommand(botsEnvironment.kanbanSaveView, { label: "kanban save view" });
  const deleteView = useAtomCommand(botsEnvironment.kanbanDeleteView, {
    label: "kanban delete view",
  });
  const reorderViews = useAtomCommand(botsEnvironment.kanbanReorderViews, {
    label: "kanban reorder views",
  });
  const importViews = useAtomCommand(botsEnvironment.kanbanImportLinearViews, {
    label: "kanban import views",
  });
  const aiFilter = useAtomCommand(botsEnvironment.kanbanAiFilter, {
    label: "kanban ai filter",
    reportFailure: false,
  });
  const canEdit = useAtomValue(botsEnvironment.kanbanMoveTicket.permissionAtom(environmentId));
  const canEditViews = useAtomValue(botsEnvironment.kanbanSaveView.permissionAtom(environmentId));
  const canSync = useAtomValue(botsEnvironment.kanbanSync.permissionAtom(environmentId));
  const [syncing, setSyncing] = useState(false);

  // A bare /kanban opens what the user last saw; any param means the URL decides.
  const rememberedProject =
    remembered.project !== null && projectTitles.has(ProjectId.make(remembered.project))
      ? ProjectId.make(remembered.project)
      : null;
  const scope = hasKanbanSearch(search) ? (search.project ?? null) : rememberedProject;
  const scopeViews = viewsForScope(snapshot.views, scope);
  const active = pickActiveView(scopeViews, search.view, remembered.views[scopeKey(scope)]);
  const draft = active === null ? KANBAN_DEFAULT_VIEW_CONFIG : draftOf(active, drafts);
  const dirty = active !== null && isDirty(active, drafts);
  const config = effectiveConfig(draft, searchText);

  const shown = applyPendingDrops(snapshot, pending);
  const ownerName = snapshot.accounts[0]?.userName ?? null;
  const lookups = buildKanbanLookups(snapshot, bots, ownerName);
  const threadsById = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId && shell.archivedAt === null)
      .map((shell) => [shell.id, shell]),
  );
  const context: KanbanViewContext = {
    now: Date.parse(`${nowMinute}:00Z`),
    threadStatus: (threadId) => {
      const shell = threadsById.get(threadId);
      return shell === undefined ? null : threadCardStatus(shell);
    },
    personName: (personId) => personDisplay(lookups, personId).name,
    projectName: (projectId) => projectTitles.get(projectId) ?? null,
  };
  const view = buildKanbanView(shown, scope, config, context);

  const issueOpen = search.issue !== undefined;
  const openTicket =
    search.issue === undefined
      ? null
      : findIssue(shown.tickets, scope, search.issue, search.issueProject);
  const maximized = issueOpen && search.full === 1;

  const go = (next: KanbanSearch, replace: boolean) =>
    void navigate({ to: "/kanban", search: next, replace });
  const searchFor = (patch: {
    readonly scope?: ProjectId | null;
    readonly view?: KanbanViewId | null;
    readonly issue?: string | null;
    readonly full?: boolean;
  }): KanbanSearch => {
    const nextScope = patch.scope === undefined ? scope : patch.scope;
    const nextView = patch.view === undefined ? (active?.id ?? null) : patch.view;
    const issue = patch.issue === undefined ? (search.issue ?? null) : patch.issue;
    const issueProject = patch.issue === undefined ? search.issueProject : undefined;
    const full = patch.full ?? search.full === 1;
    return {
      ...(nextScope === null ? {} : { project: nextScope }),
      ...(nextView === null ? {} : { view: nextView }),
      ...(issue === null ? {} : { issue }),
      ...(issue === null || issueProject === undefined ? {} : { issueProject }),
      ...(issue !== null && full ? { full: 1 as const } : {}),
    };
  };

  const selectScope = (projectId: ProjectId | null) => {
    const key = scopeKey(projectId);
    const nextView = pickActiveView(
      viewsForScope(snapshot.views, projectId),
      undefined,
      remembered.views[key],
    );
    setRemembered((current) => ({ ...current, project: projectId }));
    go(searchFor({ scope: projectId, view: nextView?.id ?? null }), true);
  };
  const selectView = (viewId: KanbanViewId) => {
    setRemembered((current) => ({
      ...current,
      views: { ...current.views, [scopeKey(scope)]: viewId },
    }));
    go(searchFor({ view: viewId }), true);
  };
  // Reads the URL at click time, so card handlers stay stable while the open issue changes.
  const activeId = active?.id ?? null;
  const openIssue = (ticket: KanbanTicket) =>
    void navigate({
      to: "/kanban",
      search: (previous) =>
        withIssue(
          hasKanbanSearch(previous)
            ? previous
            : {
                ...(scope === null ? {} : { project: scope }),
                ...(activeId === null ? {} : { view: activeId }),
              },
          shown.tickets,
          scope,
          ticket,
        ),
    });
  const closeIssue = () => go(searchFor({ issue: null }), true);
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  const setDraft = (next: KanbanViewConfig) => {
    if (active !== null) setDrafts((current) => withDraft(current, active, next));
  };
  const discard = () => {
    if (active !== null) setDrafts((current) => withoutDraft(current, active.id));
  };
  // `draft` is this render's, so edits made while a save runs stay a draft.
  const dropSavedDraft = (viewId: KanbanViewId, saved: KanbanViewConfig) =>
    setDrafts((current) => withoutSavedDraft(current, viewId, saved));
  const saveChanges = async () => {
    if (active === null) return;
    const result = await saveView({ environmentId, input: saveViewInput(active, draft) });
    if (reportCommandResult(`Could not save "${active.name}"`, result)) {
      dropSavedDraft(active.id, draft);
    }
  };
  const saveAs = async (name: string, everywhere: boolean) => {
    const result = await saveView({
      environmentId,
      input: saveAsInput(name, everywhere, scope, draft),
    });
    if (!reportCommandResult("Could not save the view", result) || result._tag !== "Success")
      return;
    if (active !== null) dropSavedDraft(active.id, draft);
    selectView(result.value.id);
  };
  const renameView = async (viewId: KanbanViewId, name: string) => {
    const target = snapshot.views.find((candidate) => candidate.id === viewId);
    if (target === undefined) return;
    reportCommandResult(
      "Could not rename the view",
      await saveView({ environmentId, input: renameViewInput(target, name) }),
    );
  };
  const removeView = async (viewId: KanbanViewId) => {
    const result = await deleteView({ environmentId, input: { viewId } });
    if (reportCommandResult("Could not delete the view", result)) {
      setDrafts((current) => withoutDraft(current, viewId));
    }
  };
  const reorder = async (ids: KanbanViewId[]) => {
    reportCommandResult(
      "Could not reorder the views",
      await reorderViews({
        environmentId,
        input: { viewIds: reorderedViewIds(snapshot.views, ids) },
      }),
    );
  };
  const importLinear = async (accountId: LinearAccountId) => {
    const result = await importViews({ environmentId, input: { accountId } });
    if (!reportCommandResult("Could not import views from Linear", result)) return;
    if (result._tag !== "Success") return;
    const summary = importSummary(result.value);
    toastManager.add({
      type: "success",
      title: summary.title,
      ...(summary.description === null ? {} : { description: summary.description }),
    });
  };
  const runAiFilter = async (text: string): Promise<KanbanAiFilterOutcome> => {
    const result = await aiFilter({ environmentId, input: { text, projectId: scope } });
    if (result._tag === "Success") return { ok: true, filters: [...result.value.filters] };
    return {
      ok: false,
      message: commandFailureMessage(result) ?? "The filter could not be read.",
    };
  };
  const describeView = (candidate: KanbanView) =>
    candidate.config.filters.length === 0
      ? "Every ticket"
      : candidate.config.filters
          .map((clause) => {
            const words = describeClause(snapshot, clause, context);
            return [words.field, words.op, words.value].filter((part) => part !== "").join(" ");
          })
          .join(" · ");

  const runSync = async () => {
    setSyncing(true);
    const result = await sync({
      environmentId,
      input: scope === null ? {} : { projectId: scope },
    });
    setSyncing(false);
    reportCommandResult("Could not sync with Linear", result);
  };

  const drop = async (ticket: KanbanTicket, actions: ReadonlyArray<KanbanDropAction>) => {
    // A drop shows at once and holds until the server answers.
    setPending((current) => new Map(current).set(ticket.id, actions));
    for (const action of actions) {
      const result =
        action.kind === "move"
          ? await move({ environmentId, input: { ticketId: ticket.id, to: action.to } })
          : await update({ environmentId, input: { ticketId: ticket.id, patch: action.patch } });
      if (!reportCommandResult(`Could not move ${ticket.identifier}`, result)) break;
    }
    setPending((current) => {
      const next = new Map(current);
      next.delete(ticket.id);
      return next;
    });
  };

  const projectLink =
    scope === null ? undefined : snapshot.links.find((l) => l.projectId === scope);
  const canCreate = scope !== null && canEdit;
  const createTicket = async (title: string, state: string | null) => {
    if (scope === null) return false;
    const localState = KANBAN_LOCAL_STATES.find((candidate) => candidate === state);
    const result = await create({
      environmentId,
      input: {
        projectId: scope,
        title,
        ...(projectLink === undefined && localState !== undefined ? { state: localState } : {}),
      },
    });
    return reportCommandResult("Could not create the ticket", result);
  };
  // Linear picks a new issue's column, so a linked board offers creation once.
  const canAddTo = (group: KanbanGroup) =>
    canCreate &&
    draft.groupBy === "status" &&
    (projectLink === undefined ? isLocalState(group.id) : group.id === view.columns[0]?.id);
  const createIn = (group: KanbanGroup, title: string) => createTicket(title, group.id);

  const properties = new Set(draft.properties);
  const workspaceBots = new Map(
    snapshot.workspaces.map((workspace) => [
      workspace.id,
      workspace.botIds.flatMap((botId) => lookups.botsById.get(botId) ?? []),
    ]),
  );
  // Keyed on the server's tickets: a pending drop changes no link or handler.
  const threadLinks = ticketThreadLinks(snapshot.tickets, threadsById);
  const handlers = new Map(
    snapshot.tickets.map((ticket) => [
      ticket.id,
      {
        onOpen: () => openIssue(ticket),
        onLinkThread: async (threadId: ThreadId) =>
          reportCommandResult(
            "Could not link the thread",
            await link({ environmentId, input: { ticketId: ticket.id, threadId } }),
          ),
        onUnlinkThread: async (threadId: ThreadId) =>
          reportCommandResult(
            "Could not unlink the thread",
            await unlink({ environmentId, input: { ticketId: ticket.id, threadId } }),
          ),
        onDelete: async () => {
          if (!(await confirmDestructive(`Delete ${ticket.identifier}?\n${ticket.title}`))) return;
          reportCommandResult(
            "Could not delete the ticket",
            await remove({ environmentId, input: { ticketId: ticket.id } }),
          );
        },
      },
    ]),
  );
  const ticketProps = (ticket: KanbanTicket): KanbanTicketViewProps => {
    const links = threadLinks.get(ticket.id);
    const own = handlers.get(ticket.id);
    return {
      environmentId,
      ticket,
      lookups,
      properties,
      workspaceBots: workspaceBots.get(workspaceOf(snapshot, ticket)) ?? NO_BOTS,
      threads: links?.threads ?? NO_THREADS,
      projectTitle: scope === null ? (projectTitles.get(ticket.projectId) ?? null) : null,
      selected: ticket.id === openTicket?.id,
      canEdit,
      linkableThreads: links?.linkable ?? NO_OPTIONS,
      onOpenThread: openThread,
      onOpen: own?.onOpen ?? noop,
      onLinkThread: own?.onLinkThread ?? noop,
      onUnlinkThread: own?.onUnlinkThread ?? noop,
      onDelete: own?.onDelete ?? noop,
    };
  };

  const scopeTitle = scope === null ? "All projects" : (projectTitles.get(scope) ?? scope);
  const statusLine =
    projectLink !== undefined
      ? `${projectLink.teamName}${projectLink.linearProjectName ? ` · ${projectLink.linearProjectName}` : ""} on Linear`
      : scope !== null
        ? "Local board"
        : "Pick a project to add tickets. A project linked to Linear shows its team's own columns.";

  return (
    <div className="relative flex min-h-0 flex-1">
      <PageFrame
        className={maximized ? "w-0 flex-none overflow-hidden" : "flex-1"}
        reserveNativeControls={isElectron && !issueOpen}
        title={
          <>
            <PageTitle />
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost" aria-label="Board project" />}>
                <span className="max-w-48 truncate">{scopeTitle}</span>
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start" className="max-h-96 overflow-y-auto">
                <MenuRadioGroup
                  value={scope ?? ALL_PROJECTS}
                  onValueChange={(value: string) =>
                    selectScope(value === ALL_PROJECTS ? null : ProjectId.make(value))
                  }
                >
                  <MenuRadioItem value={ALL_PROJECTS}>All projects</MenuRadioItem>
                  {projects.length > 0 ? <MenuSeparator /> : null}
                  {projects.map((project) => (
                    <MenuRadioItem key={project.id} value={project.id}>
                      {project.title}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </>
        }
        actions={
          <div className="flex items-center gap-1.5">
            {snapshot.links.length > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canSync || syncing}
                onClick={() => void runSync()}
              >
                <RefreshCwIcon className={cn("size-3.5", syncing && "animate-spin")} />
                Sync now
              </Button>
            ) : null}
            {canCreate ? (
              <NewIssueButton
                linked={projectLink !== undefined}
                onCreate={(title) => createTicket(title, null)}
              />
            ) : null}
            <AccountsLink />
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-(--workspace-gutter-start) pb-2">
          <KanbanViewTabs
            views={scopeViews}
            activeViewId={active?.id ?? null}
            dirty={dirty}
            canEdit={canEditViews}
            lookupsDescribe={describeView}
            botName={(botId) => lookups.botsById.get(botId)?.name ?? "A deleted bot"}
            onSelect={selectView}
            onSaveChanges={() => void saveChanges()}
            onDiscardChanges={discard}
            onSaveAs={(name, everywhere) => void saveAs(name, everywhere)}
            onRename={(viewId, name) => void renameView(viewId, name)}
            onDelete={(viewId) => void removeView(viewId)}
            onReorder={(ids) => void reorder(ids)}
            linearAccounts={snapshot.accounts}
            onImportLinear={(accountId) => void importLinear(accountId)}
          />
          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            <KanbanFilterBar
              snapshot={snapshot}
              projectId={scope}
              lookups={lookups}
              context={context}
              filters={draft.filters}
              onChange={(filters: KanbanFilterClause[]) => setDraft({ ...draft, filters })}
              search={searchText}
              onSearch={setSearchText}
              onAiFilter={runAiFilter}
            />
            <KanbanDisplayMenu
              config={draft}
              onChange={setDraft}
              dirty={dirty}
              {...(dirty ? { onReset: discard } : {})}
            />
          </div>
        </div>
        <p className="truncate px-(--workspace-gutter-start) pb-2 text-muted-foreground text-xs">
          {statusLine}
          {projectLink?.syncError ? (
            <span className="text-destructive"> · sync failed: {projectLink.syncError}</span>
          ) : null}
          {props.error ? <span className="text-destructive"> · {props.error}</span> : null}
        </p>
        {draft.layout === "list" ? (
          <KanbanList
            view={view}
            lookups={lookups}
            ticketProps={ticketProps}
            canAddTo={canAddTo}
            onCreate={createIn}
          />
        ) : (
          <KanbanBoard
            view={view}
            lookups={lookups}
            ticketProps={ticketProps}
            canAddTo={canAddTo}
            onCreate={createIn}
            snapshot={shown}
            config={draft}
            onHideColumn={(groupId) =>
              setDraft({
                ...draft,
                hiddenColumns: [...draft.hiddenColumns.filter((id) => id !== groupId), groupId],
              })
            }
            onShowColumn={(groupId) => {
              const group = view.hiddenColumns.find((candidate) => candidate.id === groupId);
              if (group !== undefined) setDraft(withColumnShown(draft, group));
            }}
            onDrop={(ticket, actions) => void drop(ticket, actions)}
          />
        )}
      </PageFrame>
      {issueOpen ? (
        <PreviewPanelShell
          mode="inline"
          maximized={maximized}
          widthStorageKey="t3code:kanban:issue-width"
          defaultWidth={600}
        >
          {openTicket === null ? (
            <IssueMissing identifier={search.issue ?? ""} onClose={closeIssue} />
          ) : (
            <KanbanIssueView
              environmentId={environmentId}
              ticket={openTicket}
              snapshot={shown}
              lookups={lookups}
              projectTitle={projectTitles.get(openTicket.projectId) ?? openTicket.projectId}
              canEdit={canEdit}
              maximized={maximized}
              onToggleMaximized={() => go(searchFor({ full: !maximized }), true)}
              onClose={closeIssue}
              onOpenTicket={(ticketId: KanbanTicketId) => {
                const target = shown.tickets.find((candidate) => candidate.id === ticketId);
                if (target !== undefined) openIssue(target);
              }}
              onOpenThread={openThread}
            />
          )}
        </PreviewPanelShell>
      ) : null}
    </div>
  );
}

const NO_THREADS: ReadonlyArray<KanbanLinkedThread> = [];
const NO_OPTIONS: ReadonlyArray<KanbanThreadOption> = [];
const LINKABLE_LIMIT = 30;
const noop = () => {};

/**
 * Each ticket's linked threads and the threads it can still link (its project's, newest first,
 * no bot threads). Tickets with nothing linked share their project's list.
 */
function ticketThreadLinks(
  tickets: ReadonlyArray<KanbanTicket>,
  threadsById: ReadonlyMap<ThreadId, EnvironmentThreadShell>,
) {
  const byProject = new Map<ProjectId, KanbanThreadOption[]>();
  for (const shell of [...threadsById.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  )) {
    if (shell.id.startsWith("bot:")) continue;
    const options = byProject.get(shell.projectId) ?? [];
    options.push({ id: shell.id, title: shell.title });
    byProject.set(shell.projectId, options);
  }
  const firstOfProject = new Map(
    [...byProject].map(([projectId, options]) => [projectId, options.slice(0, LINKABLE_LIMIT)]),
  );
  return new Map(
    tickets.map((ticket) => {
      const all = byProject.get(ticket.projectId) ?? [];
      const linked = new Set(ticket.threadIds);
      const threads = ticket.threadIds.flatMap((threadId) => {
        const shell = threadsById.get(threadId);
        return shell === undefined
          ? []
          : [{ id: shell.id, title: shell.title, status: threadCardStatus(shell) }];
      });
      return [
        ticket.id,
        {
          threads: threads.length === 0 ? NO_THREADS : threads,
          linkable:
            linked.size === 0
              ? (firstOfProject.get(ticket.projectId) ?? NO_OPTIONS)
              : all.filter((option) => !linked.has(option.id)).slice(0, LINKABLE_LIMIT),
        },
      ];
    }),
  );
}

function NewIssueButton(props: {
  readonly linked: boolean;
  readonly onCreate: (title: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
        <PlusIcon className="size-3.5" />
        New issue
      </PopoverTrigger>
      <PopoverPopup align="end" width="sm" padding="compact">
        <div className="flex flex-col gap-2">
          <span className="font-medium text-sm">
            {props.linked ? "New issue in Linear" : "New local ticket"}
          </span>
          <KanbanNewTicketInput onCreate={props.onCreate} onDone={() => setOpen(false)} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function IssueMissing(props: { readonly identifier: string; readonly onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{props.identifier}</span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Close issue"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Issue not on this board</EmptyTitle>
          <EmptyDescription>
            {props.identifier} is not among the tickets this host knows. It may have moved, been
            deleted, or belong to a project that is not linked.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
