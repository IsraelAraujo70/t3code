import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { voiceReadPhaseOf } from "@t3tools/client-runtime/voice";
import { SquareIcon, Volume2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { voiceController, useVoiceAvailable, useVoiceSnapshot } from "./voiceController";

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
  const available = useVoiceAvailable(props.environmentId);
  if (threadId === undefined || !available) return null;
  return <ListenButton {...props} threadId={threadId} />;
}

function ListenButton(target: Props) {
  const phase = voiceReadPhaseOf(useVoiceSnapshot(), target);
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
            onClick={() =>
              voiceController.toggle({
                environmentId: target.environmentId,
                threadId: target.threadId,
                mode: { type: "read", messageId: target.messageId },
              })
            }
          />
        }
      >
        {phase === "connecting" || phase === "waiting" ? (
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
