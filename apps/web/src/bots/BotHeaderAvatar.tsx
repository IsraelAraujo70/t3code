import { parseBotThreadId, type ThreadId } from "@t3tools/contracts";

import { WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { BotAvatar } from "./BotAvatar";

/**
 * The bot's face at the start of a bot conversation's header breadcrumb. Bot threads always live
 * in the Scratch project, so it takes the place of the "No project" crumb.
 */
export function BotHeaderAvatar(props: { readonly threadId: ThreadId }) {
  const parsed = parseBotThreadId(props.threadId);
  if (parsed === null) return null;
  return (
    <WorkspaceBreadcrumbItem className="group/bot">
      <BotAvatar botId={parsed.botId} size={22} />
    </WorkspaceBreadcrumbItem>
  );
}
