/**
 * Which agents here may reach a linked environment. The owner's Mac is linked with full access,
 * which the Mac does not fence, so this is the only barrier: PeerForwarding and PeerLinkRequests
 * cannot be built without it, and every doubt refuses.
 */
import {
  type BotId,
  type BotsError,
  OrchestratorMcpFailure,
  parseBotThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as PeerForwarding from "../peer/PeerForwarding.ts";
import type * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GuestStore from "./guest/GuestStore.ts";
import { withholdsGuestMcp } from "./guest/sandboxInstance.ts";

/** Comma-separated bot ids whose conversations may use linked environments. Unset: none. */
export const LINKED_ENVIRONMENT_BOTS_ENV = "T3CODE_LINKED_ENVIRONMENT_BOTS";

type Scope = McpInvocationContext.McpInvocationScope;

/** Pure. The listed bot ids; an unset or blank value lists none. */
export function parseLinkedEnvironmentBots(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
  );
}

/** What deciding a thread's origin reads. A read that fails refuses. */
export interface ThreadOrigins {
  /** The thread's parent and root, or null when there is no such thread. */
  readonly lineage: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly parent: ThreadId | null; readonly root: ThreadId } | null,
    ProjectionStore.ProjectionStoreV2Error
  >;
  /** The threads that sent it user messages, and whether a scheduled task an agent made did. */
  readonly senders: (threadId: ThreadId) => Effect.Effect<
    {
      readonly threads: ReadonlyArray<ThreadId>;
      readonly agentSchedule: boolean;
    },
    SqlError.SqlError
  >;
  readonly isGuestBot: (botId: BotId) => Effect.Effect<boolean, BotsError>;
}

// Bounds the walk; an origin tree larger than this refuses rather than loads without end.
const MAX_ORIGIN_THREADS = 64;

/**
 * Whether the thread and everything it answers to may use links. A bot conversation may when its
 * bot is listed and belongs to no guest. Any other thread may when its parent, its root and every
 * thread that messaged it may; a scheduled task made by an agent has no origin to check, so it
 * refuses.
 */
export const originAllows = Effect.fn("BotLinkAccess.originAllows")(function* (
  origins: ThreadOrigins,
  allowed: ReadonlySet<string>,
  threadId: ThreadId,
) {
  const seen = new Set<ThreadId>();
  const pending: Array<ThreadId> = [threadId];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (seen.size > MAX_ORIGIN_THREADS) return false;
    const bot = parseBotThreadId(next);
    if (bot !== null) {
      if (!allowed.has(bot.botId) || (yield* origins.isGuestBot(bot.botId))) return false;
      continue;
    }
    const lineage = yield* origins.lineage(next);
    if (lineage === null) return false;
    const senders = yield* origins.senders(next);
    if (senders.agentSchedule) return false;
    pending.push(lineage.root, ...senders.threads);
    if (lineage.parent !== null) pending.push(lineage.parent);
  }
  return true;
});

export class BotLinkAccess extends Context.Service<
  BotLinkAccess,
  {
    /** Whether this caller may reach a linked environment. Never fails: any doubt is false. */
    readonly allows: (scope: Scope) => Effect.Effect<boolean>;
  }
>()("t3/bots/linkAccess/BotLinkAccess") {}

/** What a caller BotLinkAccess refuses hears from every path to a linked environment. */
export const linkRefused = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "This agent may not use linked environments, so no tool can act on another machine from here. Leave out environmentId to work on this machine.",
});

const refuseUnless = (access: BotLinkAccess["Service"], scope: Scope) =>
  access
    .allows(scope)
    .pipe(Effect.flatMap((allowed) => (allowed ? Effect.void : Effect.fail(linkRefused))));

/**
 * PeerForwarding as only allowed callers reach it. Starting work (`call`, `links`) also needs the
 * caller's request to have links on; reads, waits and stops keep upstream's rule that a task
 * already running there may finish while the beta is off.
 */
