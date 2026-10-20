/**
 * Bot faces (friend fork): a little creature per bot, picked from its id so the same bot always
 * looks the same on every client and matches the face it had in the friend app. A face is a stack
 * of layers (head, shine, blush, eyes, mouth) drawn in one shared 18-unit frame
 * (`BOT_AVATAR_VIEW_BOX`); web renders them as SVG, mobile with react-native-svg.
 */

/** One SVG element of a layer, with its attributes in camelCase. */
export type BotAvatarShape = {
  readonly kind: "path" | "circle" | "ellipse" | "rect";
  readonly [attribute: string]: string | number;
};

export const BOT_AVATAR_VIEW_BOX = "3 0.45 18 18";

export const HEADS: ReadonlyArray<ReadonlyArray<BotAvatarShape>> = [
  [
    {
      kind: "path",
      d: "M7.25 2.3C6.35 2.3 5.75 4.8 5.55 6.5C5.48 7.15 5.25 7.6 4.9 8.2C4.2 9.4 3.95 10.6 3.8 12.1C3.5 15 6.5 16.6 12 16.6C17.5 16.6 20.5 15 20.2 12.1C20.05 10.6 19.8 9.4 19.1 8.2C18.75 7.6 18.52 7.15 18.45 6.5C18.25 4.8 17.65 2.3 16.75 2.3C15.9 2.3 14.7 3.6 13.95 4.45C13.7 4.72 13.55 4.7 13.25 4.65C12.45 4.52 11.55 4.52 10.75 4.65C10.45 4.7 10.3 4.72 10.05 4.45C9.3 3.6 8.1 2.3 7.25 2.3Z",
    },
  ], // cat
  [
    {
      kind: "path",
      d: "M12 4.4C16.9 4.4 19.4 6.8 19.95 10.5C20.5 14.6 17.5 16.6 12 16.6C6.5 16.6 3.5 14.6 4.05 10.5C4.6 6.8 7.1 4.4 12 4.4Z",
    },
    { kind: "circle", cx: 6.7, cy: 5.3, r: 2.35 },
    { kind: "circle", cx: 17.3, cy: 5.3, r: 2.35 },
  ], // bear
  [
    {
      kind: "path",
      d: "M12 4.4C16.9 4.4 19.4 6.8 19.95 10.5C20.5 14.6 17.5 16.6 12 16.6C6.5 16.6 3.5 14.6 4.05 10.5C4.6 6.8 7.1 4.4 12 4.4Z",
    },
    { kind: "ellipse", cx: 8.7, cy: 4.0, rx: 1.55, ry: 3.2, transform: "rotate(-12 8.7 4)" },
    { kind: "ellipse", cx: 15.3, cy: 4.0, rx: 1.55, ry: 3.2, transform: "rotate(12 15.3 4)" },
  ], // bunny
  [
    {
      kind: "path",
      d: "M12 4.4C16.9 4.4 19.4 6.8 19.95 10.5C20.5 14.6 17.5 16.6 12 16.6C6.5 16.6 3.5 14.6 4.05 10.5C4.6 6.8 7.1 4.4 12 4.4Z",
    },
    { kind: "rect", x: 11.55, y: 1.9, width: 0.9, height: 3.0, rx: 0.45 },
    { kind: "circle", cx: 12.0, cy: 1.95, r: 1.35 },
  ], // antenna
];
export const EYES: ReadonlyArray<ReadonlyArray<BotAvatarShape>> = [
  [
    { kind: "circle", cx: 8.65, cy: 10.3, r: 0.95 },
    { kind: "circle", cx: 15.35, cy: 10.3, r: 0.95 },
  ], // dot
  [
    { kind: "circle", cx: 8.55, cy: 10.2, r: 1.2 },
    { kind: "circle", cx: 15.45, cy: 10.2, r: 1.2 },
  ], // big
  [
    { kind: "ellipse", cx: 8.7, cy: 10.2, rx: 0.75, ry: 1.2 },
    { kind: "ellipse", cx: 15.3, cy: 10.2, rx: 0.75, ry: 1.2 },
  ], // oval
];
export const MOUTHS: ReadonlyArray<ReadonlyArray<BotAvatarShape>> = [
  [
    {
      kind: "path",
      d: "M10.85 11.25C10.65 10.85 10.05 11.1 10.2 11.55C10.5 12.4 11.2 12.7 12 12.7C12.8 12.7 13.5 12.4 13.8 11.55C13.95 11.1 13.35 10.85 13.15 11.25C12.7 12.05 11.3 12.05 10.85 11.25Z",
    },
  ], // smile
  [
    {
      kind: "path",
      d: "M10.5 11.5Q11.25 12.5 12 11.6Q12.75 12.5 13.5 11.5",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 0.7,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
  ], // cat
  [{ kind: "ellipse", cx: 12.0, cy: 11.95, rx: 0.6, ry: 0.7 }], // o
  [{ kind: "path", d: "M10.65 11.3H13.35Q13.35 12.95 12 12.95Q10.65 12.95 10.65 11.3Z" }], // grin
];
export const EYES_CLOSED: ReadonlyArray<BotAvatarShape> = [
  {
    kind: "path",
    d: "M7.6 10.1Q8.65 11.1 9.7 10.1M14.3 10.1Q15.35 11.1 16.4 10.1",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 0.75,
    strokeLinecap: "round",
  },
];
export const SHINE: ReadonlyArray<BotAvatarShape> = [
  { kind: "ellipse", cx: 8.4, cy: 7.5, rx: 2.3, ry: 1.05, transform: "rotate(-28 8.4 7.5)" },
];
export const BLUSH: ReadonlyArray<BotAvatarShape> = [
  { kind: "ellipse", cx: 6.7, cy: 12.1, rx: 1.15, ry: 0.65 },
  { kind: "ellipse", cx: 17.3, cy: 12.1, rx: 1.15, ry: 0.65 },
];

/**
 * Hue turns from friend's violet accent, in degrees, about 36° apart so neighbours read as
 * different colours. Yellows are left out so the amber of a bot that needs the user stays its own
 * signal.
 */
const ACCENT_HUE = 248;
const HUES = [0, 36, 72, 108, 144, 204, 250, 290, 325] as const;

export interface BotAvatarLook {
  readonly head: ReadonlyArray<BotAvatarShape>;
  readonly eyes: ReadonlyArray<BotAvatarShape>;
  readonly mouth: ReadonlyArray<BotAvatarShape>;
  readonly blush: boolean;
  /** The body colour as a CSS `hsl()` string. */
  readonly body: string;
}

const MASK = (1n << 64n) - 1n;

/** FNV-1a over the id's UTF-8 bytes, then a finalizer so nearby ids spread over every field. */
function hashBotId(botId: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(botId)) {
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & MASK;
  }
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & MASK;
  h ^= h >> 33n;
  return h;
}

/** The parts and colour a bot id picks; the same choice friend's desktop made. */
export function botAvatarLook(botId: string): BotAvatarLook {
  const h = hashBotId(botId);
  const pick = (shift: bigint, n: number) => Number((h >> shift) % BigInt(n));
  const hue = (ACCENT_HUE + HUES[pick(24n, HUES.length)]!) % 360;
  return {
    head: HEADS[pick(0n, HEADS.length)]!,
    eyes: EYES[pick(8n, EYES.length)]!,
    mouth: MOUTHS[pick(16n, MOUTHS.length)]!,
    blush: ((h >> 32n) & 1n) === 1n,
    body: `hsl(${hue}, 72%, 74%)`,
  };
}
