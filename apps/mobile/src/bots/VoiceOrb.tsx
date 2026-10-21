import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { AppText as Text } from "../components/ui/AppText";
import { voiceController, useVoiceSnapshot } from "./voiceController";

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
  const scale = useSharedValue(1);
  useEffect(() => {
    let previous: number | null = null;
    const update = () => {
      const levels = voiceController.getLevels();
      const level =
        phase === "speaking"
          ? levels.voice
          : phase === "listening" && !muted
            ? levels.microphone
            : 0;
      const next = 1 + level * 0.3;
      if (next === previous) return;
      previous = next;
      scale.set(withTiming(next, { duration: 100 }));
    };
    update();
    return voiceController.subscribeLevels(update);
  }, [phase, muted, scale]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
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
