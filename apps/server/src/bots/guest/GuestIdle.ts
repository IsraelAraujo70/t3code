/**
 * Stops a guest bot's sandbox container once the bot has been idle for `T3CODE_GUEST_IDLE_MS`
 * (default 10 minutes), well before the provider-wide 30 minute idle timeout. It goes through
 * BotSessionRestart, which releases the idle provider session the way the idle timeout does: the
 * Claude process exits, its `docker run --rm` container goes with it, and the next message starts
 * a fresh container that resumes the same conversation from the guest's volume.
 *
 * Every settled run of a guest bot (re)arms its timer; a run starting cancels it. A restart that
 * finds the bot busy is dropped: that run's end arms the timer again.
 */
import { type BotId, parseBotThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import { BotSessionRestart } from "../restart/BotSessionRestart.ts";
import { GuestStore } from "./GuestStore.ts";

export const GUEST_IDLE_ENV = "T3CODE_GUEST_IDLE_MS";
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const guests = yield* GuestStore;
    const restarts = yield* BotSessionRestart;
    const idleMs = yield* Config.Int(GUEST_IDLE_ENV).pipe(
      Config.withDefault(DEFAULT_IDLE_MS),
      Effect.orElseSucceed(() => DEFAULT_IDLE_MS),
    );
    const timers = yield* FiberMap.make<BotId>();

    const stopWhenIdle = (botId: BotId) =>
      Effect.sleep(Duration.millis(Math.max(1, idleMs))).pipe(
        Effect.andThen(restarts.restart({ botId })),
        Effect.tap((result) =>
          result.stopped
            ? Effect.logInfo("Stopped an idle guest bot's sandbox", { botId })
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logDebug("Guest bot not idle yet; its next settled run re-arms", {
            botId,
            error: error.message,
          }),
        ),
      );

    const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "run.updated") return;
      const parsed = parseBotThreadId(event.threadId);
      if (parsed === null) return;
      const owner = yield* guests.guestOfBot(parsed.botId);
      if (Option.isNone(owner)) return;
      if (isTerminalRunStatus(event.payload.status)) {
        yield* FiberMap.run(timers, parsed.botId, stopWhenIdle(parsed.botId));
      } else {
        yield* FiberMap.remove(timers, parsed.botId);
      }
    });

    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        handle(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Guest idle tracking failed for an event", { cause }),
          ),
        ),
      ),
    );
  }),
);
