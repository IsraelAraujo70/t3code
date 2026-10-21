import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { voiceReaderPhaseOf } from "@t3tools/client-runtime/voice-reader";
import { SquareIcon, Volume2Icon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useServerConfigs } from "../state/entities";
import { voiceReaderPlayer } from "./voiceReaderPlayer";

type Props = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
};

/**
 * Reads one assistant reply aloud, or stops it. Shown only when its server offers the reader and
 * the reply's thread is known.
 */
export function VoiceReaderMessageButton({
  threadId,
  ...props
}: Omit<Props, "threadId"> & { readonly threadId: ThreadId | undefined }) {
  const configs = useServerConfigs();
  if (
    threadId === undefined ||
    configs.get(props.environmentId)?.environment.capabilities.voiceReader !== true
  )
    return null;
  return <ListenButton {...props} threadId={threadId} />;
}

function ListenButton(target: Props) {
  const phase = useSyncExternalStore(voiceReaderPlayer.subscribe, () =>
    voiceReaderPhaseOf(voiceReaderPlayer.getSnapshot(), target),
  );
  const label =
    phase === null
      ? "Ouvir esta resposta"
      : phase === "connecting"
        ? "Conectando… clique para cancelar"
        : "Parar a leitura";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={phase !== null}
            onClick={() => voiceReaderPlayer.toggle(target)}
          />
        }
      >
        {phase === "connecting" ? (
          <Spinner size="xs" />
        ) : phase === "speaking" ? (
          <SquareIcon className="size-3" />
        ) : (
          <Volume2Icon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
