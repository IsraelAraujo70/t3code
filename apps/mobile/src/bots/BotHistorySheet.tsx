import { botHistoryRange } from "@t3tools/client-runtime/bot-chat";
import { parseBotThreadId, type BotHistoryEntry } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { AppText } from "../components/ui/AppText";
import { useOpenLinkedThread } from "../features/threads/useOpenLinkedThread";
import { useAtomCommand } from "../state/use-atom-command";
import { KanbanPickerSheet } from "./kanban/KanbanPickerSheet";
import { botsEnvironment, useBotDirectory, useBotsEnvironmentId } from "./state";

type HistoryState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; generations: readonly BotHistoryEntry[] };

/** Loads earlier conversations only while the history sheet is mounted. */
export function BotHistorySheet(props: { threadId: string; botId: string; onClose: () => void }) {
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(environmentId);
  const bot = directory?.bots.find((entry) => entry.id === props.botId);
  const load = useAtomCommand(botsEnvironment.history, {
    label: "bot history",
    reportFailure: false,
  });
  const open = useOpenLinkedThread();
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const fetchHistory = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch history for the mounted sheet and ignore results after closing.
  useEffect(() => {
    let active = true;
    const parsed = parseBotThreadId(props.threadId);
    if (environmentId === null || parsed === null) return;
    void fetchHistory({ environmentId, input: { botId: parsed.botId } }).then((result) => {
      if (active)
        setState(
          result._tag === "Success"
            ? { kind: "ready", generations: result.value.generations }
            : { kind: "failed" },
        );
    });
    return () => {
      active = false;
    };
  }, [environmentId, props.threadId]);
  const message =
    environmentId === null
      ? "Bot environment unavailable."
      : state.kind === "loading"
        ? "Loading…"
        : state.kind === "failed"
          ? "Could not load the history."
          : state.generations.length === 0
            ? "No earlier conversations yet"
            : null;
  return (
    <KanbanPickerSheet
      title="Earlier conversations"
      onClose={props.onClose}
      selected={[props.threadId]}
      options={[
        ...(bot ? [{ value: bot.homeThreadId, label: "Current conversation" }] : []),
        ...(state.kind === "ready"
          ? state.generations.map((entry) => ({
              value: entry.threadId,
              label: botHistoryRange(entry),
              subtitle: `Conversation ${entry.generation}`,
            }))
          : []),
      ]}
      header={message ? <AppText className="text-foreground-muted">{message}</AppText> : null}
      onPick={(threadId) => {
        props.onClose();
        if (environmentId !== null && threadId !== props.threadId)
          open({ environmentId, threadId });
      }}
    />
  );
}
