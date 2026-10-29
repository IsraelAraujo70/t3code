import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { AppText as Text } from "../components/ui/AppText";
import { useVoiceSnapshot } from "./voiceController";

type Props = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
};

/** Keeps the feed mounted so closing voice preserves its scroll position. */
export function VoiceOrb({ environmentId, threadId, children }: Props) {
  const snapshot = useVoiceSnapshot();
  const active =
    snapshot?.target.environmentId === environmentId &&
    snapshot.target.threadId === threadId &&
    snapshot.target.mode.type === "conversation";
  const phase = active ? snapshot.phase : null;
  const muted = active && snapshot.muted;
  // The phase sizes the orb: on Android a live session reads no audio levels (`liveStats`).
  const target = phase === "speaking" ? 1.2 : phase === "listening" && !muted ? 1 : 0.9;
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: withTiming(target, { duration: 250 }) }],
  }));
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
    <View style={{ flex: 1 }}>
      <View style={active ? { display: "none" } : { flex: 1 }}>{children}</View>
      {active ? (
        <View className="flex-1 items-center justify-center" accessibilityLiveRegion="polite">
          <Animated.View
            className="rounded-full bg-blue-400"
            style={[
              {
                width: 160,
                height: 160,
                opacity: phase === "connecting" || phase === "waiting" ? 0.45 : 1,
              },
              animatedStyle,
            ]}
          />
          <Text className="mt-8 text-foreground-muted">{label}</Text>
        </View>
      ) : null}
    </View>
  );
}
