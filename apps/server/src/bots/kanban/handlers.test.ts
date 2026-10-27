import { describe, expect, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  botThreadId,
  EnvironmentId,
  KanbanTicketId,
  LinearAccountId,
  linearWorkspaceId,
  LOCAL_KANBAN_WORKSPACE_ID,
  parseBotThreadId,
  ProjectId,
  ProviderInstanceId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketMoveInput,
  type KanbanTicketThreadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as BotsService from "../BotsService.ts";
import * as KanbanHandlers from "./handlers.ts";
import { KanbanService } from "./KanbanService.ts";
import { KanbanToolkit } from "./tools.ts";

const NOW = "2026-10-01T00:00:00.000Z";
const ops = BotId.make("b_ops");
const idle = BotId.make("b_idle");
const ACCOUNT = LinearAccountId.make("la_1");
const PROJECT = ProjectId.make("project-1");

const bot = (id: BotId): Bot => ({
  id,
  name: id,
  role: "",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const ticket = (id: string, linear: boolean): KanbanTicket => ({
  id: KanbanTicketId.make(id),
  projectId: PROJECT,
  linear: linear
    ? { accountId: ACCOUNT, issueId: `issue-${id}`, teamId: "team", url: "https://linear.app/x" }
    : null,
  identifier: linear ? "BACK-1" : "T-1",
  title: id,
  status: linear ? { kind: "linear", stateId: "s-todo" } : { kind: "local", state: "todo" },
  assigneeId: null,
  assigneeName: null,
  creatorId: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  labelIds: [],
  linearProjectId: null,
  milestoneId: null,
  cycleId: null,
  parent: null,
  subIssues: null,
  pullRequests: [],
  botId: null,
  sortOrder: 0,
  closedAt: null,
  autoClosed: false,
  threadIds: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const linearTicket = ticket("t_linear", true);
const localTicket = ticket("t_local", false);

/** Ops is responsible for the Moneria workspace only; Idle for nothing. */
const snapshot: KanbanSnapshot = {
  accounts: [
    {
      id: ACCOUNT,
      name: "Moneria",
      keyLast4: "abcd",
      userName: "Israel",
      userId: null,
      userAvatarUrl: null,
      organizationId: "org",
      organizationName: "Moneria",
      organizationUrlKey: "moneria",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  workspaces: [
    { id: LOCAL_KANBAN_WORKSPACE_ID, name: "Local", botIds: [] },
    { id: linearWorkspaceId("org"), name: "Moneria", botIds: [ops] },
  ],
  links: [],
  states: [
    {
      id: "s-todo",
      teamId: "team",
      name: "A Fazer",
      type: "unstarted",
      position: 1,
      color: "#ccc",
    },
    {
      id: "s-done",
      teamId: "team",
      name: "Concluído",
      type: "completed",
      position: 2,
      color: "#0f0",
    },
  ],
  tickets: [linearTicket, localTicket],
  people: [],
  labels: [],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
};

function setup() {
  const moves: KanbanTicketMoveInput[] = [];
  const links: KanbanTicketThreadInput[] = [];
  const bots = Layer.mock(BotsService.BotsService)({
    botForThread: (threadId) => {
      const parsed = parseBotThreadId(threadId);
      return Effect.succeed(
        Option.fromNullishOr([bot(ops), bot(idle)].find((b) => b.id === parsed?.botId)),
      );
    },
  });
  const kanban = Layer.mock(KanbanService)({
    readSnapshot: Effect.succeed(snapshot),
    moveTicket: (input) =>
      Effect.sync(() => {
        moves.push(input);
        return { ...linearTicket, status: input.to };
      }),
    linkThread: (input) =>
      Effect.sync(() => {
        links.push(input);
        return { ...linearTicket, threadIds: [input.threadId] };
      }),
  });
  return { moves, links, layer: Layer.merge(bots, kanban) };
}

const scopeOf = (botId: BotId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("kanban-mcp-environment"),
  requestNamespace: "kanban-mcp-provider-session",
  thread: {
    threadId: botThreadId(botId, 1),
    providerSessionId: "kanban-mcp-provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
});

const kanbanTools = (
  services: Layer.Layer<BotsService.BotsService | KanbanService>,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      services,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      McpToolAccessTestkit.liveThreadsLayer,
    );
    const toolkit = yield* KanbanToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(KanbanHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const run = <A extends { readonly result: unknown }, E, R, E2, R2>(
      handled: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>,
    ) =>
      handled.pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(dependencies),
        Effect.map((results) => results.at(-1)?.result),
      );
    return {
      list: () => run(toolkit.handle("kanban_list", {})),
      move: (ticketId: KanbanTicketId, stateId: string) =>
        run(toolkit.handle("kanban_move", { ticketId, stateId })),
      moveLocal: (ticketId: KanbanTicketId) =>
        run(toolkit.handle("kanban_move", { ticketId, localState: "done" })),
      linkSelf: (ticketId: KanbanTicketId) =>
        run(toolkit.handle("kanban_link_thread", { ticketId })),
    };
  });

describe("kanban tools", () => {
  it.effect("list only the tickets of the caller's workspaces", () =>
    Effect.gen(function* () {
      const { layer } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      const result = yield* tools.list();
      expect(result).toMatchObject({
        workspaces: [{ id: linearWorkspaceId("org"), name: "Moneria" }],
        tickets: [{ id: linearTicket.id, state: { id: "s-todo", name: "A Fazer" } }],
      });
    }),
  );

  it.effect("move a ticket of the caller's workspace and refuse one outside it", () =>
    Effect.gen(function* () {
      const { layer, moves } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      expect(yield* tools.move(linearTicket.id, "s-done")).toMatchObject({
        id: linearTicket.id,
        state: { id: "s-done", name: "Concluído" },
      });
      expect(yield* tools.moveLocal(localTicket.id)).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        message: `No ticket ${localTicket.id} in the workspaces you are responsible for.`,
      });
      expect(moves).toEqual([
        { ticketId: linearTicket.id, to: { kind: "linear", stateId: "s-done" } },
      ]);
    }),
  );

  it.effect("refuse a bot that is responsible for no workspace", () =>
    Effect.gen(function* () {
      const { layer, moves } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(idle));
      expect(yield* tools.list()).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
      });
      expect(yield* tools.move(linearTicket.id, "s-done")).toMatchObject({
        code: "capability_denied",
      });
      expect(moves).toEqual([]);
    }),
  );

  it.effect("link the calling thread when no thread is named", () =>
    Effect.gen(function* () {
      const { layer, links } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      yield* tools.linkSelf(linearTicket.id);
      expect(links).toEqual([{ ticketId: linearTicket.id, threadId: botThreadId(ops, 1) }]);
    }),
  );
});
