import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { VoiceSnapshot } from "@t3tools/client-runtime/voice";
import { useEffect, useRef } from "react";

import { voiceController, useVoiceSnapshot } from "./voiceController";

const labels = {
  connecting: "Conectando…",
  listening: "Ouvindo",
  waiting: "Pensando…",
  speaking: "Falando",
};

/** Audio levels update only the circle's transform, without rendering React each tick. */
export function VoiceOrb({ snapshot }: { readonly snapshot: VoiceSnapshot }) {
  const orb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => {
      const levels = voiceController.getLevels();
      const level =
        snapshot.phase === "speaking"
          ? levels.voice
          : snapshot.phase === "listening" && !snapshot.muted
            ? levels.microphone
            : 0;
      if (orb.current) orb.current.style.transform = `scale(${1 + level * 0.35})`;
    };
    update();
    return voiceController.subscribeLevels(update);
  }, [snapshot.phase, snapshot.muted]);
  const label = `${labels[snapshot.phase]}${snapshot.muted ? " · Microfone silenciado" : ""}`;
  return (
    <div
      role="status"
      aria-label={label}
      className="pointer-events-none flex flex-col items-center gap-3 py-5"
    >
      <div
        ref={orb}
        className="size-18 rounded-full bg-radial from-primary/90 via-primary/50 to-primary/15 shadow-lg ring-1 ring-primary/30"
        style={{
          transition: "transform 100ms ease-out",
          opacity: snapshot.phase === "connecting" ? 0.4 : snapshot.phase === "waiting" ? 0.55 : 1,
        }}
      />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** Places the active thread's conversation above the composer surface. */
export function VoiceConversationOrb(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const snapshot = useVoiceSnapshot();
  if (
    snapshot?.target.mode.type !== "conversation" ||
    snapshot.target.environmentId !== props.environmentId ||
    snapshot.target.threadId !== props.threadId
  )
    return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full">
      <VoiceOrb snapshot={snapshot} />
    </div>
  );
}
