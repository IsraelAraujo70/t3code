import { botThreadId, BotId, MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import { botBubbleLayout, botChatRows } from "./botChatBubbles.logic";

const BOT_THREAD = botThreadId(BotId.make("b_1"), 1);
const CODE_THREAD = "thread-code-1";
const at = "2026-10-24T10:00:00.000Z";
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

const message = (
  id: string,
  role: "user" | "assistant",
  runId: RunId | null = null,
): MessagesTimelineRow => ({
  kind: "message",
  id,
  createdAt: at,
  durationStart: at,
  showAssistantMeta: role === "assistant",
  showAssistantCopyButton: role === "assistant",
  assistantCopyStreaming: false,
  message: {
    id: MessageId.make(id),
    role,
    text: id,
    runId,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});

const work = (id: string, runId: RunId): MessagesTimelineRow => ({
  kind: "work",
  id,
  createdAt: at,
  isExpandedToolGroup: false,
  groupedEntries: [{ id: `${id}:entry`, createdAt: at, runId, label: "Ran ls", tone: "tool" }],
});

const fold = (runId: RunId, expanded: boolean): MessagesTimelineRow => ({
  kind: "turn-fold",
  id: `fold:${runId}`,
  createdAt: at,
  runId,
  label: "Worked for 12s",
  expanded,
});

// Event rows carry a whole projected turn item; only its type, status and run matter here.
const event = (id: string, type: string, status: string, runId: RunId): MessagesTimelineRow =>
  ({
    kind: "event",
    id,
    createdAt: at,
    projectedItem: { item: { type, status, runId } },
  }) as unknown as MessagesTimelineRow;

const ids = (rows: ReadonlyArray<MessagesTimelineRow>) => rows.map((row) => row.id);

describe("botChatRows", () => {
  const live: MessagesTimelineRow[] = [
    message("u1", "user"),
    { kind: "thinking", id: "thinking", createdAt: at },
    work("w1", run1),
    message("a1", "assistant", run1),
    {
      kind: "work-toggle",
      id: "toggle",
      createdAt: at,
      runId: run1,
      groupId: "g",
      hiddenCount: 3,
      expanded: false,
      summary: "3 tools",
      summaryKind: "tools",
      hasFailure: false,
    } as MessagesTimelineRow,
    { kind: "working", id: "working", createdAt: at },
  ];

  it("keeps a code thread's rows untouched", () => {
    expect(botChatRows(CODE_THREAD, live)).toBe(live);
  });

  it("hides tool calls and progress rows of a running bot turn", () => {
    expect(ids(botChatRows(BOT_THREAD, live))).toEqual(["u1", "a1"]);
  });

  it("keeps a settled turn's fold, and shows its work only while the fold is open", () => {
    const settled = (expanded: boolean): MessagesTimelineRow[] => [
      message("u1", "user"),
      fold(run1, expanded),
      ...(expanded ? [work("w1", run1)] : []),
      message("a1", "assistant", run1),
      message("u2", "user"),
      work("w2", run2),
    ];
    expect(ids(botChatRows(BOT_THREAD, settled(false)))).toEqual(["u1", "fold:run-1", "a1", "u2"]);
    expect(ids(botChatRows(BOT_THREAD, settled(true)))).toEqual([
      "u1",
      "fold:run-1",
      "w1",
      "a1",
      "u2",
    ]);
  });

  it("keeps failures and interrupts visible, and hides other events", () => {
    const rows = [
      message("u1", "user"),
      event("todo", "todo_list", "completed", run1),
      event("failed", "error", "failed", run1),
      event("recovered", "error", "completed", run1),
      event("stopped", "run_interrupt_result", "completed", run1),
    ];
    expect(ids(botChatRows(BOT_THREAD, rows))).toEqual(["u1", "failed", "stopped"]);
  });
});

describe("botBubbleLayout", () => {
  it("is null for a code thread, so it keeps the regular timeline", () => {
    expect(botBubbleLayout(CODE_THREAD, [message("u1", "user")])).toBeNull();
    expect(botBubbleLayout(null, [message("u1", "user")])).toBeNull();
  });

  it("puts the user's messages on one side and the bot's on the other, grouping neighbours", () => {
    const rows = [
      message("u1", "user"),
      message("u2", "user"),
      fold(run1, false),
      message("a1", "assistant", run1),
      message("a2", "assistant", run1),
      message("a3", "assistant", run1),
      message("u3", "user"),
    ];
    const layout = botBubbleLayout(BOT_THREAD, rows)!;
    const bubble = (id: string) => layout.byRowId.get(id)?.bubble;
    expect(bubble("u1")).toEqual({ side: "user", joinsPrevious: false, joinsNext: true });
    expect(bubble("u2")).toEqual({ side: "user", joinsPrevious: true, joinsNext: false });
    expect(layout.byRowId.get("fold:run-1")).toEqual({ bubble: null });
    expect(bubble("a1")).toEqual({ side: "bot", joinsPrevious: false, joinsNext: true });
    expect(bubble("a2")).toEqual({ side: "bot", joinsPrevious: true, joinsNext: true });
    expect(bubble("a3")).toEqual({ side: "bot", joinsPrevious: true, joinsNext: false });
    expect(bubble("u3")).toEqual({ side: "user", joinsPrevious: false, joinsNext: false });
  });

  it("changes its key and the previous bubble's layout only when a new message regroups it", () => {
    const before = botBubbleLayout(BOT_THREAD, [message("a1", "assistant", run1)])!;
    const same = botBubbleLayout(BOT_THREAD, [message("a1", "assistant", run1)])!;
    expect(same.key).toBe(before.key);
    expect(same.byRowId.get("a1")).toBe(before.byRowId.get("a1"));

    const after = botBubbleLayout(BOT_THREAD, [
      message("a1", "assistant", run1),
      message("a2", "assistant", run1),
    ])!;
    expect(after.key).not.toBe(before.key);
    expect(after.byRowId.get("a1")?.bubble?.joinsNext).toBe(true);
  });
});
