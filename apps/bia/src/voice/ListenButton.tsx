import { Pressable, StyleSheet, Text } from "react-native";

import type { BotId } from "../api";
import type { ChatItem } from "../MessageBubble";
import type { Pairing } from "../pairing";
import { colors } from "../theme";
import { readPhaseOf, useVoiceSnapshot, voiceAvailable, voiceController } from "./controller";

/** Under a finished bot reply: tap to hear it whole, tap again to stop. Nothing for other items. */
export function ListenButton(props: {
  readonly item: ChatItem;
  readonly pairing: Pairing;
  readonly botId: BotId;
}) {
  const { item } = props;
  const message = item.kind === "server" ? item.message : null;
  const snapshot = useVoiceSnapshot();
  if (
    !voiceAvailable ||
    message === null ||
    message.role !== "assistant" ||
    message.streaming ||
    message.text.trim() === ""
  )
    return null;
  const reading = readPhaseOf(snapshot, props.botId, message.id);
  const label =
    reading === null ? "🔊 Ouvir" : reading === "connecting" ? "Preparando…" : "■ Parar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={reading === null ? "Ouvir esta resposta" : "Parar de ouvir"}
      hitSlop={8}
      style={styles.button}
      onPress={() =>
        voiceController.toggle({
          pairing: props.pairing,
          botId: props.botId,
          mode: { type: "read", messageId: message.id },
        })
      }
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Lines up with the bubble, past the bot's face.
  button: { alignSelf: "flex-start", marginLeft: 44, marginBottom: 4, paddingVertical: 4 },
  text: { fontSize: 14, color: colors.primary, fontWeight: "600" },
});
