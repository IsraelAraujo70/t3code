import { botGenerationView } from "@t3tools/client-runtime/bot-chat";
import { parseBotThreadId } from "@t3tools/contracts";
import { useBotDirectory, useBotsEnvironmentId } from "./state";

/** Resolves a bot generation without subscribing to the directory for ordinary threads. */
export function useBotGenerationView(threadId: string | undefined) {
  const parsed = threadId === undefined ? null : parseBotThreadId(threadId);
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(parsed === null ? null : environmentId);
  const bot = directory?.bots.find((entry) => entry.id === parsed?.botId);
  return botGenerationView(threadId, bot?.homeGeneration ?? null);
}
