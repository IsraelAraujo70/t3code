/**
 * The kanban tools. The calling bot comes from the trusted caller scope, and it reaches only the
 * workspaces the user made it responsible for (all of them, when the user made it responsible for
 * every workspace); no tool argument can widen that. A view on every board takes a bot responsible
 * for every workspace.
 */
import {
  KANBAN_DEFAULT_VIEW_CONFIG,
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_OWNER_PERSON_ID,
  kanbanBotPersonId,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  KanbanViewSaveInput,
  OrchestratorMcpFailure,
  type KanbanError,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketId,
  type KanbanTicketStatus,
  type KanbanView,
  type KanbanViewId,
  type KanbanWorkspaceId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as BotsService from "../BotsService.ts";
import { KanbanService, workspaceOfTicket } from "./KanbanService.ts";
import { priorityName } from "./linearMapping.ts";
import { kanbanToolTicketFilter } from "./toolFilters.ts";
import { KANBAN_LIST_DEFAULT, KANBAN_LIST_MAX, KanbanToolkit } from "./tools.ts";

const MAX_BODY_CHARS = 4_000;
const MAX_ENTRIES = 50;
const MAX_CHOICES = 100;

const kanbanFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/**
 * The calling bot and the workspaces it is responsible for, with a fresh snapshot. A bot
 * responsible for every workspace gets each one the snapshot has, so new ones count at once.
 */
const callerScope = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const bots = yield* BotsService.BotsService;
  const kanban = yield* KanbanService;
  const bot =
    scope.thread === undefined
      ? Option.none()
      : yield* bots.botForThread(scope.thread.threadId).pipe(Effect.mapError(kanbanFailure));
  if (Option.isNone(bot)) {
    return yield* denied("The kanban tools are only available in a bot's conversation.");
  }
  const snapshot = yield* kanban.readSnapshot.pipe(Effect.mapError(kanbanFailure));
  const everyWorkspace = snapshot.allWorkspacesBotIds.includes(bot.value.id);
  const workspaces = snapshot.workspaces.filter(
    (workspace) => everyWorkspace || workspace.botIds.includes(bot.value.id),
  );
  if (workspaces.length === 0) {
    return yield* denied(
      "You are not responsible for any Kanban workspace. The user assigns bots on the Kanban page.",
    );
  }
  return {
    kanban,
    snapshot,
    bot: bot.value,
    /** Who a local ticket's history names for this bot's writes. */
    actor: kanbanBotPersonId(bot.value.id),
    callerThreadId: scope.thread?.threadId,
    everyWorkspace,
    workspaceIds: new Set<KanbanWorkspaceId>(workspaces.map((workspace) => workspace.id)),
    workspaces,
  };
});

type CallerScope = Effect.Success<typeof callerScope>;

const accountsById = (snapshot: KanbanSnapshot) =>
  new Map(snapshot.accounts.map((account) => [account.id, account]));

const stateNamer = (snapshot: KanbanSnapshot) => {
  const states = new Map(snapshot.states.map((state) => [state.id, state.name]));
  return (status: KanbanTicketStatus) =>
    status.kind === "local"
      ? KANBAN_LOCAL_STATE_LABELS[status.state]
      : (states.get(status.stateId) ?? "Unknown");
};

/** What a bot sees of each ticket of one snapshot. */
const ticketViewer = (snapshot: KanbanSnapshot) => {
  const accounts = accountsById(snapshot);
  const stateName = stateNamer(snapshot);
  const labels = new Map(snapshot.labels.map((label) => [label.id, label.name]));
  const people = new Map(snapshot.people.map((person) => [person.id, person.name]));
  return (ticket: KanbanTicket) => {
    const status = ticket.status;
    return {
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      projectId: ticket.projectId,
      workspaceId: workspaceOfTicket(ticket, accounts) ?? LOCAL_KANBAN_WORKSPACE_ID,
      state: {
        id: status.kind === "local" ? status.state : status.stateId,
        name: stateName(status),
        kind: status.kind,
      },
      priority: {
        value: ticket.priority,
        name: priorityName(ticket.priority) ?? String(ticket.priority),
      },
      assignee:
        ticket.assigneeId === null
          ? null
          : {
              id: ticket.assigneeId,
              name: ticket.assigneeName ?? people.get(ticket.assigneeId) ?? ticket.assigneeId,
            },
      labels: ticket.labelIds.map((id) => labels.get(id) ?? id),
      parent: ticket.parent?.identifier ?? null,
      subIssues: ticket.subIssues,
      pullRequests: ticket.pullRequests.map((pr) => `#${pr.number} ${pr.state} ${pr.url}`),
      dueDate: ticket.dueDate,
      botId: ticket.botId,
      url: ticket.linear?.url ?? null,
      threadIds: ticket.threadIds,
    };
  };
};

