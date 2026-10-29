import { parseBotThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { IconButton } from "../components/ui/IconButton";
import { BotAvatar } from "./BotAvatar";
import { BotHistorySheet } from "./BotHistorySheet";

/** The bot's face before a bot conversation's header title; undefined for every other thread. */
export function botHeaderAvatar(threadId: string | undefined) {
  if (threadId === undefined) return undefined;
  const parsed = parseBotThreadId(threadId);
  if (parsed === null) return undefined;
  return <BotHeaderAvatar threadId={threadId} botId={parsed.botId} />;
}

function BotHeaderAvatar(props: { threadId: string; botId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="me-3 flex-row items-center">
      <BotAvatar botId={props.botId} size={28} />
      <IconButton
        icon="clock"
        accessibilityLabel="Earlier conversations"
        onPress={() => setOpen(true)}
      />
      {open ? <BotHistorySheet {...props} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}
