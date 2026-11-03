import {
  type AuthThreadGrant,
  isBotWildcardThreadGrant,
  ORCHESTRATION_V2_WS_METHODS,
  parseBotThreadOwner,
} from "@t3tools/contracts";

import { isNativeMaintenanceCommand } from "../../orchestration-v2/CommandPolicy.ts";

/**
 * A thread grant confines a session to one thread (or every thread of one bot). The session keeps
 * its scopes, but only the RPCs below are reachable, each only for a matching thread, with only
 * the listed payload fields. Everything else is denied, so a new field or method upstream stays
 * closed until it is reviewed here.
 */

/** Whether `threadId` is inside the grant: exact match, or any thread of the bot for `bot:<id>:*`. */
export function threadGrantAllows(grant: AuthThreadGrant, threadId: unknown): boolean {
  if (typeof threadId !== "string") return false;
  if (!isBotWildcardThreadGrant(grant)) return threadId === grant;
  const botId = grant.slice("bot:".length, -":*".length);
  return parseBotThreadOwner(threadId)?.botId === botId;
}

const SUBSCRIBE_THREAD_FIELDS = new Set([
  "threadId",
  "afterSequence",
  "requestCompletionMarker",
  "acceptBoundedSnapshot",
  "acceptDeferredWork",
  "acceptCompactTurnItems",
  "acceptDedupedBodies",
  "acceptCompactIds",
]);

const RPC_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: SUBSCRIBE_THREAD_FIELDS,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: new Set(["threadId"]),
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: new Set(["threadId", "itemId", "revision"]),
};

/**
 * Left out on purpose: context, model selection, guest/scheduled/sender/plan/continuation refs,
 * deferred starts, `titleSeed` (runs another model) and `holdQueue` (stops child threads). Each
 * reaches files, other threads or another provider. `createdBy` is overwritten by the server.
 */
const COMMAND_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  "message.dispatch": new Set([
    "type",
    "commandId",
    "threadId",
    "messageId",
    "text",
    "attachments",
    "dispatchMode",
    "createdBy",
    "creationSource",
  ]),
  "run.interrupt": new Set(["type", "commandId", "threadId", "runId", "reason"]),
};

const DISPATCH_MODES = new Set(["queue_after_active", "start_immediately"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unexpectedField = (
  payload: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): string | undefined =>
  Object.keys(payload).find((key) => payload[key] !== undefined && !allowed.has(key));

const commandDenial = (command: Readonly<Record<string, unknown>>): string | undefined => {
  const type = command.type;
  const allowed = typeof type === "string" ? COMMAND_FIELDS[type] : undefined;
  if (allowed === undefined) return `command ${String(type)} is not allowed`;
  const field = unexpectedField(command, allowed);
  if (field !== undefined) return `field ${field} is not allowed on ${type}`;
  if (type !== "message.dispatch") return undefined;
  if (!Array.isArray(command.attachments) || command.attachments.length > 0) {
    return "attachments are not allowed";
  }
  // `/logout` reaches the host's provider login, and a maintenance-only history triggers titling.
  if (
    typeof command.text !== "string" ||
    isNativeMaintenanceCommand({ text: command.text, attachments: [] })
  ) {
    return "maintenance commands are not allowed";
  }
  const mode = command.dispatchMode;
  if (
    !isRecord(mode) ||
    unexpectedField(mode, new Set(["type"])) !== undefined ||
    typeof mode.type !== "string" ||
    !DISPATCH_MODES.has(mode.type)
  ) {
    return "only queue_after_active and start_immediately dispatch modes are allowed";
  }
  return undefined;
};

/**
 * Why a thread-granted session may not make this call, or undefined when it may. `payload` is
 * the decoded RPC input.
 */
export function threadGrantRpcDenial(
  grant: AuthThreadGrant,
  method: string,
  payload: unknown,
): string | undefined {
  const isDispatch = method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
  const fields = Object.hasOwn(RPC_FIELDS, method) ? RPC_FIELDS[method] : undefined;
  if (!isDispatch && fields === undefined) return `${method} is not available to this session`;
  if (!isRecord(payload)) return "malformed request";
  if (!threadGrantAllows(grant, payload.threadId)) return "thread is outside this session's grant";
  if (isDispatch) return commandDenial(payload);
  const field = unexpectedField(payload, fields ?? new Set());
  return field === undefined ? undefined : `field ${field} is not allowed on ${method}`;
}

const TICKET_PATHS = new Set(["/api/auth/websocket-ticket", "/api/auth/websocket-ticket/rpc"]);

/** Over HTTP a thread-granted session may only mint the ticket for its RPC socket. */
export const threadGrantAllowsHttpRequest = (method: string, pathname: string): boolean =>
  method === "POST" && TICKET_PATHS.has(pathname);
