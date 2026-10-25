import type { GuestHistoryResponse, GuestMessage, GuestStreamEvent } from "@t3tools/contracts";

/** A message Bia sent that the server has not echoed back yet. */
export interface OutgoingMessage {
  readonly localId: string;
  readonly text: string;
  readonly imageUris: readonly string[];
  readonly createdAt: string;
  /** The server's id once the POST answered; the echo with this id replaces this entry. */
  readonly serverId: string | null;
}

export interface Conversation {
  /** Oldest first, one entry per id. */
  readonly messages: readonly GuestMessage[];
  readonly outbox: readonly OutgoingMessage[];
  readonly working: boolean;
  readonly loaded: boolean;
}

export type ConversationAction =
  | { readonly type: "history"; readonly history: GuestHistoryResponse }
  | { readonly type: "event"; readonly event: GuestStreamEvent }
  | { readonly type: "queued"; readonly message: OutgoingMessage }
  | { readonly type: "sent"; readonly localId: string; readonly messageId: string }
  | { readonly type: "dropped"; readonly localId: string };

export const EMPTY_CONVERSATION: Conversation = {
  messages: [],
  outbox: [],
  working: false,
  loaded: false,
};

function time(message: GuestMessage): number {
  return Date.parse(message.createdAt);
}

function upsert(messages: readonly GuestMessage[], message: GuestMessage): GuestMessage[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index >= 0) {
    const next = [...messages];
    next[index] = message;
    return next;
  }
  let insertAt = messages.length;
  while (insertAt > 0 && time(messages[insertAt - 1]!) > time(message)) insertAt--;
  return [...messages.slice(0, insertAt), message, ...messages.slice(insertAt)];
}

function withoutEchoed(state: Conversation): Conversation {
  if (!state.outbox.some((entry) => entry.serverId !== null)) return state;
  const ids = new Set<string>(state.messages.map((message) => message.id));
  const outbox = state.outbox.filter(
    (entry) => entry.serverId === null || !ids.has(entry.serverId),
  );
  return outbox.length === state.outbox.length ? state : { ...state, outbox };
}

export function reduceConversation(state: Conversation, action: ConversationAction): Conversation {
  switch (action.type) {
    case "history": {
      let messages: readonly GuestMessage[] = state.messages;
      for (const message of action.history.messages) messages = upsert(messages, message);
      return withoutEchoed({ ...state, messages, working: action.history.working, loaded: true });
    }
    case "event": {
      const { event } = action;
      if (event.type === "working") return { ...state, working: event.working };
      return withoutEchoed({ ...state, messages: upsert(state.messages, event.message) });
    }
    case "queued":
      return { ...state, outbox: [...state.outbox, action.message] };
    case "sent":
      return withoutEchoed({
        ...state,
        outbox: state.outbox.map((entry) =>
          entry.localId === action.localId ? { ...entry, serverId: action.messageId } : entry,
        ),
      });
    case "dropped":
      return { ...state, outbox: state.outbox.filter((entry) => entry.localId !== action.localId) };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * True when `next` is an assistant reply that just finished; `previous` is the same id before.
 * What the bot's tools made (an image, a page) comes without text and is not a reply: the reply
 * that follows it is announced instead.
 */
export function isNewlyFinishedReply(
  previous: GuestMessage | undefined,
  next: GuestMessage,
): boolean {
  return (
    next.role === "assistant" &&
    !next.streaming &&
    next.text.trim() !== "" &&
    (previous?.streaming ?? true)
  );
}

/** The text of the latest message, for the bot list. */
/** The owner's label when the server does not say their name. */
export const OWNER_FALLBACK = "Outra pessoa";

/** Who wrote a message: Bia, the owner (on a bot they share), or the bot. */
export type MessageAuthor = "bia" | "owner" | "bot";

/** A server older than the `sender` field only had Bia's own user messages. */
export const authorOf = (message: Pick<GuestMessage, "role" | "sender">): MessageAuthor =>
  message.role === "assistant" ? "bot" : message.sender === "owner" ? "owner" : "bia";

export function lastMessagePreview(
  conversation: Conversation,
): { readonly from: MessageAuthor; readonly text: string } | null {
  const outgoing = conversation.outbox.at(-1);
  if (outgoing !== undefined) return { from: "bia", text: outgoing.text || "📷 Foto" };
  const last = conversation.messages.at(-1);
  if (last === undefined) return null;
  return {
    from: authorOf(last),
    text:
      last.text.trim() ||
      (last.html !== undefined
        ? `📄 ${last.html.title}`
        : last.attachments.length > 0
          ? last.role === "assistant"
            ? "🖼️ Imagem"
            : "📷 Foto"
          : "…"),
  };
}
