import {
  BOT_AVATAR_VIEW_BOX,
  BLUSH,
  botAvatarLook,
  EYES_CLOSED,
  SHINE,
  type BotAvatarShape,
} from "@t3tools/client-runtime/bot-avatar";
import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

const INK = "hsl(240, 10%, 12%)";

function Shapes(props: { shapes: ReadonlyArray<BotAvatarShape> } & SVGProps<SVGGElement>) {
  const { shapes, ...group } = props;
  return (
    <g {...group}>
      {shapes.map(({ kind, ...attributes }) => {
        const Element = kind;
        return <Element key={`${kind}:${Object.values(attributes).join(",")}`} {...attributes} />;
      })}
    </g>
  );
}

/**
 * A bot's face, picked from its id. It holds still; hovering anything marked `group/bot` makes
 * it blink and hop once. `alert` paints the body amber, the colour reserved for a bot that is
 * waiting on the user.
 */
export function BotAvatar(props: {
  botId: string;
  size: number;
  alert?: boolean;
  className?: string;
}) {
  const look = botAvatarLook(props.botId);
  return (
    <svg
      aria-hidden
      viewBox={BOT_AVATAR_VIEW_BOX}
      width={props.size}
      height={props.size}
      className={cn("shrink-0 overflow-visible", props.className)}
    >
      <g className="origin-bottom [transform-box:fill-box] motion-safe:group-hover/bot:animate-bot-hop">
        <Shapes shapes={look.head} fill={props.alert ? "var(--warning)" : look.body} />
        <Shapes shapes={SHINE} fill="white" fillOpacity={0.4} />
        {look.blush && !props.alert ? (
          <Shapes shapes={BLUSH} fill="hsl(346, 85%, 78%)" fillOpacity={0.6} />
        ) : null}
        <Shapes
          shapes={look.eyes}
          fill={INK}
          className="motion-safe:group-hover/bot:animate-bot-blink-open"
        />
        <Shapes
          shapes={EYES_CLOSED}
          fill={INK}
          color={INK}
          className="motion-safe:group-hover/bot:animate-bot-blink-closed"
          opacity={0}
        />
        <Shapes shapes={look.mouth} fill={INK} color={INK} />
      </g>
    </svg>
  );
}
