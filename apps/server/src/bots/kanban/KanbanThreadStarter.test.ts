import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  Bot,
  BotId,
  botThreadId,
  KanbanError,
  KanbanTicket,
  KanbanTicketId,
  LinearAccountId,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
  type Project as ProjectRecord,
  type ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Project from "../../project/ProjectService.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BotsStore } from "../BotsStore.ts";
import { KanbanService } from "./KanbanService.ts";
import { buildTicketThreadMessage, KanbanThreadStarter, layerLive } from "./KanbanThreadStarter.ts";

describe("buildTicketThreadMessage", () => {
  const local = { identifier: "T-1", title: "Fix it", linear: null };
  const synced = {
    identifier: "BACK-1",
    title: "Fix it",
    linear: {
      accountId: LinearAccountId.make("account"),
      issueId: "issue",
      teamId: "team",
      url: "https://linear.app/issue/BACK-1",
    },
  };

  it("names a local ticket", () => {
    assert.strictEqual(
      buildTicketThreadMessage(local, null, undefined),
      "Kanban ticket T-1 (local ticket)\nT-1: Fix it",
    );
  });

  it("puts the description and the note after blank lines", () => {
    assert.strictEqual(
      buildTicketThreadMessage(local, "Steps", "Plan only"),
      "Kanban ticket T-1 (local ticket)\nT-1: Fix it\n\nSteps\n\nPlan only",
    );
  });

  it("links a synced ticket before its description", () => {
    assert.strictEqual(
      buildTicketThreadMessage(synced, "Steps", undefined),
      "Kanban ticket BACK-1 (Linear issue)\nBACK-1: Fix it\nhttps://linear.app/issue/BACK-1\n\nSteps",
    );
  });

  it("keeps the note when the description is empty", () => {
    assert.strictEqual(
      buildTicketThreadMessage(synced, "  ", "Plan only"),
      "Kanban ticket BACK-1 (Linear issue)\nBACK-1: Fix it\nhttps://linear.app/issue/BACK-1\n\nPlan only",
    );
  });
});

const ticket = Schema.decodeSync(KanbanTicket)({
  id: "ticket-1",
  projectId: "project-1",
  linear: null,
  identifier: "T-1",
  title: "Fix it",
  status: { kind: "local", state: "todo" },
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
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const bot = Schema.decodeSync(Bot)({
  id: "bot-1",
  name: "Ana",
  role: "",
  model: { instanceId: "codex", model: "gpt" },
  homeGeneration: 2,
  sectionId: null,
  position: 0,
  canManageBots: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const projectModel = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };

const harness = (options: { readonly projectModel: typeof projectModel | null }) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const linked: Array<ThreadId> = [];
  const layer = layerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(KanbanService)({
          readSnapshot: Effect.succeed({
            accounts: [],
            workspaces: [],
            links: [],
            states: [],
            tickets: [ticket],
            people: [],
            labels: [],
            linearProjects: [],
            milestones: [],
            cycles: [],
            views: [],
          }),
          ticketDetail: () => Effect.fail(new KanbanError({ message: "Not implemented yet." })),
          linkThread: ({ threadId }) =>
            Effect.sync(() => {
              linked.push(threadId);
              return { ...ticket, threadIds: [threadId] };
            }),
        }),
        Layer.mock(BotsStore)({
          getBot: (id) => Effect.succeed(id === bot.id ? Option.some(bot) : Option.none()),
        }),
        Layer.mock(Project.ProjectService)({
          getById: (id) =>
            Effect.succeedSome({
              id,
              defaultModelSelection: options.projectModel,
            } as unknown as ProjectRecord),
        }),
        ServerSettings.layerTest(),
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return {} as Orchestrator.OrchestratorV2DispatchResult;
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input);
              return {
                threadId: input.threadId,
                resumed: false,
              } as ThreadLaunch.ThreadLaunchResult;
            }),
        }),
        Layer.mock(DocumentText.DocumentText)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-kanban-start-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
  return { layer, dispatched, launched, linked };
};

describe("KanbanThreadStarter", () => {
  it.effect("queues the ticket in the bot's conversation and links it", () => {
    const { layer, dispatched, linked } = harness({ projectModel: null });
    return Effect.gen(function* () {
      const starter = yield* KanbanThreadStarter;
      const result = yield* starter.startThread({
        ticketId: ticket.id,
        target: { kind: "bot", botId: bot.id },
      });
      const threadId = botThreadId(bot.id, bot.homeGeneration);
      assert.strictEqual(result.threadId, threadId);
      assert.deepStrictEqual(linked, [threadId]);
      const command = dispatched[0];
      assert.strictEqual(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.strictEqual(command.threadId, threadId);
      assert.deepStrictEqual(command.dispatchMode, { type: "queue_after_active" });
      assert.strictEqual(command.text, "Kanban ticket T-1 (local ticket)\nT-1: Fix it");
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts a project thread in the root with the project's default model", () => {
    const { layer, launched, linked } = harness({ projectModel });
    return Effect.gen(function* () {
      const starter = yield* KanbanThreadStarter;
      const result = yield* starter.startThread({
        ticketId: ticket.id,
        target: { kind: "project" },
        note: "Plan only",
      });
      const launch = launched[0];
      assert.isDefined(launch);
      assert.strictEqual(launch?.threadId, result.threadId);
      assert.strictEqual(launch?.projectId, ticket.projectId);
      assert.strictEqual(launch?.title, "T-1 Fix it");
      assert.deepStrictEqual(launch?.modelSelection, projectModel);
      assert.deepStrictEqual(launch?.workspaceStrategy, { type: "root" });
      assert.strictEqual(
        launch?.initialMessage?.text,
        "Kanban ticket T-1 (local ticket)\nT-1: Fix it\n\nPlan only",
      );
      assert.deepStrictEqual(linked, [result.threadId]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a project without a model, and a missing ticket or bot", () => {
    const { layer, launched, linked } = harness({ projectModel: null });
    return Effect.gen(function* () {
      const starter = yield* KanbanThreadStarter;
      const messageOf = (exit: Exit.Exit<unknown, KanbanError>) =>
        Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?.message : null;
      const noModel = yield* Effect.exit(
        starter.startThread({ ticketId: ticket.id, target: { kind: "project" } }),
      );
      assert.strictEqual(messageOf(noModel), "This project has no default model. Pick one.");
      const noTicket = yield* Effect.exit(
        starter.startThread({
          ticketId: KanbanTicketId.make("ticket-2"),
          target: { kind: "project" },
        }),
      );
      assert.strictEqual(messageOf(noTicket), "Ticket ticket-2 does not exist.");
      const noBot = yield* Effect.exit(
        starter.startThread({
          ticketId: ticket.id,
          target: { kind: "bot", botId: BotId.make("bot-2") },
        }),
      );
      assert.strictEqual(messageOf(noBot), "Bot bot-2 does not exist.");
      assert.deepStrictEqual(launched, []);
      assert.deepStrictEqual(linked, []);
    }).pipe(Effect.provide(layer));
  });
});
