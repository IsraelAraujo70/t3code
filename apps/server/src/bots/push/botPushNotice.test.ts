import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  BotId,
  botThreadId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2TurnItem,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import { BOT_COMPACTION_MESSAGE_PREFIX } from "../compaction/botCompaction.ts";
import { THREAD_WATCH_MESSAGE_PREFIX } from "../threadWatch/threadWatchNotice.ts";
import { type BotPushChange, botPushData, botPushNotice } from "./botPushNotice.ts";

const bot = { id: BotId.make("b_ada"), homeGeneration: 2 };
const home = botThreadId(bot.id, 2);
const at = (iso: string) => DateTime.makeUnsafe(iso);

const ran = (
  overrides: {
    readonly status?: "completed" | "failed" | "cancelled" | "interrupted" | "running";
    readonly userMessageId?: string;
    readonly senderThreadId?: ThreadId;
    readonly replies?: ReadonlyArray<{ readonly text: string; readonly createdAt: string }>;
  } = {},
): BotPushChange => ({
  type: "run",
  run: {
    id: RunId.make("run-1"),
    status: overrides.status ?? "completed",
    userMessageId: MessageId.make(overrides.userMessageId ?? "message:user-1"),
  },
  trigger:
    overrides.senderThreadId === undefined ? {} : { senderThreadId: overrides.senderThreadId },
  replies: (
    overrides.replies ?? [
      { text: "First  thought.", createdAt: "2026-10-21T10:00:00.000Z" },
      { text: "Done:\n\nthe   tests pass.", createdAt: "2026-10-21T10:00:05.000Z" },
      { text: "   ", createdAt: "2026-10-21T10:00:09.000Z" },
    ]
  ).map((reply) => ({ text: reply.text, createdAt: at(reply.createdAt) })),
});

const itemBase = {
  id: TurnItemId.make("item-1"),
  threadId: home,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 3,
  status: "waiting",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: at("2026-10-21T10:00:00.000Z"),
} as const;

const asked = (
  kind: "user_input" | "dynamic_tool_call" | "auth_refresh" | "command" = "user_input",
  item?: OrchestrationV2TurnItem,
): BotPushChange => ({
  type: "request",
  request: { id: RuntimeRequestId.make("request-1"), status: "pending", kind },
  item,
});

const question = (text: string): OrchestrationV2TurnItem => ({
  ...itemBase,
  type: "user_input_request",
  requestId: RuntimeRequestId.make("request-1"),
  questions: [{ id: "q1", header: "Deploy", question: text, options: [] }],
});

describe("botPushNotice", () => {
  it("pushes the last nonempty reply of a completed run, collapsed", () => {
    assert.deepStrictEqual(botPushNotice(home, bot, ran()), {
      kind: "replied",
      key: "bot-push:run:run-1",
      threadId: home,
      botId: bot.id,
      body: "Done: the tests pass.",
    });
  });

  it("clips a long reply", () => {
    const notice = botPushNotice(
      home,
      bot,
      ran({ replies: [{ text: "word ".repeat(400), createdAt: "2026-10-21T10:00:00.000Z" }] }),
    );
    assert.strictEqual(notice?.body.length, 600);
    assert.isTrue(notice?.body.endsWith("…"));
  });

  it("pushes a run a thread watch woke", () => {
    const notice = botPushNotice(
      home,
      bot,
      ran({ userMessageId: `${THREAD_WATCH_MESSAGE_PREFIX}watcher:target:run-9:completed` }),
    );
    assert.strictEqual(notice?.kind, "replied");
  });

  it("skips a run that completed without a reply", () => {
    assert.isNull(
      botPushNotice(
        home,
        bot,
        ran({ replies: [{ text: " \n", createdAt: "2026-10-21T10:00:00Z" }] }),
      ),
    );
    assert.isNull(botPushNotice(home, bot, ran({ replies: [] })));
  });

  it("skips runs that did not complete", () => {
    for (const status of ["failed", "cancelled", "interrupted", "running"] as const) {
      assert.isNull(botPushNotice(home, bot, ran({ status })), status);
    }
  });

  it("skips the runs that save memory and compact", () => {
    assert.isNull(
      botPushNotice(
        home,
        bot,
        ran({ userMessageId: `${BOT_COMPACTION_MESSAGE_PREFIX}flush:run-0` }),
      ),
    );
    assert.isNull(
      botPushNotice(
        home,
        bot,
        ran({ userMessageId: `${BOT_COMPACTION_MESSAGE_PREFIX}compact:run-0` }),
      ),
    );
  });

  it("skips a run another bot asked for, but not one another thread asked for", () => {
    assert.isNull(
      botPushNotice(home, bot, ran({ senderThreadId: botThreadId(BotId.make("b_bob"), 1) })),
    );
    assert.strictEqual(
      botPushNotice(home, bot, ran({ senderThreadId: ThreadId.make("mcp:worker") }))?.kind,
      "replied",
    );
  });

  it("skips threads that are not the bot's current main thread", () => {
    assert.isNull(botPushNotice(ThreadId.make("mcp:ordinary"), bot, ran()));
    assert.isNull(botPushNotice(botThreadId(bot.id, 1), bot, ran()));
    assert.isNull(botPushNotice(home, undefined, ran()));
    assert.isNull(botPushNotice(home, { ...bot, id: BotId.make("b_other") }, ran()));
  });

  it("pushes a pending question with its text", () => {
    assert.deepStrictEqual(
      botPushNotice(home, bot, asked("user_input", question("Deploy  to\nstaging now?"))),
      {
        kind: "waiting",
        key: "bot-push:request:request-1",
        threadId: home,
        botId: bot.id,
        body: "Waiting for you: Deploy to staging now?",
      },
    );
  });

  it("pushes an approval with its prompt, or a plain fallback", () => {
    const approval: OrchestrationV2TurnItem = {
      ...itemBase,
      type: "approval_request",
      requestId: RuntimeRequestId.make("request-1"),
      requestKind: "command",
      prompt: "Run rm -rf build?",
    };
    assert.strictEqual(
      botPushNotice(home, bot, asked("command", approval))?.body,
      "Waiting for you: Run rm -rf build?",
    );
    assert.strictEqual(botPushNotice(home, bot, asked("command"))?.body, "Waiting for your answer");
  });

  it("skips requests no one answers in the conversation, and answered ones", () => {
    assert.isNull(botPushNotice(home, bot, asked("dynamic_tool_call")));
    assert.isNull(botPushNotice(home, bot, asked("auth_refresh")));
    assert.isNull(
      botPushNotice(home, bot, {
        type: "request",
        request: { id: RuntimeRequestId.make("request-1"), status: "resolved", kind: "user_input" },
        item: undefined,
      }),
    );
  });
});

describe("botPushData", () => {
  it("carries the keys the Android app reads, as strings", () => {
    const notice = botPushNotice(home, bot, ran())!;
    assert.deepStrictEqual(
      botPushData(notice, {
        botName: "Ada",
        environmentId: EnvironmentId.make("env 1"),
        sentAt: 1_792_000_000_000,
      }),
      {
        t3_kind: "bot_message",
        alert_id: "bot-push:run:run-1",
        alert_title: "Ada",
        alert_body: "Done: the tests pass.",
        alert_path: "/threads/env%201/bot%3Ab_ada%3A2",
        alert_group: "b_ada",
        sent_at: "1792000000000",
      },
    );
  });
});
