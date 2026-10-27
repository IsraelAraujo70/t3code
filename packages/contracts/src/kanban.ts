/**
 * Kanban of agent work (friend fork), optionally synced with Linear, kept on the bots host in
 * `bots.sqlite`. A Linear key never leaves the server; clients see only its last 4 characters.
 * `bots.ts` re-exports this module, so this file must not import from `bots.ts`.
 * Design: docs/friend/linear-kanban.md.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The same schema as `bots.ts`'s BotId (same brand), declared here to keep the import acyclic. */
const BotId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(Schema.brand("BotId"));

export const LinearAccountId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("LinearAccountId"),
);
export type LinearAccountId = typeof LinearAccountId.Type;

export const KanbanTicketId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("KanbanTicketId"),
);
export type KanbanTicketId = typeof KanbanTicketId.Type;

/** Linear's own ids (UUIDs); bounded only against abuse. */
export const LinearId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const KANBAN_LIMITS = {
  accountName: 60,
  apiKey: 256,
  title: 255,
  description: 20_000,
} as const;

export class KanbanError extends Schema.TaggedError<KanbanError>()("KanbanError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The columns of a board that is not synced with Linear, in board order. */
export const KANBAN_LOCAL_STATES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
export const KanbanLocalState = Schema.Literals(KANBAN_LOCAL_STATES);
export type KanbanLocalState = typeof KanbanLocalState.Type;

export const KANBAN_LOCAL_STATE_LABELS: Record<KanbanLocalState, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** Linear's workflow state categories. */
export const LinearStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
]);
export type LinearStateType = typeof LinearStateType.Type;

/** Board order of Linear's categories; Linear orders states by `position` within one. */
export const LINEAR_STATE_TYPE_ORDER: readonly LinearStateType[] = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
];

export const LinearWorkflowState = Schema.Struct({
  id: LinearId,
  teamId: LinearId,
  name: Schema.String,
  type: LinearStateType,
  position: Schema.Number,
  color: Schema.String,
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

export const LinearAccountName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KANBAN_LIMITS.accountName),
);

/** What clients see of an account: never the key itself. */
export const LinearAccount = Schema.Struct({
  id: LinearAccountId,
  name: LinearAccountName,
  keyLast4: Schema.String,
  /** The Linear user the key belongs to. */
  userName: Schema.String,
  organizationId: LinearId,
  organizationName: Schema.String,
  organizationUrlKey: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LinearAccount = typeof LinearAccount.Type;

/** `local`, or `linear:<organization id>`. */
export const KanbanWorkspaceId = Schema.String.check(
  Schema.isPattern(/^(local|linear:[A-Za-z0-9_-]{1,128})$/),
).pipe(Schema.brand("KanbanWorkspaceId"));
export type KanbanWorkspaceId = typeof KanbanWorkspaceId.Type;

export const LOCAL_KANBAN_WORKSPACE_ID = KanbanWorkspaceId.make("local");

export function linearWorkspaceId(organizationId: string): KanbanWorkspaceId {
  return KanbanWorkspaceId.make(`linear:${organizationId}`);
}

/** The local workspace, and every Linear organization some account reaches. */
export const KanbanWorkspace = Schema.Struct({
  id: KanbanWorkspaceId,
  name: Schema.String,
  /** Bots responsible for the workspace's tickets, in the order the user chose. */
  botIds: Schema.Array(BotId),
});
export type KanbanWorkspace = typeof KanbanWorkspace.Type;

export const KanbanProjectLink = Schema.Struct({
  projectId: ProjectId,
  accountId: LinearAccountId,
  teamId: LinearId,
  teamKey: Schema.String,
  teamName: Schema.String,
  /** Narrows the board to one Linear project of the team; null takes the whole team. */
  linearProjectId: Schema.NullOr(LinearId),
  linearProjectName: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  /** The last sync's failure, cleared by the next success. */
  syncError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type KanbanProjectLink = typeof KanbanProjectLink.Type;

export const KanbanTicketStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), state: KanbanLocalState }),
  Schema.Struct({ kind: Schema.Literal("linear"), stateId: LinearId }),
]);
export type KanbanTicketStatus = typeof KanbanTicketStatus.Type;

export const KanbanTicket = Schema.Struct({
  id: KanbanTicketId,
  projectId: ProjectId,
  /** Null for a local ticket. */
  linear: Schema.NullOr(
    Schema.Struct({
      accountId: LinearAccountId,
      issueId: LinearId,
      teamId: LinearId,
      url: Schema.String,
    }),
  ),
  /** `MON-123` for a Linear issue, `T-7` for a local ticket. */
  identifier: Schema.String,
  title: Schema.String,
  status: KanbanTicketStatus,
  assigneeName: Schema.NullOr(Schema.String),
  /** Linear's scale: 0 none, 1 urgent … 4 low. */
  priority: NonNegativeInt,
  /** Linked threads, oldest link first. */
  threadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  /** Linear's `updatedAt` for an issue; the last local write for a local ticket. */
  updatedAt: IsoDateTime,
});
export type KanbanTicket = typeof KanbanTicket.Type;

