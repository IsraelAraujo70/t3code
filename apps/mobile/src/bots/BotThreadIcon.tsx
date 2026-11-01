import { parseBotThreadOwner } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { BotAvatar } from "./BotAvatar";

/**
 * A bot thread (main conversation or side thread) shows its bot's face where other threads show
 * their project's icon: bot threads all live in the Scratch project, which says nothing.
 */
export function BotThreadIcon(props: {
  readonly threadId: string;
  readonly size: number;
  /** The project's icon, for every other thread. */
  readonly children: ReactNode;
}) {
  const owner = parseBotThreadOwner(props.threadId);
  return owner === null ? props.children : <BotAvatar botId={owner.botId} size={props.size} />;
}
