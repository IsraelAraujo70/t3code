import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Rect } from "react-native-svg";

import type { BotId } from "../api";
import type { Pairing } from "../pairing";
import { colors } from "../theme";
import { conversationOf, useVoiceSnapshot, voiceAvailable, voiceController } from "./controller";

/** The bars of the wave, left to right. */
const BARS = [8, 16, 22, 14, 8].map((height, index) => ({ x: 1 + index * 5, height }));

function WaveIcon(props: { readonly color: string }) {
  return (
    <Svg width={26} height={24} viewBox="0 0 26 24">
      {BARS.map(({ x, height }) => (
        <Rect
          key={x}
          x={x}
          y={12 - height / 2}
          width={3}
          height={height}
          rx={1.5}
          fill={props.color}
        />
      ))}
    </Svg>
  );
}

/**
 * The composer's voice button. While a conversation with this bot is on, mute and hang up take its
 * place; typing still works.
 */
export function VoiceControls(props: { readonly pairing: Pairing; readonly botId: BotId }) {
  const conversation = conversationOf(useVoiceSnapshot(), props.botId);
  if (!voiceAvailable) return null;
  if (conversation !== null)
    return (
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={conversation.muted ? "Ligar microfone" : "Desligar microfone"}
          accessibilityState={{ checked: conversation.muted }}
          style={[styles.button, conversation.muted && styles.muted]}
          onPress={() => voiceController.setMuted(!conversation.muted)}
        >
          <Text style={styles.icon}>{conversation.muted ? "🔇" : "🎤"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Encerrar conversa por voz"
          style={[styles.button, styles.hangUp]}
          onPress={voiceController.stop}
        >
          <Text style={styles.hangUpText}>✕</Text>
        </Pressable>
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Conversar por voz"
      style={styles.button}
      onPress={() =>
        voiceController.start({
          pairing: props.pairing,
          botId: props.botId,
          mode: { type: "conversation" },
        })
      }
    >
      <WaveIcon color={colors.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  muted: { backgroundColor: colors.border },
  icon: { fontSize: 22 },
  hangUp: { backgroundColor: colors.text },
  hangUpText: { color: colors.userText, fontSize: 20, fontWeight: "700" },
});
