import { cn } from "~/lib/utils";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotId, EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { Label } from "../components/ui/label";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { botsEnvironment } from "../state/bots";
import { useAtomCommand } from "../state/use-atom-command";

/** Labelled field: a caption above its control, with an optional hint such as a length count. */
export function BotsField({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

/** The message of a failed command, or null when it succeeded or was interrupted. */
export function commandFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

/** Toasts a failed command; returns whether it succeeded. */
export function reportCommandResult(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  const message = commandFailureMessage(result);
  if (message !== null) {
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }
  return result._tag === "Success";
}

/** Asks before a destructive action. The first line of `message` is the dialog title. */
export async function confirmDestructive(message: string): Promise<boolean> {
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ??
    // No themed dialog host is mounted; fall back to the native prompt rather than acting unasked.
    window.confirm(message.replace("\n", " "))
  );
}

/** "Provider · Model" for a selection, falling back to raw ids when the provider is not listed. */
export function modelLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string {
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  return `${entry?.displayName ?? selection.instanceId} · ${model?.name ?? selection.model}`;
}

/**
 * Restarts a bot's provider process, showing progress in one toast. The next message starts a fresh
 * process that loads new MCP servers, skills and config, and keeps the conversation.
 */
export function useRestartBotSession() {
  const restart = useAtomCommand(botsEnvironment.restartSession, { label: "bot restart session" });
  return async (
    environmentId: EnvironmentId,
    bot: { readonly id: BotId; readonly name: string },
  ) => {
    const toastId = toastManager.add(
      stackedThreadToast({ type: "loading", title: `Restarting ${bot.name}…`, timeout: 0 }),
    );
    const result = await restart({ environmentId, input: { botId: bot.id } });
    const failure = commandFailureMessage(result);
    if (result._tag === "Success")
      toastManager.update(toastId, {
        type: "success",
        title: result.value.stopped ? `${bot.name} restarted` : `${bot.name} was not running`,
        description: "The next message starts a fresh session with the same conversation.",
        timeout: 5_000,
      });
    else if (failure !== null)
      toastManager.update(toastId, {
        type: "error",
        title: `Could not restart ${bot.name}`,
        description: failure,
        timeout: 8_000,
      });
    else toastManager.close(toastId);
  };
}
