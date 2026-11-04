import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";

import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { makeSubagentConversationArtifacts } from "@t3tools/provider-core/server/subagentProjection";

import { lastJsonBlock, stepReply, stepRuns, turnCost } from "./turnResult.ts";

const run = (id: string, ordinal: number) => ({ id: RunId.make(id), ordinal });
const attempt = (id: string, runId: string) => ({
  id: RunAttemptId.make(id),
  runId: RunId.make(runId),
});
const turn = (attemptId: string, turnTokenUsage?: TurnTokenUsage) => ({
  runAttemptId: RunAttemptId.make(attemptId),
  ...(turnTokenUsage === undefined ? {} : { turnTokenUsage }),
});
const complete = (inputTokens: number, outputTokens: number, cachedInputTokens: number) =>
  ({
    usageScope: "main_agent",
    hasSubagents: false,
    usageStatus: "complete",
    inputTokens,
    outputTokens,
    cachedInputTokens,
  }) as const;

describe("lastJsonBlock", () => {
  it("decodes the last json block and explains a missing or broken one", () => {
    expect(lastJsonBlock('a\n```json\n{"x":1}\n```\nb\n```json\n{"x":2}\n```')).toEqual({
      output: { x: 2 },
      error: null,
    });
    expect(lastJsonBlock("no block").error).toBe("the reply has no ```json block");
    expect(lastJsonBlock("```json\n{x}\n```").error).toMatch(/does not parse/);
  });
});

describe("stepReply", () => {
  const threadId = ThreadId.make("wfi:run:step");
  const at = DateTime.makeUnsafe("2026-11-04T12:51:44.000Z");
  const fullRun = (ordinal: number): OrchestrationV2Run => ({
    id: RunId.make(`run:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: ProviderInstanceId.make("claude"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`user:${ordinal}`),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: null,
    status: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  });
  const reply = (ordinal: number, text: string) => {
    const { message, turnItem } = makeSubagentConversationArtifacts({
      messageId: MessageId.make(`reply:${ordinal}`),
      turnItemId: TurnItemId.make(`reply:${ordinal}`),
      threadId,
      rootNodeId: NodeId.make("root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text,
      ordinal,
      now: at,
    });
    const runId = RunId.make(`run:${ordinal}`);
    return { message: { ...message, runId }, turnItem: { ...turnItem, runId } };
  };
  // Run 1 ended waiting on a background command, run 2 answered the nudge, and run 3 is the
  // command's completion notice, which ended without assistant text.
  const runs = [fullRun(1), fullRun(2), fullRun(3)];
  const replies = [
    reply(1, "The gates are still running."),
    reply(2, 'Done.\n```json\n{"status":"done"}\n```'),
  ];
  const thread = (extra: ReadonlyArray<ReturnType<typeof reply>> = []) => ({
    runs,
    messages: [...replies, ...extra].map((r) => r.message),
    turnItems: [...replies, ...extra].map((r) => r.turnItem),
  });

  it("keeps the nudge's answer when a background-task notice ends without a reply", () => {
    const settled = stepReply(thread(), fullRun(2), fullRun(3));
    expect(settled.run.id).toBe("run:2");
    expect(lastJsonBlock(settled.text)).toEqual({ output: { status: "done" }, error: null });
  });

  it("takes a notice's reply when the agent answered it, and never a run before the step's", () => {
    const later = reply(3, 'Gates passed.\n```json\n{"status":"blocked"}\n```');
    expect(lastJsonBlock(stepReply(thread([later]), fullRun(2), fullRun(3)).text).output).toEqual({
      status: "blocked",
    });
    const [before] = replies;
    const silent = { runs, messages: [before!.message], turnItems: [before!.turnItem] };
    expect(stepReply(silent, fullRun(2), fullRun(3))).toEqual({
      run: fullRun(3),
      text: "Child task completed without an assistant result.",
    });
  });
});

describe("turnCost", () => {
  it("sums the runs from the step's message to its result run, and only them", () => {
    // r1 the step's run, r2 a restart continuation or delegated follow-up, r3 its result, r4 the next step.
    const runs = [run("r4", 4), run("r1", 1), run("r3", 3), run("r2", 2), run("r0", 0)];
    const chain = stepRuns(runs, run("r1", 1), run("r3", 3));
    expect(chain.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const cost = turnCost(
      chain,
      [attempt("a1", "r1"), attempt("a2", "r2"), attempt("a3", "other")],
      [
        turn("a1", complete(100, 10, 40)),
        turn("a2", complete(50, 5, 0)),
        turn("a3", complete(9, 9, 0)),
      ],
    );
    expect(cost).toEqual({
      billable: 60 + 10 + 50 + 5,
      input: 150,
      output: 15,
      cacheRead: 40,
      usage: "complete",
      usdEstimate: null,
    });
  });

  it("reports unknown usage as partial or unavailable, never as a complete zero", () => {
    const chain = [run("r1", 1)];
    const attempts = [attempt("a1", "r1")];
    expect(turnCost(chain, attempts, []).usage).toBe("unavailable");
    expect(turnCost(chain, attempts, [turn("a1")]).usage).toBe("unavailable");
    expect(turnCost(chain, attempts, [turn("a1", complete(5, 1, 0)), turn("a1")]).usage).toBe(
      "partial",
    );
  });
});
