import { parseBotThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { BotAvatar } from "./BotAvatar";

/** The bot's face before a bot conversation's header title; undefined for every other thread. */
export function botHeaderAvatar(threadId: string | undefined) {
  const parsed = threadId === undefined ? null : parseBotThreadId(threadId);
  if (parsed === null) return undefined;
  return (
    <View className="me-3">
      <BotAvatar botId={parsed.botId} size={28} />
    </View>
  );
}