/** Everything the board renders, republished after every change. */
export const KanbanSnapshot = Schema.Struct({
  accounts: Schema.Array(LinearAccount),
  workspaces: Schema.Array(KanbanWorkspace),
  links: Schema.Array(KanbanProjectLink),
  /** Workflow states of every linked team. */
  states: Schema.Array(LinearWorkflowState),
  tickets: Schema.Array(KanbanTicket),
});
export type KanbanSnapshot = typeof KanbanSnapshot.Type;

export const LinearTeamSummary = Schema.Struct({
  id: LinearId,
  key: Schema.String,
  name: Schema.String,
  projects: Schema.Array(Schema.Struct({ id: LinearId, name: Schema.String })),
});
export type LinearTeamSummary = typeof LinearTeamSummary.Type;

export const LinearAccountAddInput = Schema.Struct({
  name: LinearAccountName,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_LIMITS.apiKey)),
});
export type LinearAccountAddInput = typeof LinearAccountAddInput.Type;

export const LinearAccountRenameInput = Schema.Struct({
  accountId: LinearAccountId,
  name: LinearAccountName,
});
export type LinearAccountRenameInput = typeof LinearAccountRenameInput.Type;

export const LinearAccountRef = Schema.Struct({ accountId: LinearAccountId });
export type LinearAccountRef = typeof LinearAccountRef.Type;

export const LinearTeamsResult = Schema.Struct({ teams: Schema.Array(LinearTeamSummary) });
export type LinearTeamsResult = typeof LinearTeamsResult.Type;

export const KanbanProjectLinkInput = Schema.Struct({
  projectId: ProjectId,
  accountId: LinearAccountId,
  teamId: LinearId,
  linearProjectId: Schema.NullOr(LinearId),
});
export type KanbanProjectLinkInput = typeof KanbanProjectLinkInput.Type;

export const KanbanProjectRef = Schema.Struct({ projectId: ProjectId });
export type KanbanProjectRef = typeof KanbanProjectRef.Type;

export const KanbanWorkspaceBotsInput = Schema.Struct({
  workspaceId: KanbanWorkspaceId,
  botIds: Schema.Array(BotId).check(Schema.isMaxLength(32)),
});
export type KanbanWorkspaceBotsInput = typeof KanbanWorkspaceBotsInput.Type;

export const KanbanTicketTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KANBAN_LIMITS.title),
);

/** In a linked project the ticket is created in Linear, in the team's default state. */
export const KanbanTicketCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: KanbanTicketTitle,
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(KANBAN_LIMITS.description)),
  ),
  /** A local ticket's column; Linear picks the column of a new issue. */
  state: Schema.optionalKey(KanbanLocalState),
});
export type KanbanTicketCreateInput = typeof KanbanTicketCreateInput.Type;

export const KanbanTicketRef = Schema.Struct({ ticketId: KanbanTicketId });
export type KanbanTicketRef = typeof KanbanTicketRef.Type;

/** A local ticket takes a local state; a Linear ticket a workflow state of its own team. */
export const KanbanTicketMoveInput = Schema.Struct({
  ticketId: KanbanTicketId,
  to: KanbanTicketStatus,
});
export type KanbanTicketMoveInput = typeof KanbanTicketMoveInput.Type;

export const KanbanTicketThreadInput = Schema.Struct({
  ticketId: KanbanTicketId,
  threadId: ThreadId,
});
export type KanbanTicketThreadInput = typeof KanbanTicketThreadInput.Type;

export const KanbanSyncInput = Schema.Struct({
  /** One linked project; every linked project when absent. */
  projectId: Schema.optionalKey(ProjectId),
});
export type KanbanSyncInput = typeof KanbanSyncInput.Type;

export const KANBAN_WS_METHODS = {
  kanbanSubscribe: "bots.kanban.subscribe",
  kanbanAccountAdd: "bots.kanban.account.add",
  kanbanAccountRename: "bots.kanban.account.rename",
  kanbanAccountDelete: "bots.kanban.account.delete",
  kanbanLinearTeams: "bots.kanban.linear.teams",
  kanbanProjectLink: "bots.kanban.project.link",
  kanbanProjectUnlink: "bots.kanban.project.unlink",
  kanbanWorkspaceBots: "bots.kanban.workspace.bots",
  kanbanTicketCreate: "bots.kanban.ticket.create",
  kanbanTicketMove: "bots.kanban.ticket.move",
  kanbanTicketDelete: "bots.kanban.ticket.delete",
  kanbanTicketLinkThread: "bots.kanban.ticket.linkThread",
  kanbanTicketUnlinkThread: "bots.kanban.ticket.unlinkThread",
  kanbanSync: "bots.kanban.sync",
} as const;

