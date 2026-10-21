import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon, MicOffIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { isBotThreadId } from "./BotsSidebarSection";
import { voiceController, useVoiceAvailable, useVoiceSnapshot } from "./voiceController";

/** Keeps dictation available outside an active conversation in this thread. */
export function VoiceModeControls(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly canOperateThread: boolean;
  readonly dictation: ReactNode;
}) {
  const snapshot = useVoiceSnapshot();
  const available = useVoiceAvailable(props.environmentId);
  const active =
    snapshot?.target.mode.type === "conversation" &&
    snapshot.target.environmentId === props.environmentId &&
    snapshot.target.threadId === props.threadId;
  if (!available || !props.threadId || !isBotThreadId(props.threadId) || !props.canOperateThread)
    return props.dictation;
  if (active)
    return (
      <>
        <Button
          variant="ghost"
          size="icon-round"
          aria-label={snapshot.muted ? "Ligar microfone" : "Desligar microfone"}
          aria-pressed={snapshot.muted}
          onClick={() => voiceController.setMuted(!snapshot.muted)}
        >
          {snapshot.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
        <Button
          size="icon-round"
          aria-label="Encerrar conversa por voz"
          onClick={() => voiceController.stop()}
        >
          <XIcon />
        </Button>
      </>
    );
  return (
    <>
      {props.dictation}
      <Button
        size="icon-round"
        aria-label="Conversar por voz"
        onClick={() => {
          if (props.threadId)
            voiceController.start({
              environmentId: props.environmentId,
              threadId: props.threadId,
              mode: { type: "conversation" },
            });
        }}
      >
        <AudioLinesIcon />
      </Button>
    </>
  );
}
