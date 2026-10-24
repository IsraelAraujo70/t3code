/**
 * A bot a guest uses always runs on its own model, which the guest API only accepts when it is the
 * guest's Docker sandbox. This holds whoever sends to the bot's thread: the guest's app, the owner
 * from T3 (whose composer sends whatever model it shows), another bot, or the server. Without it, an
 * owner message would run the shared conversation, guest messages included, on a host provider.
 *
 * The Orchestrator applies `pin` to every command before deciding it (an optional service, so
 * upstream runtimes and tests behave as before).
 */
import { parseBotThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { BotsStore } from "../BotsStore.ts";
import { GuestStore } from "./GuestStore.ts";

/** Commands that pick a thread's model. */
const PINNED_TYPES = new Set<OrchestrationV2ServerCommand["type"]>([
  "message.dispatch",
  "thread.model-selection.set",
  "provider.switch",
  "thread.create",
]);

export class GuestModelPin extends Context.Service<
  GuestModelPin,
  {
    /**
     * The command with its model replaced by the bot's, when it targets the thread of a bot a
     * guest uses; any other command unchanged. A failed read dies rather than letting the command
     * through unpinned.
     */
    readonly pin: (
      command: OrchestrationV2ServerCommand,
    ) => Effect.Effect<OrchestrationV2ServerCommand>;
  }
>()("t3/bots/guest/GuestModelPin") {}

export const layer = Layer.effect(
  GuestModelPin,
  Effect.gen(function* () {
    const bots = yield* BotsStore;
    const guests = yield* GuestStore;
    return GuestModelPin.of({
      pin: Effect.fn("GuestModelPin.pin")(function* (command) {
        if (!PINNED_TYPES.has(command.type) || !("modelSelection" in command)) return command;
        if (!("threadId" in command)) return command;
        const parsed = parseBotThreadId(command.threadId);
        if (parsed === null) return command;
        const owner = yield* guests.guestOfBot(parsed.botId).pipe(Effect.orDie);
        if (Option.isNone(owner)) return command;
        const bot = yield* bots.getBot(parsed.botId).pipe(Effect.orDie);
        if (Option.isNone(bot)) return command;
        return { ...command, modelSelection: bot.value.model } as OrchestrationV2ServerCommand;
      }),
    });
  }),
);
