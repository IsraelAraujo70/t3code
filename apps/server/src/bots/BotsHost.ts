/**
 * Bots run on exactly one machine: the server started with `T3CODE_BOTS_HOST=1`. Every other
 * server of the same fork (a laptop, a remote box) keeps bots off: it never opens `bots.sqlite`,
 * injects no instructions, refuses the bots RPCs and memory tools, and does not advertise the
 * `bots` capability, so clients read bots from the host environment instead.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const BOTS_HOST_ENV = "T3CODE_BOTS_HOST";

/** Whether this server hosts bots. Read once per use; unset or invalid means no. */
export const isBotsHost: Effect.Effect<boolean> = Config.Boolean(BOTS_HOST_ENV).pipe(
  Config.withDefault(false),
  Effect.orElseSucceed(() => false),
);

export const NOT_BOTS_HOST_MESSAGE = `Bots run on another machine. Start the server that hosts them with ${BOTS_HOST_ENV}=1.`;
