import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotHistoryEntry, BotId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { botsEnvironment, useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { commandFailureMessage } from "./botsSettingsShared";

type HistoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly generations: ReadonlyArray<BotHistoryEntry> };

const dayAndTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const entryLabel = (entry: BotHistoryEntry) =>
  entry.endedAt === null
    ? `From ${dayAndTime(entry.startedAt)}`
    : `${dayAndTime(entry.startedAt)} – ${dayAndTime(entry.endedAt)}`;

/**
 * A bot's earlier conversations, read from the server only when the menu opens, so the directory
 * and the sidebar never carry them.
 */
export function BotHistoryMenu(props: { readonly botId: BotId; readonly threadId: ThreadId }) {
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(environmentId);
  const navigate = useNavigate();
  const load = useAtomCommand(botsEnvironment.history, {
    label: "bot history",
    reportFailure: false,
  });
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const bot = directory?.bots.find((entry) => entry.id === props.botId);
  if (environmentId === null || bot === undefined) return null;

  const open = async () => {
    setState({ kind: "loading" });
    const result = await load({ environmentId, input: { botId: props.botId } });
    setState(
      result._tag === "Success"
        ? { kind: "ready", generations: result.value.generations }
        : {
            kind: "failed",
            message: commandFailureMessage(result) ?? "Could not load the history.",
          },
    );
  };
  const go = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  return (
    <Menu onOpenChange={(isOpen) => isOpen && void open()}>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Earlier conversations of ${bot.name}`}
          />
        }
      >
        <HistoryIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroupLabel>History</MenuGroupLabel>
        <MenuItem
          disabled={props.threadId === bot.homeThreadId}
          onClick={() => go(bot.homeThreadId)}
        >
          Current conversation
        </MenuItem>
        {state.kind === "loading" ? <MenuItem disabled>Loading…</MenuItem> : null}
        {state.kind === "failed" ? <MenuItem disabled>{state.message}</MenuItem> : null}
        {state.kind === "ready" && state.generations.length === 0 ? (
          <MenuItem disabled>No earlier conversations yet</MenuItem>
        ) : null}
        {state.kind === "ready"
          ? state.generations.map((entry) => (
              <MenuItem
                key={entry.threadId}
                disabled={entry.threadId === props.threadId}
                onClick={() => go(entry.threadId)}
              >
                {entryLabel(entry)}
              </MenuItem>
            ))
          : null}
      </MenuPopup>
    </Menu>
  );
}