const KanbanRpcError = Schema.Union([KanbanError, EnvironmentAuthorizationError]);

export const KanbanSubscribeRpc = Rpc.make(KANBAN_WS_METHODS.kanbanSubscribe, {
  payload: Schema.Struct({}),
  success: KanbanSnapshot,
  error: KanbanRpcError,
  stream: true,
});
/** Checks the key against Linear before saving it. */
export const KanbanAccountAddRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAccountAdd, {
  payload: LinearAccountAddInput,
  success: LinearAccount,
  error: KanbanRpcError,
});
export const KanbanAccountRenameRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAccountRename, {
  payload: LinearAccountRenameInput,
  success: LinearAccount,
  error: KanbanRpcError,
});
/** Unlinks its projects and drops their synced tickets with them; local tickets stay. */
export const KanbanAccountDeleteRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAccountDelete, {
  payload: LinearAccountRef,
  success: LinearAccountRef,
  error: KanbanRpcError,
});
export const KanbanLinearTeamsRpc = Rpc.make(KANBAN_WS_METHODS.kanbanLinearTeams, {
  payload: LinearAccountRef,
  success: LinearTeamsResult,
  error: KanbanRpcError,
});
/** Replaces the project's link; tickets synced under another team or account are dropped. */
export const KanbanProjectLinkRpc = Rpc.make(KANBAN_WS_METHODS.kanbanProjectLink, {
  payload: KanbanProjectLinkInput,
  success: KanbanProjectLink,
  error: KanbanRpcError,
});
/** The project's synced tickets go with the link; its local tickets stay. */
export const KanbanProjectUnlinkRpc = Rpc.make(KANBAN_WS_METHODS.kanbanProjectUnlink, {
  payload: KanbanProjectRef,
  success: KanbanProjectRef,
  error: KanbanRpcError,
});
export const KanbanWorkspaceBotsRpc = Rpc.make(KANBAN_WS_METHODS.kanbanWorkspaceBots, {
  payload: KanbanWorkspaceBotsInput,
  success: KanbanWorkspaceBotsInput,
  error: KanbanRpcError,
});
export const KanbanTicketCreateRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketCreate, {
  payload: KanbanTicketCreateInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
/** Moving a Linear ticket updates the issue in Linear first; a refusal there changes nothing. */
export const KanbanTicketMoveRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketMove, {
  payload: KanbanTicketMoveInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
/** Local tickets only: a Linear issue is closed or archived in Linear. */
export const KanbanTicketDeleteRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketDelete, {
  payload: KanbanTicketRef,
  success: KanbanTicketRef,
  error: KanbanRpcError,
});
export const KanbanTicketLinkThreadRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketLinkThread, {
  payload: KanbanTicketThreadInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
export const KanbanTicketUnlinkThreadRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketUnlinkThread, {
  payload: KanbanTicketThreadInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
/** Pulls Linear changes now instead of at the next poll. */
export const KanbanSyncRpc = Rpc.make(KANBAN_WS_METHODS.kanbanSync, {
  payload: KanbanSyncInput,
  success: KanbanSyncInput,
  error: KanbanRpcError,
});

export const KANBAN_RPCS = [
  KanbanSubscribeRpc,
  KanbanAccountAddRpc,
  KanbanAccountRenameRpc,
  KanbanAccountDeleteRpc,
  KanbanLinearTeamsRpc,
  KanbanProjectLinkRpc,
  KanbanProjectUnlinkRpc,
  KanbanWorkspaceBotsRpc,
  KanbanTicketCreateRpc,
  KanbanTicketMoveRpc,
  KanbanTicketDeleteRpc,
  KanbanTicketLinkThreadRpc,
  KanbanTicketUnlinkThreadRpc,
  KanbanSyncRpc,
] as const;

/**
 * The column a ticket sits in on a board that mixes teams (or Linear and local tickets): Linear
 * states fold into the local states by category. Linear has no review category, so a started
 * state named like a review ("In Review", "Em Revisão", "En revisión") counts as "In review". Canceled and duplicate tickets have no
 * column there.
 */
export function kanbanLocalStateOf(
  status: KanbanTicketStatus,
  statesById: ReadonlyMap<string, LinearWorkflowState>,
): KanbanLocalState | null {
  if (status.kind === "local") return status.state;
  const state = statesById.get(status.stateId);
  if (state === undefined) return null;
  switch (state.type) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
      return "todo";
    case "started":
      return /revi(ew|s)/i.test(state.name) ? "in_review" : "in_progress";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return null;
  }
}
