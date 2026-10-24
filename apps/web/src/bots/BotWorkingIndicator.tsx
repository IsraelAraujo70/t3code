import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { isBotChatThread } from "@t3tools/client-runtime/bot-chat";
import { useBotSender } from "./useBotSender";
import { useVoiceSnapshot } from "./voiceController";

/**
 * A bot conversation hides its tool calls, so while the bot works this small bubble above the
 * composer says so, like a chat's typing indicator. It stays still: a looping animation would
 * keep the GPU busy for the whole turn. The voice orb takes the same place during a voice
 * conversation and already shows when the bot is busy.
 */
export function BotWorkingIndicator(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly working: boolean;
}) {
  const botThreadId =
    props.threadId !== null && isBotChatThread(props.threadId) ? props.threadId : undefined;
  const botName = useBotSender(botThreadId);
  const voice = useVoiceSnapshot();
  if (botThreadId === undefined || !props.working) return null;
  if (
    voice?.target.mode.type === "conversation" &&
    voice.target.environmentId === props.environmentId &&
    voice.target.threadId === props.threadId
  )
    return null;
  return (
    <div className="pointer-events-none absolute start-2 bottom-full pb-2">
      <div
        role="status"
        data-bot-working-indicator
        className="flex items-center gap-2 rounded-2xl rounded-es-md border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-xs"
      >
        <span aria-hidden className="flex gap-0.5">
          <span className="size-1.5 rounded-full bg-muted-foreground/70" />
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
        </span>
        {botName === null ? "Working…" : `${botName} is working…`}
      </div>
    </div>
  );
}