/** A ticket in one of the caller's workspaces. */
const responsibleTicket = (caller: CallerScope, ticketId: KanbanTicketId) => {
  const ticket = caller.snapshot.tickets.find((candidate) => candidate.id === ticketId);
  const workspace =
    ticket === undefined ? null : workspaceOfTicket(ticket, accountsById(caller.snapshot));
  return ticket === undefined || workspace === null || !caller.workspaceIds.has(workspace)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `No ticket ${ticketId} in the workspaces you are responsible for.`,
        }),
      )
    : Effect.succeed(ticket);
};

/** The workspace a project's new tickets land in: its link's organization, or local. */
const workspaceOfProject = (snapshot: KanbanSnapshot, projectId: ProjectId) => {
  const link = snapshot.links.find((candidate) => candidate.projectId === projectId);
  if (link === undefined) return LOCAL_KANBAN_WORKSPACE_ID;
  const account = snapshot.accounts.find((candidate) => candidate.id === link.accountId);
  return account === undefined ? null : linearWorkspaceId(account.organizationId);
};

/** The labels a ticket can take (no label groups) and the people it can be assigned to. */
const ticketChoices = (caller: CallerScope, ticket: KanbanTicket, trimmed: string[]) => {
  const { snapshot } = caller;
  const groups = new Set(snapshot.labels.flatMap((label) => label.parentId ?? []));
  const linear = ticket.linear;
  const accounts = accountsById(snapshot);
  const workspace = workspaceOfTicket(ticket, accounts);
  const organizationId = linear === null ? null : accounts.get(linear.accountId)?.organizationId;
  const labels = snapshot.labels.filter(
    (label) =>
      !groups.has(label.id) &&
      label.workspaceId === workspace &&
      label.source === (linear === null ? "local" : "linear") &&
      (linear === null || label.teamId === null || label.teamId === linear.teamId),
  );
  const assignees =
    linear === null
      ? [
          { id: KANBAN_OWNER_PERSON_ID, name: "The user" },
          { id: caller.actor, name: `${caller.bot.name} (you)` },
        ]
      : snapshot.people
          .filter((person) => person.active && person.organizationId === organizationId)
          .map((person) => ({ id: person.id, name: person.name }));
  const capped = <A>(items: ReadonlyArray<A>, what: string) => {
    if (items.length <= MAX_CHOICES) return items;
    trimmed.push(`${what}: first ${MAX_CHOICES} of ${items.length}`);
    return items.slice(0, MAX_CHOICES);
  };
  return {
    labels: capped(
      labels.map((label) => ({ id: label.id, name: label.name })),
      "labels",
    ),
    assignees: capped(assignees, "assignees"),
  };
};

export const trimBody = (text: string, what: string, trimmed: string[]) => {
  if (text.length <= MAX_BODY_CHARS) return text;
  trimmed.push(`${what}: first ${MAX_BODY_CHARS} of ${text.length} characters`);
  const cut = text.slice(0, MAX_BODY_CHARS);
  // Never end on half of a surrogate pair (an emoji cut in two).
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

const newest = <A>(items: ReadonlyArray<A>, what: string, trimmed: string[]) => {
  if (items.length <= MAX_ENTRIES) return items;
  trimmed.push(`${what}: newest ${MAX_ENTRIES} of ${items.length}`);
  return items.slice(-MAX_ENTRIES);
};

/** A project's board in one of the caller's workspaces. */
const reachesProject = (caller: CallerScope, projectId: ProjectId) => {
  const workspace = workspaceOfProject(caller.snapshot, projectId);
  return workspace !== null && caller.workspaceIds.has(workspace);
};

/** The caller sees every board's views; it changes them only when every workspace is its own. */
const readsBoard = (caller: CallerScope, projectId: ProjectId | null) =>
  projectId === null || reachesProject(caller, projectId);
const writesBoard = (caller: CallerScope, projectId: ProjectId | null) =>
  projectId === null ? caller.everyWorkspace : reachesProject(caller, projectId);

const viewInfo = (caller: CallerScope) => (view: KanbanView) => ({
  id: view.id,
  name: view.name,
  icon: view.icon,
  projectId: view.projectId,
  config: view.config,
  createdBy: view.createdBy,
  updatedBy: view.updatedBy,
  editable: writesBoard(caller, view.projectId),
});

const boardRefusal = (projectId: ProjectId | null) =>
  denied(
    projectId === null
      ? "A view on every board needs you responsible for every workspace; the user turns that on in the Kanban settings."
      : "That project's board is in a workspace you are not responsible for.",
  );

/** A view the caller may change. */
const writableView = (caller: CallerScope, viewId: KanbanViewId) => {
  const view = caller.snapshot.views.find((candidate) => candidate.id === viewId);
  if (view === undefined || !readsBoard(caller, view.projectId)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `No view ${viewId} on the boards of the workspaces you are responsible for.`,
      }),
    );
  }
  return writesBoard(caller, view.projectId)
    ? Effect.succeed(view)
    : Effect.fail(boardRefusal(view.projectId));
};

