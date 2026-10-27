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
import { useAtomValue } from "@effect/atom-react";
import {
  KANBAN_DEFAULT_PROPERTIES,
  KanbanTicketTitle,
  type BotDirectoryEntry,
  type EnvironmentId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type KanbanWorkspaceId,
  type LinearAccountId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { PlusIcon, RefreshCwIcon, SettingsIcon, SquareKanbanIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset, SidebarTrigger } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  botsEnvironment,
  useBotDirectory,
  useBotsEnvironmentId,
  useKanbanSnapshot,
} from "../../state/bots";
import { useProjects, useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { confirmDestructive, reportCommandResult } from "../botsSettingsShared";
import { KanbanCard, type KanbanThreadOption } from "./KanbanCard";
import { buildKanbanLookups } from "./kanbanLookups";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  buildBoard,
  dropTarget,
  sameStatus,
  threadCardStatus,
  workspaceOf,
  type KanbanColumn,
  type KanbanFilter,
} from "@t3tools/client-runtime/kanban-board";

const FILTER_KEY = "t3code:bots:kanban-filter";
const CARD_PROPERTIES = new Set(KANBAN_DEFAULT_PROPERTIES);
const StoredFilter = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
});
const ALL = "all";
const isTitle = Schema.is(KanbanTicketTitle);

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
        <PageFrame title="Kanban">
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

function PageFrame(props: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <SidebarTrigger className="md:hidden" />
        <h1 className="truncate font-medium text-sm">{props.title}</h1>
        <div className="min-w-0 flex-1" />
        {props.actions}
      </WorkspacePageHeader>
      {props.children}
    </div>
  );
}

function KanbanBoardPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { snapshot, error } = useKanbanSnapshot(environmentId);
  const { directory } = useBotDirectory(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [stored, setStored] = useLocalStorage(
    FILTER_KEY,
    { projectId: null, workspaceId: null, accountId: null },
    StoredFilter,
  );
  const filter = stored as KanbanFilter;
  const sync = useAtomCommand(botsEnvironment.kanbanSync, { label: "kanban sync" });
  const canSync = useAtomValue(botsEnvironment.kanbanSync.permissionAtom(environmentId));
  const [syncing, setSyncing] = useState(false);

  const runSync = async () => {
    setSyncing(true);
    const result = await sync({
      environmentId,
      input: filter.projectId === null ? {} : { projectId: filter.projectId },
    });
    setSyncing(false);
    reportCommandResult("Could not sync with Linear", result);
  };

  const hasLinks = (snapshot?.links.length ?? 0) > 0;
  return (
    <PageFrame
      title="Kanban"
      actions={
        <div className="flex items-center gap-1.5">
          {hasLinks ? (
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
          <Button
            size="xs"
            variant="ghost-muted"
            render={<Link to="/settings/bots" hash="kanban" />}
          >
            <SettingsIcon className="size-3.5" />
            Accounts & links
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="px-6 py-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : snapshot === null ? (
        <p className="px-6 py-4 text-muted-foreground text-sm" role="status">
          Loading the board…
        </p>
      ) : (
        <KanbanBoardView
          environmentId={environmentId}
          snapshot={snapshot}
          bots={directory?.bots ?? []}
          projects={projects.map((project) => ({ id: project.id, title: project.title }))}
          filter={filter}
          onFilter={(next) => setStored({ ...filter, ...next })}
        />
      )}
    </PageFrame>
  );
}

function FilterSelect(props: {
  label: string;
  value: string | null;
  allLabel: string;
  options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  onChange: (value: string | null) => void;
}) {
  const current = props.options.find((option) => option.id === props.value);
  return (
    <Select
      value={props.value ?? ALL}
      onValueChange={(value) => props.onChange(value === null || value === ALL ? null : value)}
    >
      <SelectTrigger aria-label={props.label} className="w-48" size="xs">
        <SelectValue>{current?.label ?? props.allLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={ALL}>{props.allLabel}</SelectItem>
        {props.options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function KanbanBoardView(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: KanbanSnapshot;
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly filter: KanbanFilter;
  readonly onFilter: (next: Partial<KanbanFilter>) => void;
}) {
  const { environmentId, snapshot, filter } = props;
  const move = useAtomCommand(botsEnvironment.kanbanMoveTicket, { label: "kanban move" });
  const create = useAtomCommand(botsEnvironment.kanbanCreateTicket, { label: "kanban create" });
  const remove = useAtomCommand(botsEnvironment.kanbanDeleteTicket, { label: "kanban delete" });
  const link = useAtomCommand(botsEnvironment.kanbanLinkThread, { label: "kanban link" });
  const unlink = useAtomCommand(botsEnvironment.kanbanUnlinkThread, { label: "kanban unlink" });
  const canEdit = useAtomValue(botsEnvironment.kanbanMoveTicket.permissionAtom(environmentId));
  const shells = useThreadShells();
  const navigate = useNavigate();
  // A move shows at once and holds until a snapshot arrives with the ticket's new status.
  const [pending, setPending] = useState<ReadonlyMap<string, KanbanTicketStatus>>(new Map());
  const [dragging, setDragging] = useState<KanbanTicket | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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

  const projectTitles = new Map(props.projects.map((project) => [project.id, project.title]));
  const threadsById = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId && shell.archivedAt === null)
      .map((shell) => [shell.id, shell]),
  );
  const botsById = new Map(props.bots.map((bot) => [bot.id, bot]));
  const lookups = buildKanbanLookups(snapshot, props.bots, null);
  const workspaceBots = new Map(
    snapshot.workspaces.map((workspace) => [
      workspace.id,
      workspace.botIds.flatMap((botId) => {
        const bot = botsById.get(botId);
        return bot === undefined ? [] : [bot];
      }),
    ]),
  );
  const linkableThreads = (ticket: KanbanTicket): ReadonlyArray<KanbanThreadOption> =>
    [...threadsById.values()]
      .filter(
        (shell) =>
          shell.projectId === ticket.projectId &&
          !ticket.threadIds.includes(shell.id) &&
          !shell.id.startsWith("bot:"),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 30)
      .map((shell) => ({ id: shell.id, title: shell.title }));

  const onDragStart = (event: DragStartEvent) => {
    setDragging(shown.tickets.find((ticket) => ticket.id === event.active.id) ?? null);
  };
  const onDragEnd = async (event: DragEndEvent) => {
    setDragging(null);
    const ticket = shown.tickets.find((candidate) => candidate.id === event.active.id);
    const column = board.columns.find((candidate) => candidate.id === event.over?.id);
    if (ticket === undefined || column === undefined) return;
    const to = dropTarget(shown, ticket, column);
    if (to === null || sameStatus(to, ticket.status)) return;
    setPending((current) => new Map(current).set(ticket.id, to));
    const result = await move({ environmentId, input: { ticketId: ticket.id, to } });
    setPending((current) => {
      const next = new Map(current);
      next.delete(ticket.id);
      return next;
    });
    reportCommandResult(`Could not move ${ticket.identifier}`, result);
  };

  const linkedProject =
    filter.projectId === null
      ? null
      : (snapshot.links.find((candidate) => candidate.projectId === filter.projectId) ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-(--workspace-gutter-start) pb-3">
        <FilterSelect
          label="Project"
          value={filter.projectId}
          allLabel="All projects"
          options={props.projects.map((project) => ({ id: project.id, label: project.title }))}
          onChange={(value) => props.onFilter({ projectId: value as ProjectId | null })}
        />
        <FilterSelect
          label="Workspace"
          value={filter.workspaceId}
          allLabel="All workspaces"
          options={snapshot.workspaces.map((workspace) => ({
            id: workspace.id,
            label: workspace.name,
          }))}
          onChange={(value) => props.onFilter({ workspaceId: value as KanbanWorkspaceId | null })}
        />
        {snapshot.accounts.length > 0 ? (
          <FilterSelect
            label="Linear account"
            value={filter.accountId}
            allLabel="All accounts"
            options={snapshot.accounts.map((account) => ({
              id: account.id,
              label: `${account.name} (${account.organizationName})`,
            }))}
            onChange={(value) => props.onFilter({ accountId: value as LinearAccountId | null })}
          />
        ) : null}
        <span className="text-muted-foreground text-xs">
          {linkedProject
            ? `${linkedProject.teamName}${linkedProject.linearProjectName ? ` · ${linkedProject.linearProjectName}` : ""} on Linear${linkedProject.syncError ? ` · sync failed: ${linkedProject.syncError}` : ""}`
            : filter.projectId !== null
              ? "Local board"
              : null}
        </span>
      </div>
      <DndContext
        sensors={sensors}
        // The column under the pointer takes the card, not the one the wide card overlaps most.
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={(e) => void onDragEnd(e)}
      >
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-(--workspace-gutter-start) pb-4">
          {board.columns.map((column) => (
            <KanbanColumnView
              key={column.id}
              column={column}
              dragging={dragging}
              accepts={dragging !== null && dropTarget(shown, dragging, column) !== null}
              footer={
                // Linear picks a new issue's column, so a linked board offers creation once.
                filter.projectId !== null &&
                canEdit &&
                (column.kind === "local" || column === board.columns[0]) ? (
                  <NewTicket
                    onCreate={async (title) => {
                      const result = await create({
                        environmentId,
                        input: {
                          projectId: filter.projectId!,
                          title,
                          ...(column.kind === "local" ? { state: column.state } : {}),
                        },
                      });
                      return reportCommandResult("Could not create the ticket", result);
                    }}
                  />
                ) : null
              }
            >
              {column.tickets.map((ticket) => (
                <KanbanCard
                  key={ticket.id}
                  environmentId={environmentId}
                  ticket={ticket}
                  lookups={lookups}
                  properties={CARD_PROPERTIES}
                  workspaceBots={workspaceBots.get(workspaceOf(snapshot, ticket)) ?? []}
                  threads={ticket.threadIds.flatMap((threadId) => {
                    const shell = threadsById.get(threadId);
                    return shell === undefined
                      ? []
                      : [{ id: shell.id, title: shell.title, status: threadCardStatus(shell) }];
                  })}
                  projectTitle={
                    filter.projectId === null ? (projectTitles.get(ticket.projectId) ?? null) : null
                  }
                  selected={false}
                  linkableThreads={linkableThreads(ticket)}
                  canEdit={canEdit}
                  onOpen={() => {
                    if (ticket.linear) window.open(ticket.linear.url, "_blank", "noopener");
                  }}
                  onOpenThread={(threadId: ThreadId) =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                    })
                  }
                  onLinkThread={async (threadId: ThreadId) =>
                    reportCommandResult(
                      "Could not link the thread",
                      await link({ environmentId, input: { ticketId: ticket.id, threadId } }),
                    )
                  }
                  onUnlinkThread={async (threadId: ThreadId) =>
                    reportCommandResult(
                      "Could not unlink the thread",
                      await unlink({ environmentId, input: { ticketId: ticket.id, threadId } }),
                    )
                  }
                  onDelete={async () => {
                    if (
                      !(await confirmDestructive(`Delete ${ticket.identifier}?\n${ticket.title}`))
                    )
                      return;
                    reportCommandResult(
                      "Could not delete the ticket",
                      await remove({ environmentId, input: { ticketId: ticket.id } }),
                    );
                  }}
                />
              ))}
            </KanbanColumnView>
          ))}
        </div>
        <DragOverlay>
          {dragging ? (
            <div className="w-72 rounded-lg border bg-card p-2.5 text-sm shadow-lg">
              <div className="font-mono text-2xs text-muted-foreground">{dragging.identifier}</div>
              {dragging.title}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {filter.projectId === null ? (
        <p className="px-(--workspace-gutter-start) pb-3 text-muted-foreground text-xs">
          Pick a project to add tickets. A project linked to Linear shows its team's own columns.
        </p>
      ) : null}
    </div>
  );
}

function KanbanColumnView(props: {
  column: KanbanColumn;
  dragging: KanbanTicket | null;
  accepts: boolean;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.column.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={props.column.title}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-xl bg-muted/40 p-2",
        props.dragging !== null && !props.accepts && "opacity-50",
        isOver && props.accepts && "ring-2 ring-ring",
      )}
    >
      <header className="flex items-center gap-2 px-1 pb-2 font-medium text-xs">
        {props.column.color ? (
          <span className="size-2 rounded-full" style={{ backgroundColor: props.column.color }} />
        ) : null}
        <span className="truncate">{props.column.title}</span>
        <span className="text-muted-foreground">{props.column.tickets.length}</span>
      </header>
      <div className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto">{props.children}</div>
      {props.footer}
    </section>
  );
}

function NewTicket({ onCreate }: { onCreate: (title: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (draft === null) {
    return (
      <Button
        size="xs"
        variant="ghost-muted"
        className="mt-2 justify-start"
        onClick={() => setDraft("")}
      >
        <PlusIcon className="size-3.5" />
        New ticket
      </Button>
    );
  }
  const submit = async () => {
    const title = draft.trim();
    if (!isTitle(title) || saving) return;
    setSaving(true);
    const ok = await onCreate(title);
    setSaving(false);
    if (ok) setDraft(null);
  };
  return (
    <form
      className="mt-2"
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
          if (event.key === "Escape") setDraft(null);
        }}
        onBlur={() => {
          if (draft.trim() === "" && !saving) setDraft(null);
        }}
      />
    </form>
  );
}
