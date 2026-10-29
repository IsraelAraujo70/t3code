import {
  BOT_EARLIER_COPY,
  BOT_RENEWED_COPY,
  botGenerationView,
  type BotGenerationView,
} from "@t3tools/client-runtime/bot-chat";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseBotThreadId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../components/ui/button";
import { useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { buildThreadRouteParams } from "../threadRoutes";

/** Resolves a bot generation without subscribing ordinary threads to the directory. */
export function useBotGenerationView(
  threadId: ThreadId | null | undefined,
): BotGenerationView | null {
  const parsed = threadId == null ? null : parseBotThreadId(threadId);
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(parsed === null ? null : environmentId);
  const bot = directory?.bots.find((entry) => entry.id === parsed?.botId);
  return botGenerationView(threadId, bot?.homeGeneration ?? null);
}

/** Points an empty renewed conversation to its previous generation. */
export function BotRenewedNotice({ threadId }: { threadId: ThreadId | null | undefined }) {
  const view = useBotGenerationView(threadId);
  const environmentId = useBotsEnvironmentId();
  const navigate = useNavigate();
  if (view?.kind !== "current" || view.previousThreadId === null || environmentId === null)
    return null;
  const previousThreadId = view.previousThreadId;
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <h2 className="text-sm font-medium">{BOT_RENEWED_COPY.title}</h2>
      <p className="text-sm text-muted-foreground">{BOT_RENEWED_COPY.detail}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(environmentId, previousThreadId)),
          })
        }
      >
        {BOT_RENEWED_COPY.action}
      </Button>
    </div>
  );
}

/** Replaces message entry with navigation out of an earlier conversation. */
export function BotEarlierConversationBar({ threadId }: { threadId: ThreadId | null | undefined }) {
  const view = useBotGenerationView(threadId);
  const environmentId = useBotsEnvironmentId();
  const navigate = useNavigate();
  if (view?.kind !== "earlier" || environmentId === null) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <p className="text-sm text-muted-foreground">{BOT_EARLIER_COPY.detail}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(environmentId, view.currentThreadId)),
          })
        }
      >
        {BOT_EARLIER_COPY.action}
      </Button>
    </div>
  );
}
