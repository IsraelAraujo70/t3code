/**
 * Compacts a bot's conversation once its context passes the threshold in botCompaction.ts. The
 * bot first gets a turn to save what it needs to its memory, which survives compaction because
 * it rides in the system prompt; when that turn completes, the server sends `/compact`. Both
 * queue behind whatever the bot is doing, and stable command ids keep each to one message. One
 * cycle runs at a time, however many runs complete past the threshold before it ends.
 */
import {
  botThreadId,
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  parseBotThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { BotsStore } from "../BotsStore.ts";
import { GuestStore } from "../guest/GuestStore.ts";
import { botCompactionPending, botCompactionStep, latestContextUsage } from "./botCompaction.ts";

export class BotCompactionReactor extends Context.Service<
  BotCompactionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/compaction/BotCompactionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* BotsStore;
  const guests = yield* GuestStore;

  const react = Effect.fnUntraced(function* (threadId: ThreadId, run: OrchestrationV2Run) {
    if (run.status !== "completed") return;
    const { thread, runs, providerTurns } = yield* projections.getThreadRecords(threadId, [
      "runs",
      "providerTurns",
    ]);
    if (thread.deletedAt !== null || thread.archivedAt !== null) return;
    const providerThreadId = run.providerThreadId ?? thread.activeProviderThreadId;
    const parsed = parseBotThreadId(threadId);
    const guestOwned = parsed !== null && Option.isSome(yield* guests.guestOfBot(parsed.botId));
    const step = botCompactionStep(
      run,
      latestContextUsage(providerTurns, providerThreadId),
      botCompactionPending(runs),
      guestOwned ? "files" : "memory",
    );
    if (step === null) return;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:bot-compaction:${step.kind}:${step.key}`),
      threadId,
      messageId: MessageId.make(step.messageId),
      text: step.text,
      ...(step.notification === undefined ? {} : { notification: step.notification }),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const guarded = (threadId: ThreadId, run: OrchestrationV2Run) =>
    react(threadId, run).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("compacting a bot conversation failed", { threadId, cause }),
      ),
    );

  /** Runs that completed while the server was down; replays are no-ops by command id. */
  const catchUp = Effect.gen(function* () {
    for (const bot of yield* store.listBots) {
      const threadId = botThreadId(bot.id, bot.homeGeneration);
      yield* Effect.gen(function* () {
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
        const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        if (latest !== undefined) yield* guarded(threadId, latest);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("catching up a bot compaction failed", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("catching up bot compactions failed", { cause }),
    ),
  );

  const start: BotCompactionReactor["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          Stream.runForEach(engine.streamDomainEvents, (event) =>
            event.type === "run.updated" && parseBotThreadId(event.threadId) !== null
              ? guarded(event.threadId, event.payload)
              : Effect.void,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("bot compaction event stream failed", { cause }),
            ),
          ),
          catchUp,
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return { start } satisfies BotCompactionReactor["Service"];
});

export const layer = Layer.effect(BotCompactionReactor, make);

/** Starts the reactor with the server. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* BotCompactionReactor;
    yield* reactor.start();
  }),
).pipe(Layer.provide(layer), Layer.provide(ProjectionStore.layer));
