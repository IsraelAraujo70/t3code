/**
 * Who wrote a message in a bot conversation a guest can see. The guest's messages carry the
 * `guest:` message-id prefix and reach the bot as `<guest name>: <text>`, so the bot (and the owner
 * reading the thread in T3) can tell the guest from the owner; the guest's app gets the text back
 * without the prefix.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const GUEST_MESSAGE_ID_PREFIX = "guest:";
export const OWNER_NAME_ENV = "T3CODE_OWNER_NAME";

/** The server owner's display name for guests and their bots; none when unset or blank. */
export const ownerName: Effect.Effect<Option.Option<string>> = Config.String(OWNER_NAME_ENV).pipe(
  Config.option,
  Effect.map(Option.map((name) => name.trim())),
  Effect.map(Option.filter((name) => name !== "")),
  Effect.orElseSucceed(() => Option.none<string>()),
);

/** Pure. The text the bot receives for a guest's message. */
export const fromGuest = (guestName: string, text: string) => `${guestName}: ${text}`.trimEnd();

/** Pure. Inverse of fromGuest, for showing the guest their own message. */
export const withoutGuestPrefix = (guestName: string, text: string) => {
  const prefix = `${guestName}:`;
  return text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text;
};
