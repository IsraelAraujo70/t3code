import { BOT_EARLIER_COPY, BOT_RENEWED_COPY } from "@t3tools/client-runtime/bot-chat";
import { View } from "react-native";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { useOpenLinkedThread } from "../features/threads/useOpenLinkedThread";

type Target = { readonly environmentId: string; readonly threadId: string };

/** Offers the previous conversation when a renewed bot thread is empty. */
export function BotRenewedNotice(props: Target) {
  const open = useOpenLinkedThread();
  return (
    <View className="flex-1 items-center justify-center gap-3 px-6">
      <AppText className="text-lg font-t3-medium">{BOT_RENEWED_COPY.title}</AppText>
      <AppText className="text-foreground-muted">{BOT_RENEWED_COPY.detail}</AppText>
      <Button label={BOT_RENEWED_COPY.action} onPress={() => open(props)} />
    </View>
  );
}

/** Replaces the composer of an archived bot generation with navigation to the current one. */
export function BotEarlierConversationBar(props: Target) {
  const open = useOpenLinkedThread();
  return (
    <View className="gap-3 rounded-2xl bg-secondary p-3">
      <AppText className="text-foreground-muted">{BOT_EARLIER_COPY.detail}</AppText>
      <Button label={BOT_EARLIER_COPY.action} onPress={() => open(props)} />
    </View>
  );
}
