/**
 * Restarts a bot's provider process without touching its conversation. The idle bot's live
 * provider session is released the way the idle timeout releases it, so the next message opens a
 * fresh process (which reads MCP servers, skills and config again) that resumes the same native
 * provider thread. Nothing is held or cancelled: there is no run in flight to cut.
 *
 * Codex keeps one app-server per provider instance for every thread, so restarting a Codex bot
 * restarts that shared process, which is allowed only while none of its threads works.
 */
import {
  type BotRef,
  type BotRestartSessionResult,
  BotsError,
  botThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
import { BotsStore } from "../BotsStore.ts";

export class BotSessionRestart extends Context.Service<
  BotSessionRestart,
  {
    /** Fails with a message the user can act on while the bot or its process works. */
    readonly restart: (input: BotRef) => Effect.Effect<BotRestartSessionResult, BotsError>;
  }
>()("t3/bots/restart/BotSessionRestart") {}

/** A held queued run waits for a person; any other unsettled run is work the restart would cut. */
const isWorking = (run: OrchestrationV2Run) =>
  !isTerminalRunStatus(run.status) && !(run.status === "queued" && run.queueHeld === true);

const make = Effect.gen(function* () {
  const store = yield* BotsStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const restart = Effect.fn("BotSessionRestart.restart")(function* (input: BotRef) {
    const bot = yield* store.getBot(input.botId);
    if (Option.isNone(bot))
      return yield* new BotsError({ message: `Bot ${input.botId} does not exist.` });
    const { name } = bot.value;
    const threadId = botThreadId(bot.value.id, bot.value.homeGeneration);
    const { runs, providerThreads } = yield* projections
      .getThreadRecords(threadId, ["runs", "providerThreads"])
      .pipe(
        Effect.mapError(
          (cause) => new BotsError({ message: `Couldn't read ${name}'s conversation.`, cause }),
        ),
      );
    const busy = () =>
      new BotsError({
        message: `${name} is working. Restart the session once the current turn ends.`,
      });
    if (runs.some(isWorking)) return yield* busy();

    const sessionIds = new Set(
      providerThreads.flatMap((thread) =>
        thread.providerSessionId === null ? [] : [thread.providerSessionId],
      ),
    );
    let stopped = false;
    for (const providerSessionId of sessionIds) {
      if (!(yield* sessions.isLive(providerSessionId))) continue;
      yield* sessions
        .release({
          providerSessionId,
          reason: "idle_timeout",
          detail: `Restarted from ${name}'s conversation.`,
          onlyIfIdle: true,
        })
        .pipe(
          Effect.mapError(
            (cause) => new BotsError({ message: `Couldn't restart ${name}'s session.`, cause }),
          ),
        );
      if (yield* sessions.isLive(providerSessionId))
        return yield* new BotsError({
          message: `${name}'s provider process is still working (background work, or another thread sharing it). Try again once it is idle.`,
        });
      stopped = true;
    }
    yield* Effect.logInfo(
      stopped
        ? `Restarted ${name}'s provider session; the next message resumes it.`
        : `${name} had no provider session running; the next message starts one.`,
    );
    return { botId: bot.value.id, stopped } satisfies BotRestartSessionResult;
  });

  return BotSessionRestart.of({ restart });
});

/** Needs BotsStore and the orchestration runtime's projections and provider sessions. */
export const layer = Layer.effect(BotSessionRestart, make);

/** Above the orchestration runtime, which provides BotsStore and provider sessions. */
export const layerLive = layer.pipe(Layer.provide(ProjectionStore.layer));
