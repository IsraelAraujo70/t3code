import type { GuestBotSummary, GuestImageUpload, GuestMessage } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import * as api from "./api";
import {
  EMPTY_CONVERSATION,
  isNewlyFinishedReply,
  reduceConversation,
  type Conversation,
  type ConversationAction,
} from "./conversation";
import type { Pairing } from "./pairing";
import { openBotStream, type BotStream } from "./stream";

export interface SessionState {
  readonly guestName: string;
  /** The owner's name, for their messages on a bot they share with Bia; null when unknown. */
  readonly ownerName: string | null;
  readonly bots: readonly GuestBotSummary[];
  readonly botsLoaded: boolean;
  readonly conversations: Readonly<Record<string, Conversation>>;
}

export interface FinishedReply {
  readonly bot: GuestBotSummary;
  readonly message: GuestMessage;
}

export interface Session {
  readonly pairing: Pairing;
  readonly getState: () => SessionState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reloads the bot list and every conversation; follows any new bot live. */
  readonly refresh: () => Promise<void>;
  readonly loadHistory: (botId: api.BotId) => Promise<void>;
  readonly send: (input: {
    readonly botId: api.BotId;
    readonly text: string;
    readonly uploads: readonly GuestImageUpload[];
    readonly imageUris: readonly string[];
  }) => Promise<void>;
  /** The app came back to the foreground; sockets may have died silently while it was away. */
  readonly resume: () => void;
  readonly dispose: () => void;
}

/**
 * Everything the app knows about one pairing: the bots, their conversations and one live stream
 * per bot. Streams stay open on every screen so a reply in another chat can raise a banner.
 */
export function createSession(options: {
  readonly pairing: Pairing;
  readonly onUnauthorized: () => void;
  readonly onReplyFinished: (reply: FinishedReply) => void;
}): Session {
  const { pairing } = options;
  let state: SessionState = {
    guestName: "",
    ownerName: null,
    bots: [],
    botsLoaded: false,
    conversations: {},
  };
  const listeners = new Set<() => void>();
  const streams = new Map<string, BotStream>();
  let disposed = false;
  let localIds = 0;

  const setState = (next: SessionState) => {
    if (disposed || next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const conversationOf = (botId: string) => state.conversations[botId] ?? EMPTY_CONVERSATION;

  const dispatch = (botId: string, action: ConversationAction) => {
    const current = conversationOf(botId);
    const next = reduceConversation(current, action);
    if (next !== current) {
      setState({ ...state, conversations: { ...state.conversations, [botId]: next } });
    }
  };

  const announceFinished = (
    botId: string,
    previous: GuestMessage | undefined,
    next: GuestMessage,
  ) => {
    const bot = state.bots.find((candidate) => candidate.id === botId);
    if (bot !== undefined && isNewlyFinishedReply(previous, next)) {
      options.onReplyFinished({ bot, message: next });
    }
  };

  const guard = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } catch (cause) {
      const error = api.errorFromFailure(cause);
      if (error.kind === "unauthorized") options.onUnauthorized();
      throw error;
    }
  };

  const loadHistory = async (botId: api.BotId) => {
    const history = await guard(api.loadHistory(pairing, botId));
    const before = conversationOf(botId).messages;
    // Only replies already known as streaming count: a reconnect must not announce old messages.
    for (const message of history.messages) {
      const previous = before.find((known) => known.id === message.id);
      if (previous !== undefined) announceFinished(botId, previous, message);
    }
    dispatch(botId, { type: "history", history });
  };

  const follow = (bot: GuestBotSummary) => {
    if (streams.has(bot.id)) return;
    streams.set(
      bot.id,
      openBotStream({
        pairing,
        botId: bot.id,
        onOpen: () => {
          loadHistory(bot.id).catch(() => undefined);
        },
        onUnauthorized: options.onUnauthorized,
        onEvent: (event) => {
          if (event.type === "message") {
            const previous = conversationOf(bot.id).messages.find(
              (known) => known.id === event.message.id,
            );
            announceFinished(bot.id, previous, event.message);
          }
          dispatch(bot.id, { type: "event", event });
        },
      }),
    );
  };

  const refresh = async () => {
    const response = await guard(api.listBots(pairing));
    setState({
      ...state,
      guestName: response.guest.name,
      ownerName: response.ownerName ?? null,
      bots: response.bots,
      botsLoaded: true,
    });
    const ids = new Set<string>(response.bots.map((bot) => bot.id));
    for (const [botId, stream] of streams) {
      if (!ids.has(botId)) {
        stream.close();
        streams.delete(botId);
      }
    }
    for (const bot of response.bots) follow(bot);
    await Promise.all(response.bots.map((bot) => loadHistory(bot.id).catch(() => undefined)));
  };

  return {
    pairing,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    loadHistory,
    send: async ({ botId, text, uploads, imageUris }) => {
      localIds += 1;
      const localId = `local-${localIds}`;
      dispatch(botId, {
        type: "queued",
        message: { localId, text, imageUris, createdAt: new Date().toISOString(), serverId: null },
      });
      try {
        const result = await guard(api.sendMessage(pairing, botId, { text, attachments: uploads }));
        dispatch(botId, { type: "sent", localId, messageId: result.messageId });
      } catch (error) {
        dispatch(botId, { type: "dropped", localId });
        throw error;
      }
    },
    resume: () => {
      for (const stream of streams.values()) stream.reconnectNow();
    },
    dispose: () => {
      disposed = true;
      for (const stream of streams.values()) stream.close();
      streams.clear();
      listeners.clear();
    },
  };
}

/** `select` must return a value already in the state, not a new object, or React re-renders forever. */
export function useSessionState<T>(session: Session, select: (state: SessionState) => T): T {
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}