const decodeViewSave = Schema.decodeUnknownEffect(KanbanViewSaveInput);

const withView = (caller: CallerScope) => (effect: Effect.Effect<KanbanTicket, KanbanError>) =>
  effect.pipe(
    Effect.mapError(kanbanFailure),
    Effect.flatMap((ticket) =>
      caller.kanban.readSnapshot.pipe(
        Effect.mapError(kanbanFailure),
        Effect.map((snapshot) => ticketViewer(snapshot)(ticket)),
      ),
    ),
  );

export const layer = McpToolAccess.toLayer(KanbanToolkit, {
  kanban_view_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      return {
        views: caller.snapshot.views
          .filter((view) => readsBoard(caller, view.projectId))
          .map(viewInfo(caller)),
      };
    }),
  ),
  kanban_view_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const existing = input.id === undefined ? undefined : yield* writableView(caller, input.id);
      const name = input.name ?? existing?.name;
      const projectId = input.projectId === undefined ? existing?.projectId : input.projectId;
      if (name === undefined || projectId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A new view needs name and projectId (null for a view on every board).",
        });
      }
      if (!writesBoard(caller, projectId)) return yield* boardRefusal(projectId);
      const save = yield* decodeViewSave({
        ...(existing === undefined ? {} : { id: existing.id }),
        projectId,
        name,
        icon: input.icon === undefined ? (existing?.icon ?? null) : input.icon,
        config: { ...(existing?.config ?? KANBAN_DEFAULT_VIEW_CONFIG), ...input.config },
      }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `The view is not valid: ${error.message}`,
            }),
        ),
      );
      const view = yield* caller.kanban
        .saveView(save, caller.actor)
        .pipe(Effect.mapError(kanbanFailure));
      return viewInfo(caller)(view);
    }),
  ),
  kanban_view_delete: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const view = yield* writableView(caller, input.viewId);
      return yield* caller.kanban
        .deleteView({ viewId: view.id })
        .pipe(Effect.mapError(kanbanFailure));
    }),
  ),
  kanban_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const { snapshot } = caller;
      const accounts = accountsById(snapshot);
      const matches = kanbanToolTicketFilter(snapshot, input, caller.bot.id);
      const matched = snapshot.tickets
        .filter((ticket) => {
          const workspace = workspaceOfTicket(ticket, accounts);
          return (
            workspace !== null &&
            caller.workspaceIds.has(workspace) &&
            (input.workspaceId === undefined || workspace === input.workspaceId) &&
            (input.projectId === undefined || ticket.projectId === input.projectId) &&
            matches(ticket)
          );
        })
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const limit = input.limit ?? KANBAN_LIST_DEFAULT;
      const tickets = matched.slice(0, limit);
      const teams = new Set(
        tickets.flatMap((ticket) => (ticket.linear ? [ticket.linear.teamId] : [])),
      );
      return {
        workspaces: caller.workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
        })),
        tickets: tickets.map(ticketViewer(snapshot)),
        states: snapshot.states
          .filter((state) => teams.has(state.teamId))
          .map((state) => ({
            id: state.id,
            teamId: state.teamId,
            name: state.name,
            type: state.type,
          })),
        ...(matched.length > limit
          ? {
              truncated: `Showing ${limit} of ${matched.length} matching tickets. ${
                limit < KANBAN_LIST_MAX
                  ? `Narrow the filters or raise limit (at most ${KANBAN_LIST_MAX}).`
                  : "Narrow the filters."
              }`,
            }
          : {}),
      };
    }),
  ),
  kanban_get: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const ticket = yield* responsibleTicket(caller, input.ticketId);
      const detail = yield* caller.kanban
        .ticketDetail({ ticketId: ticket.id })
        .pipe(Effect.mapError(kanbanFailure));
      const stateName = stateNamer(caller.snapshot);
      const trimmed: string[] = [];
      return {
        ticket: ticketViewer(caller.snapshot)(ticket),
        description:
          detail.description === null ? null : trimBody(detail.description, "description", trimmed),
        parent:
          detail.parent === null
            ? null
            : {
                identifier: detail.parent.identifier,
                title: detail.parent.title,
                ticketId: detail.parent.ticketId,
              },
        children: detail.children.map((child) => ({
          identifier: child.identifier,
          title: child.title,
          state: stateName(child.status),
          ticketId: child.ticketId,
        })),
        comments: newest(detail.comments, "comments", trimmed).map((comment) => ({
          id: comment.id,
          author: comment.authorName,
          body: trimBody(comment.body, `comment ${comment.id}`, trimmed),
          replyTo: comment.parentId,
          createdAt: comment.createdAt,
        })),
        activity: newest(detail.activity, "activity", trimmed).map((entry) => ({
          actor: entry.actorName,
          text: entry.text,
          createdAt: entry.createdAt,
        })),
        ...ticketChoices(caller, ticket, trimmed),
        trimmed,
      };
    }),
  ),
  kanban_move: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const ticket = yield* responsibleTicket(caller, input.ticketId);
      const to =
        ticket.linear !== null
          ? input.stateId === undefined
            ? null
            : { kind: "linear" as const, stateId: input.stateId }
          : input.localState === undefined
            ? null
            : { kind: "local" as const, state: input.localState };
      if (to === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            ticket.linear !== null
              ? `${ticket.identifier} is a Linear issue: pass stateId.`
              : `${ticket.identifier} is a local ticket: pass localState.`,
        });
      }
      return yield* withView(caller)(
        caller.kanban.moveTicket({ ticketId: ticket.id, to }, caller.actor),
      );
    }),
  ),
  kanban_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const ticket = yield* responsibleTicket(caller, input.ticketId);
      const patch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.assigneeId === undefined
          ? {}
          : { assigneeId: input.assigneeId === "none" ? null : input.assigneeId }),
        ...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.botId === undefined ? {} : { botId: input.botId }),
      };
      if (Object.keys(patch).length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass at least one field to change.",
        });
      }
      return yield* withView(caller)(
        caller.kanban.updateTicket({ ticketId: ticket.id, patch }, caller.actor),
      );
    }),
  ),
  kanban_comment: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const ticket = yield* responsibleTicket(caller, input.ticketId);
      const comment = yield* caller.kanban
        .comment({ ticketId: ticket.id, body: input.body }, caller.actor)
        .pipe(Effect.mapError(kanbanFailure));
      return { id: comment.id, ticketId: ticket.id, author: comment.authorName };
    }),
  ),
  kanban_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const workspace = workspaceOfProject(caller.snapshot, input.projectId);
      if (workspace === null || !caller.workspaceIds.has(workspace)) {
        return yield* denied("That project's board is in a workspace you are not responsible for.");
      }
      return yield* withView(caller)(
        caller.kanban.createTicket(
          {
            projectId: input.projectId,
            title: input.title,
            ...(input.description === undefined ? {} : { description: input.description }),
          },
          caller.actor,
        ),
      );
    }),
  ),
  kanban_link_thread: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const ticket = yield* responsibleTicket(caller, input.ticketId);
      const threadId = input.threadId ?? caller.callerThreadId;
      if (threadId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass threadId.",
        });
      }
      return yield* withView(caller)(caller.kanban.linkThread({ ticketId: ticket.id, threadId }));
    }),
  ),
  kanban_unlink_thread: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const ticket = yield* responsibleTicket(caller, input.ticketId);
      return yield* withView(caller)(
        caller.kanban.unlinkThread({ ticketId: ticket.id, threadId: input.threadId }),
      );
    }),
  ),
});
