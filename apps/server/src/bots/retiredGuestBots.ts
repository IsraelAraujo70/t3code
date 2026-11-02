/**
 * Bots a guest owned before guest mode was removed (rows left in `guest_bots`). Their threads may
 * sit on a host model that only the removed GuestModelPin overrode, so the Orchestrator refuses
 * every command that would start a turn there, and BotsStore hides the bots. Archive and delete
 * still go through, so the owner can clean them up.
 */
import {
  parseBotThreadOwner,
  type BotId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";

const TURN_COMMANDS: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set([
  "message.dispatch",
  "queue.resume",
  "queued-run.start",
  "queued-message.promote-to-steer",
  "prepared-run.retry",
] satisfies ReadonlyArray<OrchestrationV2ServerCommand["type"]>);

/** Pure. Whether `command` would start or resume a turn on a thread of a retired guest bot. */
export function startsRetiredGuestBotTurn(
  retired: ReadonlySet<BotId>,
  command: OrchestrationV2ServerCommand,
): boolean {
  if (retired.size === 0 || !TURN_COMMANDS.has(command.type) || !("threadId" in command)) {
    return false;
  }
  const owner = parseBotThreadOwner(command.threadId);
  return owner !== null && retired.has(owner.botId);
}
