/**
 * Rotates bot conversations on rotationPolicy.ts: a handoff turn, then the next generation once
 * the bot is idle. Watches and kanban links move with the bot row (BotsStore.advanceGeneration),
 * then scheduled and webhook tasks; the old thread is archived last. Decisions run one at a time.
 */
import {
  type Bot,
  type BotId,
  type BotRef,
  BotsError,
  botThreadId,
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  parseBotThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../../serverActivation.ts";
import { BotsService } from "../BotsService.ts";
import { BotsStore } from "../BotsStore.ts";
import { GuestStore } from "../guest/GuestStore.ts";
import { KanbanService } from "../kanban/KanbanService.ts";
import {
  botRotationStep,
  clipHandoff,
  handoffMessageId,
  handoffRequest,
} from "./rotationPolicy.ts";

/** How often idle bots are checked; a due bot that nobody talks to rotates within this. */
const BOT_ROTATION_TICK = "10 minutes";

export class BotRotation extends Context.Service<
  BotRotation,
  {
    /** The user's reset: rotates right away, without a handoff turn or the idle checks. */
    readonly reset: (input: BotRef) => Effect.Effect<Bot, BotsError>;
    /** Takes the next step of one bot's rotation, if any. Never fails; failures are logged. */
    readonly consider: (botId: BotId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bots/rotation/BotRotation") {}

const ended = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const failure = (message: string) => (cause: unknown) => new BotsError({ message, cause });

const make = Effect.gen(function* () {
  const bots = yield* BotsService;
  const store = yield* BotsStore;
  const guests = yield* GuestStore;
  const kanban = yield* KanbanService;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const zone = DateTime.zoneMakeLocal();
  const decisions = yield* Semaphore.make(1);
  // The bot whose handoff turn is under way, so a saturated host runs one at a time.
  const handoffInFlight = yield* Ref.make<BotId | null>(null);

  /** Moves what lives outside bots.sqlite, then archives the old thread. Idempotent. */
  const follow = Effect.fn("BotRotation.follow")(function* (bot: Bot, fromGeneration: number) {
    yield* scheduled
      .rebindThread(botThreadId(bot.id, fromGeneration), botThreadId(bot.id, bot.homeGeneration))
      .pipe(Effect.mapError(failure(`Could not move the scheduled tasks of ${bot.name}.`)));
    yield* kanban.refresh;
    yield* bots.archiveGeneration(bot.id, fromGeneration);
  });

  const readHandoff = Effect.fn("BotRotation.readHandoff")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const { messages } = yield* projections
      .getThreadRecords(threadId, ["messages"], {
        messageRunIds: [runId],
        messageRoles: ["assistant"],
      })
      .pipe(Effect.mapError(failure("Could not read the handoff.")));
    const last = messages.toSorted(
      (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
    )[messages.length - 1];
    return last === undefined ? null : clipHandoff(last.text);
  });

  const rotate = Effect.fn("BotRotation.rotate")(function* (bot: Bot, handoffRunId: RunId | null) {
    const fromGeneration = bot.homeGeneration;
    const handoff =
      handoffRunId === null
        ? null
        : yield* readHandoff(botThreadId(bot.id, fromGeneration), handoffRunId);
    const next = yield* bots.advanceGeneration({ botId: bot.id, fromGeneration, handoff });
    if (Option.isNone(next)) return Option.none<Bot>();
    yield* follow(next.value, fromGeneration);
    yield* Effect.logInfo("Rotated a bot's conversation", {
      botId: bot.id,
      generation: next.value.homeGeneration,
    });
    return next;
  });

  /** Delegated tasks report back to the thread that started them; archiving it drops the report. */
  const tasksRunning = Effect.fn("BotRotation.tasksRunning")(function* (threadId: ThreadId) {
    const { threads } = yield* projections
      .getShellSnapshot({ familyOf: threadId })
      .pipe(Effect.mapError(failure("Could not read the bot's delegated tasks.")));
    return threads.some(
      (thread) =>
        thread.lineage.parentThreadId === threadId &&
        thread.lineage.relationshipToParent === "subagent" &&
        thread.activeRunId !== null,
    );
  });

  const step = Effect.fn("BotRotation.step")(function* (botId: BotId) {
    const found = yield* store.getBot(botId);
    if (Option.isNone(found)) return;
    const bot = found.value;
    const threadId = botThreadId(bot.id, bot.homeGeneration);
    const { thread, runs, runtimeRequests } = yield* projections
      .getThreadRecords(threadId, ["runs", "runtimeRequests"])
      .pipe(Effect.mapError(failure(`Could not read the conversation of ${bot.name}.`)));
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    const messageId = handoffMessageId(bot.id, bot.homeGeneration);
    const next = botRotationStep({
      rotation: bot.rotation,
      handoffMessageId: messageId,
      startedAt: thread.createdAt,
      now: yield* DateTime.now,
      zone,
      runs,
      requests: runtimeRequests,
    });
    if (next.kind === "none") return;
    if (yield* tasksRunning(threadId)) return;
    if (next.kind === "rotate") {
      yield* rotate(bot, next.handoffRunId);
      yield* Ref.update(handoffInFlight, (current) => (current === bot.id ? null : current));
      return;
    }
    const inFlight = yield* Ref.get(handoffInFlight);
    if (inFlight !== null && inFlight !== bot.id) return;
    const guestOwned = Option.isSome(yield* guests.guestOfBot(bot.id));
    const request = handoffRequest(guestOwned ? "files" : "memory");
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:bot-rotation:handoff:${bot.id}:${bot.homeGeneration}`),
        threadId,
        messageId: MessageId.make(messageId),
        text: request.text,
        notification: request.notification,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure(`Could not ask ${bot.name} for a handoff.`)));
    yield* Ref.set(handoffInFlight, bot.id);
  });

  const consider: BotRotation["Service"]["consider"] = (botId) =>
    decisions
      .withPermits(1)(step(botId))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("rotating a bot's conversation failed", { botId, cause }),
        ),
      );

  const considerAll = Effect.gen(function* () {
    for (const bot of yield* store.listBots) yield* consider(bot.id);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("listing bots to rotate failed", { cause })),
  );

  /** Finishes a rotation a crash or restart cut between the bots.sqlite write and the archive. */
  const heal = Effect.gen(function* () {
    for (const bot of yield* store.listBots) {
      if (bot.homeGeneration <= 1) continue;
      yield* follow(bot, bot.homeGeneration - 1).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("finishing a bot's rotation failed", { botId: bot.id, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("healing bot rotations failed", { cause })),
  );

  const reset = Effect.fn("BotRotation.reset")(function* (input: BotRef) {
    return yield* decisions.withPermits(1)(
      Effect.gen(function* () {
        const bot = yield* store.getBot(input.botId);
        if (Option.isNone(bot)) {
          return yield* new BotsError({ message: `Bot ${input.botId} does not exist.` });
        }
        const next = yield* rotate(bot.value, null);
        return Option.getOrElse(next, () => bot.value);
      }),
    );
  });

  const start: BotRotation["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          Stream.runForEach(engine.streamDomainEvents, (event) => {
            if (event.type !== "run.updated" || !ended.has(event.payload.status))
              return Effect.void;
            const parsed = parseBotThreadId(event.threadId);
            return parsed === null ? Effect.void : consider(parsed.botId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("bot rotation event stream failed", { cause }),
            ),
          ),
          heal.pipe(Effect.andThen(Effect.repeat(considerAll, Schedule.spaced(BOT_ROTATION_TICK)))),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return BotRotation.of({ reset, consider, start });
});

/** For tests, which bring their own ProjectionStoreV2. */
export const layerBase = Layer.effect(BotRotation, make);

export const layer = layerBase.pipe(Layer.provide(ProjectionStore.layer));

/** Starts the reactor with the server. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const rotation = yield* BotRotation;
    yield* rotation.start();
  }),
);
