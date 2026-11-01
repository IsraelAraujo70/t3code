import { parseBotThreadOwner, type EnvironmentId } from "@t3tools/contracts";
import type { SidebarBotsLayout } from "@t3tools/contracts/settings";

import { useBotDirectory } from "../state/bots";
import { BotAvatar } from "./BotAvatar";

/**
 * Whether the thread list leaves a thread to the bots: a bot's main conversation in every layout
 * but "mixed" (the Bots block or the rail opens it), and its side threads where the Bots block
 * lists them under their bot.
 */
export function isBotsBlockThread(threadId: string, layout: SidebarBotsLayout): boolean {
  const owner = parseBotThreadOwner(threadId);
  if (owner === null) return false;
  if (owner.kind === "main") return layout !== "mixed";
  return layout === "sections" || layout === "tabs";
}

interface ThreadRowIdentity {
  readonly thread: { readonly environmentId: EnvironmentId; readonly id: string };
  readonly project: object | null;
  readonly projectDisplayName: string | null;
}

/**
 * A sidebar thread row's props with a bot thread's bot (its main conversation or a side thread) in
 * place of its project. Bot threads all live in the Scratch project, so the row would otherwise
 * say "No project". They live on the bots host, so the thread's own environment holds the
 * directory. Other threads pass through unchanged.
 */
export function useBotThreadRowProps<P extends ThreadRowIdentity>(props: P): P {
  const owner = parseBotThreadOwner(props.thread.id);
  const { directory } = useBotDirectory(owner === null ? null : props.thread.environmentId);
  if (owner === null) return props;
  const name = directory?.bots.find((bot) => bot.id === owner.botId)?.name ?? "Bot";
  return { ...props, project: null, projectDisplayName: name };
}

/** The bot's face for a bot thread, in place of a project's icon; nothing for other threads. */
export function BotThreadAvatar(props: { readonly threadId: string; readonly size: number }) {
  const owner = parseBotThreadOwner(props.threadId);
  if (owner === null) return null;
  return <BotAvatar botId={owner.botId} size={props.size} />;
}
