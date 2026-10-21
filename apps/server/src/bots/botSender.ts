import { parseBotThreadId, type ThreadId } from "@t3tools/contracts";

/** Opens the provider text of a message one bot sent to another thread. */
export const BOT_SENDER_PREFIX = "[From the bot in thread";

/** Whether a message's stored sender is another bot's thread. */
export function isFromBot(senderThreadId: ThreadId | undefined): boolean {
  return senderThreadId !== undefined && parseBotThreadId(senderThreadId) !== null;
}

/**
 * The provider text for a message, marked with its sender when another bot's thread sent it. The
 * server adds the mark from the stored sender, so a bot cannot pass its message off as the
 * user's. The stored message text, which clients render, stays unmarked.
 */
export function withBotSenderNote(text: string, senderThreadId: ThreadId | undefined): string {
  if (!isFromBot(senderThreadId)) return text;
  return `${BOT_SENDER_PREFIX} ${senderThreadId}, not from the user]\n\n${text}`;
}
