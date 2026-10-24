import type { GuestMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_CONVERSATION,
  isNewlyFinishedReply,
  authorOf,
  lastMessagePreview,
  reduceConversation,
  type Conversation,
  type ConversationAction,
} from "./conversation";

function message(
  id: string,
  createdAt: string,
  overrides: Partial<Omit<GuestMessage, "id">> = {},
): GuestMessage {
  return {
    id: id as GuestMessage["id"],
    role: "assistant",
    text: id,
    attachments: [],
    streaming: false,
    createdAt: `2026-10-23T10:00:${createdAt}.000Z` as GuestMessage["createdAt"],
    ...overrides,
  };
}

function run(actions: readonly ConversationAction[], from: Conversation = EMPTY_CONVERSATION) {
  return actions.reduce(reduceConversation, from);
}

const ids = (state: Conversation) => state.messages.map((item) => item.id);

const queued: ConversationAction = {
  type: "queued",
  message: {
    localId: "local-1",
    text: "oi",
    imageUris: [],
    createdAt: "2026-10-23T10:00:05.000Z",
    serverId: null,
  },
};
const echo = message("srv-1", "05", { role: "user", text: "oi" });

describe("reduceConversation", () => {
  it("replaces a streamed message by id with its longer text", () => {
    const state = run([
      {
        type: "event",
        event: { type: "message", message: message("m1", "01", { text: "Oi", streaming: true }) },
      },
      {
        type: "event",
        event: { type: "message", message: message("m1", "01", { text: "Oi, Bia!" }) },
      },
    ]);
    expect(state.messages).toEqual([message("m1", "01", { text: "Oi, Bia!" })]);
  });

  it("keeps messages ordered by createdAt whatever order they arrive in", () => {
    const state = run([
      { type: "event", event: { type: "message", message: message("m3", "03") } },
      { type: "event", event: { type: "message", message: message("m1", "01") } },
      {
        type: "history",
        history: { messages: [message("m2", "02"), message("m4", "04")], working: true },
      },
    ]);
    expect(ids(state)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(state.working).toBe(true);
    expect(state.loaded).toBe(true);
  });

  it("tracks the working flag", () => {
    const state = run([{ type: "event", event: { type: "working", working: true } }]);
    expect(state.working).toBe(true);
    expect(
      run([{ type: "event", event: { type: "working", working: false } }], state).working,
    ).toBe(false);
  });

  it("drops the optimistic message when the echo arrives after the POST answered", () => {
    const sent = run([queued, { type: "sent", localId: "local-1", messageId: "srv-1" }]);
    expect(sent.outbox).toHaveLength(1);
    const echoed = run([{ type: "event", event: { type: "message", message: echo } }], sent);
    expect(echoed.outbox).toEqual([]);
    expect(ids(echoed)).toEqual(["srv-1"]);
  });

  it("drops the optimistic message when the echo arrived before the POST answered", () => {
    const state = run([
      queued,
      { type: "event", event: { type: "message", message: echo } },
      { type: "sent", localId: "local-1", messageId: "srv-1" },
    ]);
    expect(state.outbox).toEqual([]);
    expect(ids(state)).toEqual(["srv-1"]);
  });

  it("drops the optimistic message when a history reload has the echo", () => {
    const state = run([
      queued,
      { type: "sent", localId: "local-1", messageId: "srv-1" },
      { type: "history", history: { messages: [echo], working: false } },
    ]);
    expect(state.outbox).toEqual([]);
  });

  it("keeps an unrelated user message from deduping the optimistic one", () => {
    const state = run([
      queued,
      {
        type: "event",
        event: { type: "message", message: message("other", "04", { role: "user", text: "oi" }) },
      },
    ]);
    expect(state.outbox).toHaveLength(1);
  });

  it("removes a failed send", () => {
    expect(run([queued, { type: "dropped", localId: "local-1" }]).outbox).toEqual([]);
  });
});

describe("isNewlyFinishedReply", () => {
  it("is true only for an assistant reply that stops streaming", () => {
    const writing = message("m1", "01", { streaming: true });
    const done = message("m1", "01");
    expect(isNewlyFinishedReply(writing, done)).toBe(true);
    expect(isNewlyFinishedReply(undefined, done)).toBe(true);
    expect(isNewlyFinishedReply(done, done)).toBe(false);
    expect(isNewlyFinishedReply(undefined, writing)).toBe(false);
    expect(isNewlyFinishedReply(undefined, message("u1", "01", { role: "user" }))).toBe(false);
  });
});

describe("lastMessagePreview", () => {
  it("prefers a message still being sent, then the latest one", () => {
    expect(lastMessagePreview(EMPTY_CONVERSATION)).toBeNull();
    const withReply = run([
      {
        type: "event",
        event: { type: "message", message: message("m1", "01", { text: "Feito!" }) },
      },
    ]);
    expect(lastMessagePreview(withReply)).toEqual({ from: "bot", text: "Feito!" });
    expect(lastMessagePreview(run([queued], withReply))).toEqual({ from: "bia", text: "oi" });
  });

  it("tells Bia's messages from the owner's on a shared bot", () => {
    const fromOwner = run([
      {
        type: "event",
        event: {
          type: "message",
          message: message("m2", "02", { role: "user", sender: "owner", text: "Paguei a luz" }),
        },
      },
    ]);
    expect(lastMessagePreview(fromOwner)).toEqual({ from: "owner", text: "Paguei a luz" });
    expect(authorOf({ role: "user", sender: "guest" })).toBe("bia");
    // Servers before `sender` only sent Bia's own user messages.
    expect(authorOf({ role: "user" })).toBe("bia");
    expect(authorOf({ role: "assistant" })).toBe("bot");
  });
});
