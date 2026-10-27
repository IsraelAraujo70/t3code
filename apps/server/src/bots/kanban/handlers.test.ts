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
  type KanbanComment,
  type KanbanPersonId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketCommentInput,
  type KanbanTicketMoveInput,
  type KanbanTicketThreadInput,
  type KanbanTicketUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

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
const keeper = BotId.make("b_keeper");
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

const ticket = (id: string, linear: boolean, fields: Partial<KanbanTicket> = {}): KanbanTicket => ({
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
  ...fields,
});

const linearTicket = ticket("t_linear", true);
const localTicket = ticket("t_local", false);

/** Ops is responsible for the Moneria workspace only, Keeper for the local one, Idle for nothing. */
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
    { id: LOCAL_KANBAN_WORKSPACE_ID, name: "Local", botIds: [keeper] },
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
  labels: [
    {
      id: "l-bug",
      workspaceId: linearWorkspaceId("org"),
      teamId: "team",
      name: "Bug",
      color: "#f00",
      parentId: null,
      source: "linear",
    },
  ],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
};

function setup(tickets: ReadonlyArray<KanbanTicket> = [linearTicket, localTicket]) {
  const moves: KanbanTicketMoveInput[] = [];
  const links: KanbanTicketThreadInput[] = [];
  const updates: Array<{ input: KanbanTicketUpdateInput; actor: KanbanPersonId | undefined }> = [];
  const comments: Array<{ input: KanbanTicketCommentInput; actor: KanbanPersonId | undefined }> =
    [];
  const bots = Layer.mock(BotsService.BotsService)({
    botForThread: (threadId) => {
      const parsed = parseBotThreadId(threadId);
      return Effect.succeed(
        Option.fromNullishOr(
          [bot(ops), bot(idle), bot(keeper)].find((b) => b.id === parsed?.botId),
        ),
      );
    },
  });
  const kanban = Layer.mock(KanbanService)({
    readSnapshot: Effect.succeed({ ...snapshot, tickets }),
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
    updateTicket: (input, actor) =>
      Effect.sync(() => {
        updates.push({ input, actor });
        return { ...localTicket, ...input.patch };
      }),
    comment: (input, actor) =>
      Effect.sync(() => {
        comments.push({ input, actor });
        const comment: KanbanComment = {
          id: "c_1",
          authorId: actor ?? null,
          authorName: "keeper",
          authorAvatarUrl: null,
          body: input.body,
          parentId: null,
          createdAt: NOW,
          editedAt: null,
          deletable: true,
        };
        return comment;
      }),
    ticketDetail: (input) =>
      Effect.succeed({
        ticketId: input.ticketId,
        description: "d".repeat(5_000),
        parent: null,
        children: [],
        comments: Array.from({ length: 60 }, (_, index) => ({
          id: `c_${index}`,
          authorId: null,
          authorName: "Ana",
          authorAvatarUrl: null,
          body: `comment ${index}`,
          parentId: null,
          createdAt: NOW,
          editedAt: null,
          deletable: false,
        })),
        activity: [],
        fetchedAt: NOW,
      }),
  });
  return { moves, links, updates, comments, layer: Layer.merge(bots, kanban) };
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

type ToolParams<Name extends keyof typeof KanbanToolkit.tools> = Tool.Parameters<
  (typeof KanbanToolkit.tools)[Name]
>;

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
      list: (params: ToolParams<"kanban_list"> = {}) => run(toolkit.handle("kanban_list", params)),
      get: (ticketId: KanbanTicketId) => run(toolkit.handle("kanban_get", { ticketId })),
      update: (params: ToolParams<"kanban_update">) => run(toolkit.handle("kanban_update", params)),
      comment: (ticketId: KanbanTicketId, body: string) =>
        run(toolkit.handle("kanban_comment", { ticketId, body })),
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

  it.effect("filter by status type, label and text, and say when the limit truncates", () =>
    Effect.gen(function* () {
      const bug = ticket("t_bug", true, { title: "Fix the crash", labelIds: ["l-bug"] });
      const doneBug = ticket("t_done", true, {
        status: { kind: "linear", stateId: "s-done" },
        labelIds: ["l-bug"],
      });
      const { layer } = setup([linearTicket, bug, doneBug, localTicket]);
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      const ids = (result: unknown) =>
        (result as { tickets: ReadonlyArray<{ id: string }> }).tickets.map((t) => t.id);

      expect(ids(yield* tools.list({ statusTypes: ["unstarted"], labels: ["BUG"] }))).toEqual([
        bug.id,
      ]);
      expect(ids(yield* tools.list({ text: "CRASH" }))).toEqual([bug.id]);
      const limited = yield* tools.list({ limit: 2 });
      expect(ids(limited)).toHaveLength(2);
      expect(limited).toMatchObject({ truncated: expect.stringContaining("Showing 2 of 3") });
      expect(yield* tools.list()).not.toHaveProperty("truncated");
    }),
  );

  it.effect("refuse get, update and comment on a ticket outside the caller's workspaces", () =>
    Effect.gen(function* () {
      const { layer, updates, comments } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      const refusal = {
        _tag: "OrchestratorMcpFailure",
        message: `No ticket ${localTicket.id} in the workspaces you are responsible for.`,
      };
      expect(yield* tools.get(localTicket.id)).toMatchObject(refusal);
      expect(yield* tools.update({ ticketId: localTicket.id, priority: 1 })).toMatchObject(refusal);
      expect(yield* tools.comment(localTicket.id, "hi")).toMatchObject(refusal);
      expect(updates).toEqual([]);
      expect(comments).toEqual([]);
    }),
  );

  it.effect("update a local ticket with the bot as the actor", () =>
    Effect.gen(function* () {
      const { layer, updates } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(keeper));
      expect(
        yield* tools.update({ ticketId: localTicket.id, priority: 2, assigneeId: "none" }),
      ).toMatchObject({ id: localTicket.id, priority: { value: 2, name: "High" }, assignee: null });
      expect(updates).toEqual([
        {
          input: { ticketId: localTicket.id, patch: { priority: 2, assigneeId: null } },
          actor: "bot:b_keeper",
        },
      ]);
    }),
  );

  it.effect("comment through the service as the bot", () =>
    Effect.gen(function* () {
      const { layer, comments } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(keeper));
      expect(yield* tools.comment(localTicket.id, "Started on it.")).toEqual({
        id: "c_1",
        ticketId: localTicket.id,
        author: "keeper",
      });
      expect(comments).toEqual([
        { input: { ticketId: localTicket.id, body: "Started on it." }, actor: "bot:b_keeper" },
      ]);
    }),
  );

  it.effect("trim a long description and keep the newest 50 comments", () =>
    Effect.gen(function* () {
      const { layer } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      const result = (yield* tools.get(linearTicket.id)) as {
        description: string;
        comments: ReadonlyArray<{ id: string }>;
        labels: ReadonlyArray<{ id: string }>;
        trimmed: ReadonlyArray<string>;
      };
      expect(result.description).toHaveLength(4_001);
      expect(result.comments).toHaveLength(50);
      expect(result.comments.at(-1)?.id).toBe("c_59");
      expect(result.labels).toEqual([{ id: "l-bug", name: "Bug" }]);
      expect(result.trimmed).toEqual([
        "description: first 4000 of 5000 characters",
        "comments: newest 50 of 60",
      ]);
    }),
  );
});
