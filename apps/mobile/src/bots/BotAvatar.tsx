import {
  BOT_AVATAR_VIEW_BOX,
  BLUSH,
  botAvatarLook,
  SHINE,
  type BotAvatarShape,
} from "@t3tools/client-runtime/bot-avatar";
import Svg, { Circle, Ellipse, G, Path, Rect, type GProps } from "react-native-svg";

const INK = "hsl(240, 10%, 12%)";
const ELEMENTS = { path: Path, circle: Circle, ellipse: Ellipse, rect: Rect } as const;

function Shapes(props: { shapes: ReadonlyArray<BotAvatarShape> } & GProps) {
  const { shapes, ...group } = props;
  return (
    <G {...group}>
      {shapes.map(({ kind, ...attributes }) => {
        const Element = ELEMENTS[kind];
        return <Element key={`${kind}:${Object.values(attributes).join(",")}`} {...attributes} />;
      })}
    </G>
  );
}

/** A bot's face, picked from its id; the same face web and the friend app show. Holds still. */
export function BotAvatar(props: { botId: string; size: number }) {
  const look = botAvatarLook(props.botId);
  return (
    <Svg width={props.size} height={props.size} viewBox={BOT_AVATAR_VIEW_BOX}>
      <Shapes shapes={look.head} fill={look.body} />
      <Shapes shapes={SHINE} fill="white" fillOpacity={0.4} />
      {look.blush ? <Shapes shapes={BLUSH} fill="hsl(346, 85%, 78%)" fillOpacity={0.6} /> : null}
      <Shapes shapes={look.eyes} fill={INK} />
      <Shapes shapes={look.mouth} fill={INK} color={INK} />
    </Svg>
  );
}
