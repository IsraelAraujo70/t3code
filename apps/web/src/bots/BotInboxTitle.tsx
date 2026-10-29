import type { EnvironmentId } from "@t3tools/contracts";
import { useBotDirectory } from "../state/bots";
import { BotAvatar } from "./BotAvatar";

/** Decorates inbox conversations from the cached environment directory. */
export function BotInboxTitle(props: {
  environmentId: EnvironmentId;
  threadId: string;
  title: string;
}) {
  const { directory } = useBotDirectory(props.environmentId);
  const bot = directory?.bots.find((entry) => props.threadId.startsWith(`bot:${entry.id}:`));
  if (!bot) return props.title;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <BotAvatar botId={bot.id} size={18} />
      <span className="truncate">{bot.name || props.title}</span>
    </span>
  );
}
