import { BotId, botThreadId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity, ThreadFeedEntry } from "../lib/threadActivity";
import { botChatFeed, botFeedBubbles } from "./botChat.logic";

const BOT_THREAD = botThreadId(BotId.make("b_1"), 1);
const CODE_THREAD = ThreadId.make("thread-code-1");
const at = "2026-10-24T10:00:00.000Z";
const run1 = RunId.make("run-1");

const message = (id: string, role: "user" | "assistant"): ThreadFeedEntry => ({
  type: "message",
  id,
  createdAt: at,
  message: {
    id: MessageId.make(id),
    role,
    text: id,
    attachments: [],
    runId: role === "assistant" ? run1 : null,
    streaming: false,
    visibility: "local",
    sourceThreadId: BOT_THREAD,
    createdAt: at,
    updatedAt: at,
  },
});

const toggle = (id: string): ThreadFeedEntry => ({
  type: "work-toggle",
  id,
  createdAt: at,
  runId: run1,
  groupId: "g",
  hiddenCount: 2,
  expanded: false,
  summary: "2 tools",
  summaryKind: "dynamic-tool",
  hasFailure: false,
  live: false,
  shimmer: false,
});

// An activity carries a whole projected turn item; only its type and status matter here.
const activityGroup = (id: string, type: string, status: string): ThreadFeedEntry => ({
  type: "activity-group",
  id,
  createdAt: at,
  runId: run1,
  activities: [{ projectedItem: { item: { type, status } } } as unknown as ThreadFeedActivity],
});

const fold = (expanded: boolean): ThreadFeedEntry => ({
  type: "run-fold",
  id: "fold",
  createdAt: at,
  runId: run1,
  label: "Worked for 9s",
  expanded,
});

const ids = (entries: ReadonlyArray<ThreadFeedEntry>) => entries.map((entry) => entry.id);

describe("botChatFeed", () => {
  const live = [
    message("u1", "user"),
    { type: "thinking", id: "thinking", createdAt: at, runId: run1 } as const,
    toggle("tools"),
    activityGroup("todo", "todo_list", "completed"),
    message("a1", "assistant"),
  ];

  it("keeps a code thread's feed untouched", () => {
    expect(botChatFeed(CODE_THREAD, live)).toBe(live);
  });

  it("hides a bot's tool calls, thinking and activity", () => {
    expect(ids(botChatFeed(BOT_THREAD, live))).toEqual(["u1", "a1"]);
  });

  it("shows a settled turn's work only while its fold is open", () => {
    expect(ids(botChatFeed(BOT_THREAD, [fold(false), message("a1", "assistant")]))).toEqual([
      "fold",
      "a1",
    ]);
    expect(
      ids(botChatFeed(BOT_THREAD, [fold(true), toggle("tools"), message("a1", "assistant")])),
    ).toEqual(["fold", "tools", "a1"]);
  });

  it("keeps failures and secret requests visible", () => {
    const feed = [
      activityGroup("failed", "error", "failed"),
      activityGroup("secret", "secret_request", "running"),
      activityGroup("plan", "todo_list", "completed"),
    ];
    expect(ids(botChatFeed(BOT_THREAD, feed))).toEqual(["failed", "secret"]);
  });
});

describe("botFeedBubbles", () => {
  it("is null for a code thread", () => {
    expect(botFeedBubbles(CODE_THREAD, [message("u1", "user")])).toBeNull();
  });

  it("groups adjacent messages from the same side", () => {
    const layout = botFeedBubbles(BOT_THREAD, [
      message("u1", "user"),
      message("u2", "user"),
      fold(false),
      message("a1", "assistant"),
    ])!;
    expect(layout.byId.get("u1")).toEqual({ side: "user", joinsPrevious: false, joinsNext: true });
    expect(layout.byId.get("u2")).toEqual({ side: "user", joinsPrevious: true, joinsNext: false });
    expect(layout.byId.has("fold")).toBe(false);
    expect(layout.byId.get("a1")).toEqual({ side: "bot", joinsPrevious: false, joinsNext: false });
  });
});
