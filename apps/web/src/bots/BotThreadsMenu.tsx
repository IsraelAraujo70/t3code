import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  BOT_THREAD_TITLE_LIMIT,
  parseBotThreadOwner,
  type BotThreadEntry,
  type BotId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { useThreadActions } from "../hooks/useThreadActions";
import { botsEnvironment, useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { commandFailureMessage } from "./botsSettingsShared";

/** Loads a bot's side threads when opened and offers thread creation. */
export function BotThreadsMenu(props: { readonly botId: BotId; readonly threadId: ThreadId }) {
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const navigate = useNavigate();
  const { archiveThread } = useThreadActions();
  const list = useAtomCommand(botsEnvironment.listThreads, {
    label: "bot threads",
    reportFailure: false,
  });
  const create = useAtomCommand(botsEnvironment.openThread, {
    label: "bot thread",
    reportFailure: false,
  });
  const [threads, setThreads] = useState<ReadonlyArray<BotThreadEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const bot = directory?.bots.find((entry) => entry.id === props.botId);
  if (environmentId === null || bot === undefined) return null;
  const go = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  const submit = () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    void create({
      environmentId,
      input: { botId: props.botId, title: title.trim() },
    }).then((result) => {
      setBusy(false);
      if (result._tag === "Success") {
        setDialogOpen(false);
        go(result.value.threadId);
      } else setError(commandFailureMessage(result) ?? "Could not open thread.");
    });
  };
  return (
    <>
      <Menu
        onOpenChange={(open) => {
          if (!open) return;
          setThreads(null);
          setError(null);
          void list({ environmentId, input: { botId: props.botId } }).then((result) => {
            if (result._tag === "Success") setThreads(result.value.threads);
            else setError(commandFailureMessage(result) ?? "Could not load threads.");
          });
        }}
      >
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost" aria-label={`Threads of ${bot.name}`} />}
        >
          <MessagesSquareIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem
            disabled={props.threadId === bot.homeThreadId}
            onClick={() => go(bot.homeThreadId)}
          >
            Main conversation
          </MenuItem>
          {error ? (
            <MenuItem disabled>{error}</MenuItem>
          ) : threads === null ? (
            <MenuItem disabled>Loading…</MenuItem>
          ) : (
            threads.map((thread) => (
              <MenuItem
                key={thread.threadId}
                disabled={thread.threadId === props.threadId}
                onClick={() => go(thread.threadId)}
              >
                {thread.title}
              </MenuItem>
            ))
          )}
          <MenuItem
            disabled={!canOperate}
            onClick={() => {
              setTitle("");
              setError(null);
              setDialogOpen(true);
            }}
          >
            New thread…
          </MenuItem>
          {parseBotThreadOwner(props.threadId)?.kind === "side" ? (
            <MenuItem
              disabled={!canOperate}
              onClick={() => {
                void archiveThread(scopeThreadRef(environmentId, props.threadId)).then((result) => {
                  if (result._tag === "Success") go(bot.homeThreadId);
                  else
                    toastManager.add({
                      type: "error",
                      title: "Could not archive this thread.",
                      description: commandFailureMessage(result) ?? undefined,
                    });
                });
              }}
            >
              Archive this thread
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New thread</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Title"
              maxLength={BOT_THREAD_TITLE_LIMIT}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {error ? <p role="alert">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button disabled={busy || !title.trim()} onClick={() => void submit()}>
              Create thread
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