export const gateForwarding = Effect.fn("BotLinkAccess.gateForwarding")(function* (
  inner: PeerForwarding.PeerForwarding["Service"],
) {
  const access = yield* BotLinkAccess;
  const refuse = (scope: Scope) => refuseUnless(access, scope);
  const refuseStart = (scope: Scope) =>
    scope.linkedEnvironments === false ? Effect.fail(linkRefused) : refuse(scope);
  const gated: PeerForwarding.PeerForwarding["Service"] = {
    call: (scope, tool, environmentId, params) =>
      Effect.andThen(refuseStart(scope), inner.call(scope, tool, environmentId, params)),
    readThread: (scope, environmentId, input) =>
      Effect.andThen(refuse(scope), inner.readThread(scope, environmentId, input)),
    interruptThread: (scope, environmentId, input) =>
      Effect.andThen(refuse(scope), inner.interruptThread(scope, environmentId, input)),
    waitForThread: (scope, environmentId, input) =>
      Effect.andThen(refuse(scope), inner.waitForThread(scope, environmentId, input)),
    links: (scope) => Effect.andThen(refuseStart(scope), inner.links(scope)),
  };
  return gated;
});

/** PeerLinkRequests whose link cards only allowed callers can ask for. Answers are the user's. */
export const gateLinkRequests = Effect.fn("BotLinkAccess.gateLinkRequests")(function* (
  inner: PeerLinkRequests.PeerLinkRequests["Service"],
) {
  const access = yield* BotLinkAccess;
  const gated: PeerLinkRequests.PeerLinkRequests["Service"] = {
    request: (scope, input) =>
      Effect.andThen(refuseUnless(access, scope), inner.request(scope, input)),
    answer: inner.answer,
  };
  return gated;
});

const make = Effect.gen(function* () {
  const allowed = parseLinkedEnvironmentBots(
    yield* Config.String(LINKED_ENVIRONMENT_BOTS_ENV).pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    ),
  );
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const guests = yield* GuestStore.GuestStore;
  const settings = yield* ServerSettings.ServerSettingsService;

  const origins: ThreadOrigins = {
    lineage: (threadId) =>
      projections
        .getThreadShell(threadId)
        .pipe(
          Effect.map((shell) =>
            shell === null
              ? null
              : { parent: shell.lineage.parentThreadId, root: shell.lineage.rootThreadId },
          ),
        ),
    senders: (threadId) =>
      sql<{ readonly sender: string | null; readonly agentSchedule: number }>`
        SELECT DISTINCT
          json_extract(payload_json, '$.senderThreadId') AS "sender",
          (json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL
            AND json_extract(payload_json, '$.createdBy') = 'agent') AS "agentSchedule"
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND role = 'user'
      `.pipe(
        Effect.map((rows) => ({
          threads: rows.flatMap((row) => (row.sender === null ? [] : [ThreadId.make(row.sender)])),
          agentSchedule: rows.some((row) => row.agentSchedule === 1),
        })),
      ),
    isGuestBot: (botId) => guests.guestOfBot(botId).pipe(Effect.map(Option.isSome)),
  };

  const allows = Effect.fn("BotLinkAccess.allows")(
    function* (scope: Scope) {
      if (scope.client?.linked === true) return false;
      if (scope.thread === undefined) return scope.client !== undefined;
      if (yield* withholdsGuestMcp(Option.some(settings), scope.thread.providerInstanceId)) {
        return false;
      }
      return yield* originAllows(origins, allowed, scope.thread.threadId);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Refused linked environments: the caller's origin could not be read", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );

  yield* Effect.logInfo(`Linked environments: ${allowed.size} bot(s) allowed`);
  return BotLinkAccess.of({ allows });
});

/** Reads LINKED_ENVIRONMENT_BOTS_ENV once; a changed list takes a restart. */
export const layer = Layer.effect(BotLinkAccess, make).pipe(Layer.provide(ProjectionStore.layer));

/** For tests of upstream link code that is not about who may use links. */
export const layerAllowingEveryone = Layer.succeed(
  BotLinkAccess,
  BotLinkAccess.of({
    allows: Effect.fn("BotLinkAccess.allowsEveryone")(() => Effect.succeed(true)),
  }),
);
