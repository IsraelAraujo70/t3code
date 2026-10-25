import { useEffect, useState, type ReactNode } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import type { BotId } from "../api";
import { colors, fontSize } from "../theme";
import { conversationOf, useVoiceSnapshot } from "./controller";

/**
 * Takes the chat's place while a conversation with this bot is on. The chat stays mounted, so
 * closing the voice keeps its scroll position.
 */
export function VoiceOrb(props: { readonly botId: BotId; readonly children: ReactNode }) {
  const conversation = conversationOf(useVoiceSnapshot(), props.botId);
  const phase = conversation?.phase ?? null;
  const muted = conversation?.muted === true;
  const [scale] = useState(() => new Animated.Value(1));
  // Sized by the phase alone: on Android a live session reads no audio levels (`liveStats`).
  const target = phase === "speaking" ? 1.2 : phase === "listening" && !muted ? 1 : 0.9;
  useEffect(() => {
    Animated.timing(scale, { toValue: target, duration: 250, useNativeDriver: true }).start();
  }, [scale, target]);
  const label = muted
    ? "Microfone desligado"
    : phase === "connecting"
      ? "Conectando…"
      : phase === "waiting"
        ? "Pensando…"
        : phase === "speaking"
          ? "Falando"
          : "Ouvindo";
  return (
    <View style={styles.fill}>
      <View style={conversation === null ? styles.fill : styles.hidden}>{props.children}</View>
      {conversation !== null ? (
        <View style={styles.center} accessibilityLiveRegion="polite">
          <Animated.View
            style={[
              styles.orb,
              {
                opacity: phase === "connecting" || phase === "waiting" ? 0.45 : 1,
                transform: [{ scale }],
              },
            ]}
          />
          <Text style={styles.label}>{label}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: "none" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  orb: { width: 160, height: 160, borderRadius: 80, backgroundColor: colors.primary },
  label: { marginTop: 32, fontSize: fontSize.body, color: colors.muted },
});
