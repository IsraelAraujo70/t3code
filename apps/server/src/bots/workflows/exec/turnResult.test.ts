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
  const fullRun = (
    ordinal: number,
    status: OrchestrationV2Run["status"] = "completed",
  ): OrchestrationV2Run => ({
    id: RunId.make(`run:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: ProviderInstanceId.make("claude"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`user:${ordinal}`),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: null,
    status,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  });
  const message = (ordinal: number, role: "user" | "assistant", text: string) => {
    const { message, turnItem } = makeSubagentConversationArtifacts({
      messageId: MessageId.make(role === "user" ? `user:${ordinal}` : `reply:${ordinal}`),
      turnItemId: TurnItemId.make(`${role}:${ordinal}`),
      threadId,
      rootNodeId: NodeId.make("root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role,
      text,
      ordinal,
      now: at,
    });
    const runId = RunId.make(`run:${ordinal}`);
    return { message: { ...message, runId }, turnItem: { ...turnItem, runId } };
  };
  const command = message(3, "user", 'Background command "Run gates" completed (exit code 0)');
  const notice = {
    ...command,
    message: {
      ...command.message,
      notification: {
        source: { kind: "command" },
        outcome: "completed",
        summary: 'Command "Run gates" finished',
      },
    },
  } satisfies ReturnType<typeof message>;
  // Run 1 ended waiting on a background command, run 2 answered the nudge, and run 3 was opened by
  // the command's completion notice (run wfr_8d8708127ce0c0c5b95d).
  const thread = (
    third: OrchestrationV2Run["status"],
    ...extra: ReadonlyArray<ReturnType<typeof message>>
  ) => {
    const items = [
      message(1, "assistant", "The gates are still running."),
      message(2, "assistant", 'Done.\n```json\n{"status":"done"}\n```'),
      ...extra,
    ];
    return {
      runs: [fullRun(1), fullRun(2), fullRun(3, third)],
      messages: items.map((item) => item.message),
      turnItems: items.map((item) => item.turnItem),
    };
  };

  it("keeps the nudge's answer when a notice's run ends without a reply, whatever its status", () => {
    for (const status of ["completed", "failed", "interrupted"] as const) {
      const settled = stepReply(thread(status, notice), fullRun(2), fullRun(3, status));
      expect(settled.run.id).toBe("run:2");
      expect(lastJsonBlock(settled.text)).toEqual({ output: { status: "done" }, error: null });
    }
  });

  it("takes a notice's reply when the agent answered it", () => {
    const answer = message(3, "assistant", 'Gates passed.\n```json\n{"status":"blocked"}\n```');
    const settled = stepReply(thread("completed", notice, answer), fullRun(2), fullRun(3));
    expect(settled.run.id).toBe("run:3");
    expect(lastJsonBlock(settled.text).output).toEqual({ status: "blocked" });
  });

  it("still settles on a silent run the engine or a restart opened, never on one before the step", () => {
    const continuation = stepReply(thread("completed"), fullRun(2), fullRun(3));
    expect(continuation).toEqual({
      run: fullRun(3),
      text: "Child task completed without an assistant result.",
    });
    const silent = { ...thread("completed", notice), messages: [notice.message] };
    expect(stepReply(silent, fullRun(2), fullRun(3)).run.id).toBe("run:2");
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
