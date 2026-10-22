/**
 * Resumes a bot's held queue once the bot completes a run again; see botQueueResumeKey. Nobody
 * presses Resume on a bot thread, so without this a restart can park its waiting messages until
 * the user next writes to the bot.
 */
import {
  botThreadId,
  CommandId,
  type OrchestrationV2Run,
  parseBotThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { BotsStore } from "../BotsStore.ts";
import { botQueueResumeKey } from "./botQueue.ts";

export class BotQueueReactor extends Context.Service<
  BotQueueReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/queue/BotQueueReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* BotsStore;

  const resume = Effect.fn("BotQueueReactor.resume")(
    function* (threadId: ThreadId) {
      const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      if (thread.deletedAt !== null || thread.archivedAt !== null) return;
      const key = botQueueResumeKey(runs);
      if (key === null) return;
      yield* engine.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`server:bot-queue-resume:${key}`),
        threadId,
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("resuming a bot's held queue failed", { threadId, cause }),
        ),
      ),
  );

  const onRunUpdated = (threadId: ThreadId, run: OrchestrationV2Run) =>
    run.status === "completed" && parseBotThreadId(threadId) !== null
      ? resume(threadId)
      : Effect.void;

  /** Startup recovery holds every queue; a bot that was idle when the server stopped resumes. */
  const catchUp = Effect.gen(function* () {
    for (const bot of yield* store.listBots) {
      yield* resume(botThreadId(bot.id, bot.homeGeneration));
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("catching up bot queues failed", { cause })),
  );

  const start: BotQueueReactor["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          Stream.runForEach(engine.streamDomainEvents, (event) =>
            event.type === "run.updated"
              ? onRunUpdated(event.threadId, event.payload)
              : Effect.void,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("bot queue event stream failed", { cause }),
            ),
          ),
          catchUp,
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return { start } satisfies BotQueueReactor["Service"];
});

export const layer = Layer.effect(BotQueueReactor, make);

/** Starts the reactor with the server. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* BotQueueReactor;
    yield* reactor.start();
  }),
).pipe(Layer.provide(layer), Layer.provide(ProjectionStore.layer));
