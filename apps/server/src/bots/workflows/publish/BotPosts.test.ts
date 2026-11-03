import { it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as BotsStore from "../../BotsStore.ts";
import { layer, WorkflowBotPosts } from "./BotPosts.ts";

const BOT = BotId.make("b_trader");
const bot = (homeGeneration: number): Bot => ({
  id: BOT,
  name: "Trader",
  role: "Trades.",
  model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" },
  homeGeneration,
  sectionId: null,
  position: 0,
  canManageBots: false,
  rotation: "daily",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const input = {
  runId: "wfr_0123456789abcdef0123",
  key: "post:done",
  botId: BOT,
  workflowTitle: "Heartbeat",
  report: "BTC -8%",
};

it.effect("posts to the bot's current thread once, and a replay after rotation finds it", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    // `<thread> <message>` of every dispatched message, queued as the projection holds it before
    // its turn starts: a message only, no turn item yet.
    const messages = new Set<string>();
    let generation = 4;
    const services = Layer.mergeAll(
      Layer.mock(BotsStore.BotsStore)({
        getBot: () => Effect.sync(() => Option.some(bot(generation))),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: <K extends ProjectionStore.ProjectionRecordField>(
          threadId: string,
          _fields: ReadonlyArray<K>,
          filter?: ProjectionStore.ProjectionRecordFilter,
        ) =>
          Effect.succeed({
            messages: (filter?.messageIds ?? []).filter((id) => messages.has(`${threadId} ${id}`)),
          } as unknown as ProjectionStore.ProjectionRecords<K>),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (command.type === "message.dispatch")
              messages.add(`${command.threadId} ${command.messageId}`);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const posts = yield* WorkflowBotPosts;
      expect(yield* posts.post(input)).toBe(`bot:${BOT}:4`);
      generation = 5;
      expect(yield* posts.post(input)).toBe(`bot:${BOT}:4`);
      expect(dispatched).toHaveLength(1);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(services))));
  }),
);
