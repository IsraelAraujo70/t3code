import { describe, expect, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  botThreadId,
  EnvironmentId,
  KANBAN_DEFAULT_VIEW_CONFIG,
  KanbanTicketId,
  KanbanViewId,
  LinearAccountId,
  linearWorkspaceId,
  LOCAL_KANBAN_WORKSPACE_ID,
  parseBotThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanComment,
  type KanbanPersonId,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketCommentInput,
  type KanbanTicketMoveInput,
  type KanbanTicketThreadInput,
  type KanbanTicketCreateInput,
  type KanbanTicketUpdateInput,
  type KanbanView,
  type KanbanViewRef,
  type KanbanViewSaveInput,
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
/** Linked to Moneria's team, so its board is in the Moneria workspace. */
const MONERIA_PROJECT = ProjectId.make("project-moneria");

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

const view = (
  id: string,
  projectId: ProjectId | null,
  fields: Partial<KanbanView> = {},
): KanbanView => ({
  id: KanbanViewId.make(id),
  projectId,
  name: id,
  icon: null,
  config: KANBAN_DEFAULT_VIEW_CONFIG,
  linearViewId: null,
  createdBy: "owner",
  updatedBy: "owner",
  createdAt: NOW,
  updatedAt: NOW,
  ...fields,
});

/** A seeded every-board view, the owner's local view, and a Moneria view a bot made. */
const everyBoardView = view("v_active", null);
const localView = view("v_local", PROJECT);
const moneriaView = view("v_moneria", MONERIA_PROJECT, {
  createdBy: "bot:b_keeper",
  updatedBy: "bot:b_keeper",
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
  links: [
    {
      projectId: MONERIA_PROJECT,
      accountId: ACCOUNT,
      teamId: "team",
      teamKey: "BACK",
      teamName: "Back-end",
      linearProjectId: null,
      linearProjectName: null,
      lastSyncedAt: null,
      syncError: null,
      createdAt: NOW,
    },
  ],
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
  views: [everyBoardView, localView, moneriaView],
  allWorkspacesBotIds: [],
};

function setup(
  tickets: ReadonlyArray<KanbanTicket> = [linearTicket, localTicket],
  allWorkspacesBotIds: ReadonlyArray<BotId> = [],
) {
  const moves: KanbanTicketMoveInput[] = [];
  const links: KanbanTicketThreadInput[] = [];
  const updates: Array<{ input: KanbanTicketUpdateInput; actor: KanbanPersonId | undefined }> = [];
  const comments: Array<{ input: KanbanTicketCommentInput; actor: KanbanPersonId | undefined }> =
    [];
  const creates: Array<{ input: KanbanTicketCreateInput; actor: KanbanPersonId | undefined }> = [];
  const unlinks: KanbanTicketThreadInput[] = [];
  const savedViews: Array<{ input: KanbanViewSaveInput; actor: KanbanPersonId | undefined }> = [];
  const deletedViews: KanbanViewRef[] = [];
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
    readSnapshot: Effect.succeed({ ...snapshot, tickets, allWorkspacesBotIds }),
    createTicket: (input, actor) =>
      Effect.sync(() => {
        creates.push({ input, actor });
        return { ...localTicket, projectId: input.projectId, title: input.title };
      }),
    unlinkThread: (input) =>
      Effect.sync(() => {
        unlinks.push(input);
        return localTicket;
      }),
    saveView: (input, actor) =>
      Effect.sync(() => {
        savedViews.push({ input, actor });
        const existing = snapshot.views.find((candidate) => candidate.id === input.id);
        return view(input.id ?? "v_new", input.projectId, {
          name: input.name,
          icon: input.icon,
          config: input.config,
          createdBy: existing?.createdBy ?? actor ?? "owner",
          updatedBy: actor ?? "owner",
        });
      }),
    deleteView: (input) =>
      Effect.sync(() => {
        deletedViews.push(input);
        return input;
      }),
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
  return {
    moves,
    links,
    updates,
    comments,
    creates,
    unlinks,
    savedViews,
    deletedViews,
    layer: Layer.merge(bots, kanban),
  };
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
      unlink: (ticketId: KanbanTicketId, threadId: ThreadId) =>
        run(toolkit.handle("kanban_unlink_thread", { ticketId, threadId })),
      create: (projectId: ProjectId, title: string) =>
        run(toolkit.handle("kanban_create", { projectId, title })),
      views: () => run(toolkit.handle("kanban_view_list", {})),
      saveView: (params: ToolParams<"kanban_view_save">) =>
        run(toolkit.handle("kanban_view_save", params)),
      /** Arguments the model sent, before the tool's schema checks them. */
      saveViewRaw: (params: unknown) =>
        run(toolkit.handle("kanban_view_save", params as ToolParams<"kanban_view_save">)),
      deleteView: (viewId: KanbanViewId) => run(toolkit.handle("kanban_view_delete", { viewId })),
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

  it("never cuts an emoji in half when trimming", () => {
    const trimmed: string[] = [];
    const body = KanbanHandlers.trimBody(`${"x".repeat(3_999)}😀 and more`, "description", trimmed);
    expect(body).toBe(`${"x".repeat(3_999)}…`);
    expect(body.isWellFormed()).toBe(true);
  });

  it.effect("a bot responsible for every workspace reads and writes where it is not listed", () =>
    Effect.gen(function* () {
      const { layer, moves, updates, comments, creates, links, unlinks } = setup(undefined, [idle]);
      const tools = yield* kanbanTools(layer, scopeOf(idle));
      expect(yield* tools.list()).toMatchObject({
        workspaces: [{ id: LOCAL_KANBAN_WORKSPACE_ID }, { id: linearWorkspaceId("org") }],
        tickets: [{ id: linearTicket.id }, { id: localTicket.id }],
      });
      expect(yield* tools.get(localTicket.id)).toMatchObject({ ticket: { id: localTicket.id } });
      yield* tools.move(linearTicket.id, "s-done");
      yield* tools.update({ ticketId: localTicket.id, priority: 1 });
      yield* tools.comment(linearTicket.id, "On it.");
      yield* tools.create(PROJECT, "Local work");
      yield* tools.create(MONERIA_PROJECT, "Linear work");
      yield* tools.linkSelf(localTicket.id);
      yield* tools.unlink(localTicket.id, botThreadId(idle, 1));
      expect(moves).toHaveLength(1);
      expect(updates.map((update) => update.actor)).toEqual(["bot:b_idle"]);
      expect(comments).toHaveLength(1);
      expect(creates.map((create) => create.input.projectId)).toEqual([PROJECT, MONERIA_PROJECT]);
      expect(links).toHaveLength(1);
      expect(unlinks).toHaveLength(1);
    }),
  );

  it.effect("a bot without the setting keeps only the workspaces it is listed in", () =>
    Effect.gen(function* () {
      const { layer, creates, moves } = setup(undefined, [idle]);
      const tools = yield* kanbanTools(layer, scopeOf(ops));
      expect(yield* tools.list()).toMatchObject({
        workspaces: [{ id: linearWorkspaceId("org") }],
        tickets: [{ id: linearTicket.id }],
      });
      expect(yield* tools.moveLocal(localTicket.id)).toMatchObject({ code: "invalid_request" });
      expect(yield* tools.create(PROJECT, "Not mine")).toMatchObject({
        code: "capability_denied",
      });
      expect(moves).toEqual([]);
      expect(creates).toEqual([]);
    }),
  );

  it.effect("a bot edits and deletes views of its workspace, not another's", () =>
    Effect.gen(function* () {
      const { layer, savedViews, deletedViews } = setup();
      const ops_ = yield* kanbanTools(layer, scopeOf(ops));
      expect(yield* ops_.saveView({ id: moneriaView.id, name: "Renamed" })).toMatchObject({
        id: moneriaView.id,
        name: "Renamed",
        projectId: MONERIA_PROJECT,
        createdBy: "bot:b_keeper",
        updatedBy: "bot:b_ops",
      });
      expect(yield* ops_.saveView({ id: localView.id, name: "Nope" })).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("No view v_local"),
      });
      expect(yield* ops_.saveView({ id: moneriaView.id, projectId: PROJECT })).toMatchObject({
        code: "capability_denied",
      });
      expect(yield* ops_.deleteView(localView.id)).toMatchObject({ code: "invalid_request" });

      const keeper_ = yield* kanbanTools(layer, scopeOf(keeper));
      expect(yield* keeper_.deleteView(moneriaView.id)).toMatchObject({ code: "invalid_request" });
      expect(yield* keeper_.deleteView(localView.id)).toEqual({ viewId: localView.id });

      expect(savedViews).toEqual([
        {
          input: {
            id: moneriaView.id,
            projectId: MONERIA_PROJECT,
            name: "Renamed",
            icon: null,
            config: KANBAN_DEFAULT_VIEW_CONFIG,
          },
          actor: "bot:b_ops",
        },
      ]);
      expect(deletedViews).toEqual([{ viewId: localView.id }]);
    }),
  );

  it.effect("without the setting a bot cannot touch a view on every board", () =>
    Effect.gen(function* () {
      const { layer, savedViews, deletedViews } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(keeper));
      const refusal = {
        code: "capability_denied",
        message: expect.stringContaining("every board"),
      };
      expect(yield* tools.saveView({ id: everyBoardView.id, name: "Mine now" })).toMatchObject(
        refusal,
      );
      expect(yield* tools.deleteView(everyBoardView.id)).toMatchObject(refusal);
      expect(yield* tools.saveView({ name: "Everywhere", projectId: null })).toMatchObject(refusal);
      expect(yield* tools.saveView({ id: localView.id, projectId: null })).toMatchObject(refusal);
      expect(yield* tools.views()).toMatchObject({
        views: [
          { id: everyBoardView.id, editable: false, createdBy: "owner" },
          { id: localView.id, editable: true },
        ],
      });
      expect(savedViews).toEqual([]);
      expect(deletedViews).toEqual([]);
    }),
  );

  it.effect("with the setting a bot edits and deletes the owner's views", () =>
    Effect.gen(function* () {
      const { layer, savedViews, deletedViews } = setup(undefined, [idle]);
      const tools = yield* kanbanTools(layer, scopeOf(idle));
      expect(yield* tools.views()).toMatchObject({
        views: [
          { id: everyBoardView.id, editable: true },
          { id: localView.id, editable: true },
          { id: moneriaView.id, editable: true },
        ],
      });
      expect(
        yield* tools.saveView({ id: everyBoardView.id, config: { groupBy: "priority" } }),
      ).toMatchObject({ id: everyBoardView.id, createdBy: "owner", updatedBy: "bot:b_idle" });
      expect(yield* tools.deleteView(localView.id)).toEqual({ viewId: localView.id });
      expect(yield* tools.saveView({ name: "Everywhere", projectId: null })).toMatchObject({
        createdBy: "bot:b_idle",
      });
      expect(savedViews.map((saved) => saved.input.config.groupBy)).toEqual(["priority", "status"]);
      expect(deletedViews).toEqual([{ viewId: localView.id }]);
    }),
  );

  it.effect("create a view from the default config, and say what a new view lacks", () =>
    Effect.gen(function* () {
      const { layer, savedViews } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(keeper));
      expect(yield* tools.saveView({ name: "No board" })).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("projectId"),
      });
      yield* tools.saveView({
        name: "List",
        projectId: PROJECT,
        icon: "Zap",
        config: { layout: "list", filters: [] },
      });
      expect(savedViews).toEqual([
        {
          input: {
            projectId: PROJECT,
            name: "List",
            icon: "Zap",
            config: { ...KANBAN_DEFAULT_VIEW_CONFIG, layout: "list" },
          },
          actor: "bot:b_keeper",
        },
      ]);
    }),
  );

  it.effect("refuse an invalid config with the field that failed", () =>
    Effect.gen(function* () {
      const { layer, savedViews } = setup();
      const tools = yield* kanbanTools(layer, scopeOf(keeper));
      const result = yield* tools.saveViewRaw({
        name: "Bad",
        projectId: PROJECT,
        config: { groupBy: "colour" },
      });
      expect(result).toMatchObject({
        reason: {
          _tag: "ToolParameterValidationError",
          description: expect.stringMatching(/Expected "status".*\n.*\["config"\]\["groupBy"\]/s),
        },
      });
      expect(savedViews).toEqual([]);
    }),
  );
});
