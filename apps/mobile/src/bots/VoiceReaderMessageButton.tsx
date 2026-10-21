import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { voiceReaderPhaseOf } from "@t3tools/client-runtime/voice-reader";
import { useSyncExternalStore } from "react";
import { Platform, Pressable, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../components/ui/AppActivityIndicator";
import { SymbolView } from "../components/ui/AppSymbol";
import { useServerConfigs } from "../state/entities";
import { voiceReaderPlayer } from "./voiceReaderPlayer";

type Props = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly iconColor: ColorValue;
};

/**
 * Reads one assistant reply aloud, or stops it. Android only (the WebRTC plugin is Android's),
 * and only when the reply's server offers the reader.
 */
export function VoiceReaderMessageButton(props: Props) {
  const configs = useServerConfigs();
  if (
    Platform.OS !== "android" ||
    configs.get(props.environmentId)?.environment.capabilities.voiceReader !== true
  )
    return null;
  return <ListenButton {...props} />;
}

function ListenButton({ iconColor, ...target }: Props) {
  const phase = useSyncExternalStore(voiceReaderPlayer.subscribe, () =>
    voiceReaderPhaseOf(voiceReaderPlayer.getSnapshot(), target),
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        phase === null
          ? "Ouvir esta resposta"
          : phase === "connecting"
            ? "Conectando, toque para cancelar"
            : "Parar a leitura"
      }
      accessibilityState={{ selected: phase !== null }}
      hitSlop={8}
      onPress={() => voiceReaderPlayer.toggle(target)}
      className="h-7 w-7 items-center justify-center"
    >
      {phase === "connecting" ? (
        <AppActivityIndicator size="small" />
      ) : (
        <SymbolView
          name={phase === "speaking" ? "stop.fill" : "speaker.wave.2"}
          size={13}
          tintColor={iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}
