import { parseBotThreadId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { SymbolView } from "../components/ui/AppSymbol";
import { voiceController, useVoiceAvailable, useVoiceSnapshot } from "./voiceController";

type Props = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canOperateThread: boolean;
  readonly children: ReactNode;
};

/** Replaces dictation with session controls only for the conversation in this thread. */
export function VoiceModeControls({ environmentId, threadId, canOperateThread, children }: Props) {
  const available = useVoiceAvailable(environmentId);
  const snapshot = useVoiceSnapshot();
  const active =
    snapshot?.target.environmentId === environmentId &&
    snapshot.target.threadId === threadId &&
    snapshot.target.mode.type === "conversation";
  if (!available || parseBotThreadId(threadId) === null) return children;
  if (active)
    return (
      <>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={snapshot.muted ? "Ativar microfone" : "Desligar microfone"}
          accessibilityState={{ checked: snapshot.muted }}
          onPress={() => voiceController.setMuted(!snapshot.muted)}
          className="size-9 items-center justify-center rounded-full bg-subtle-strong"
        >
          <SymbolView
            name={snapshot.muted ? "mic.slash" : "mic"}
            size={18}
            tintColorClassName="accent-icon"
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Encerrar conversa por voz"
          onPress={voiceController.stop}
          className="ml-1 size-9 items-center justify-center rounded-full bg-subtle-strong"
        >
          <SymbolView name="xmark" size={18} tintColorClassName="accent-icon" />
        </Pressable>
      </>
    );
  return (
    <>
      {children}
      {canOperateThread ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Conversar por voz"
          onPress={() =>
            voiceController.start({ environmentId, threadId, mode: { type: "conversation" } })
          }
          className="ml-1 size-9 items-center justify-center rounded-full bg-subtle-strong"
        >
          <SymbolView name="waveform" size={18} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
    </>
  );
}
