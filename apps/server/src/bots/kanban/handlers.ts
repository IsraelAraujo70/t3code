/**
 * The kanban tools. The calling bot comes from the trusted caller scope, and it reaches only the
 * workspaces the user made it responsible for; no tool argument can widen that.
 */
import {
  KANBAN_LOCAL_STATE_LABELS,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  OrchestratorMcpFailure,
  type KanbanError,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketId,
  type KanbanWorkspaceId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as BotsService from "../BotsService.ts";
import { KanbanService, workspaceOfTicket } from "./KanbanService.ts";
import { KanbanToolkit } from "./tools.ts";

const kanbanFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** The calling bot and the workspaces it is responsible for, with a fresh snapshot. */
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
  const workspaces = snapshot.workspaces.filter((workspace) =>
    workspace.botIds.includes(bot.value.id),
  );
  if (workspaces.length === 0) {
    return yield* denied(
      "You are not responsible for any Kanban workspace. The user assigns bots on the Kanban page.",
    );
  }
  return {
    kanban,
    snapshot,
    callerThreadId: scope.thread?.threadId,
    workspaceIds: new Set<KanbanWorkspaceId>(workspaces.map((workspace) => workspace.id)),
    workspaces,
  };
});

type CallerScope = Effect.Success<typeof callerScope>;

const accountsById = (snapshot: KanbanSnapshot) =>
  new Map(snapshot.accounts.map((account) => [account.id, account]));

const ticketView = (snapshot: KanbanSnapshot, ticket: KanbanTicket) => {
  const status = ticket.status;
  const state =
    status.kind === "local"
      ? { id: status.state, name: KANBAN_LOCAL_STATE_LABELS[status.state], kind: "local" as const }
      : {
          id: status.stateId,
          name: snapshot.states.find((s) => s.id === status.stateId)?.name ?? "Unknown",
          kind: "linear" as const,
        };
  return {
    id: ticket.id,
    identifier: ticket.identifier,
    title: ticket.title,
    projectId: ticket.projectId,
    workspaceId: workspaceOfTicket(ticket, accountsById(snapshot)) ?? LOCAL_KANBAN_WORKSPACE_ID,
    state,
    url: ticket.linear?.url ?? null,
    assigneeName: ticket.assigneeName,
    threadIds: ticket.threadIds,
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

const withView = (caller: CallerScope) => (effect: Effect.Effect<KanbanTicket, KanbanError>) =>
  effect.pipe(
    Effect.mapError(kanbanFailure),
    Effect.flatMap((ticket) =>
      caller.kanban.readSnapshot.pipe(
        Effect.mapError(kanbanFailure),
        Effect.map((snapshot) => ticketView(snapshot, ticket)),
      ),
    ),
  );

export const layer = McpToolAccess.toLayer(KanbanToolkit, {
  kanban_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerScope;
      const { snapshot } = caller;
      const accounts = accountsById(snapshot);
      const tickets = snapshot.tickets.filter((ticket) => {
        const workspace = workspaceOfTicket(ticket, accounts);
        return (
          workspace !== null &&
          caller.workspaceIds.has(workspace) &&
          (input.workspaceId === undefined || workspace === input.workspaceId) &&
          (input.projectId === undefined || ticket.projectId === input.projectId)
        );
      });
      const teams = new Set(
        tickets.flatMap((ticket) => (ticket.linear ? [ticket.linear.teamId] : [])),
      );
      return {
        workspaces: caller.workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
        })),
        tickets: tickets.map((ticket) => ticketView(snapshot, ticket)),
        states: snapshot.states
          .filter((state) => teams.has(state.teamId))
          .map((state) => ({
            id: state.id,
            teamId: state.teamId,
            name: state.name,
            type: state.type,
          })),
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
      return yield* withView(caller)(caller.kanban.moveTicket({ ticketId: ticket.id, to }));
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
        caller.kanban.createTicket({
          projectId: input.projectId,
          title: input.title,
          ...(input.description === undefined ? {} : { description: input.description }),
        }),
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
