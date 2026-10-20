import { parseBotThreadId, type ThreadId } from "@t3tools/contracts";

import { useBotDirectory, useBotsEnvironmentId } from "./state";

/**
 * "💼 Financeiro" when a bot's thread (any generation) sent the message, or null for every
 * other sender. Reads the bot directory only for messages a bot sent.
 */
export function useBotSender(senderThreadId: ThreadId | undefined): string | null {
  const parsed = senderThreadId === undefined ? null : parseBotThreadId(senderThreadId);
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(parsed === null ? null : environmentId);
  const bot = directory?.bots.find((entry) => entry.id === parsed?.botId);
  return bot === undefined ? null : `${bot.emoji} ${bot.name}`;
}
