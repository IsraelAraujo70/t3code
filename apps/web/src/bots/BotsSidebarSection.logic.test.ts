import {
  BotId,
  botThreadId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type BotDirectoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botActivityAt,
  botStatusFromShell,
  countBotsNeedingYou,
  resolveBotRows,
  type BotThreadShell,
} from "./BotsSidebarSection.logic";

const environmentId = EnvironmentId.make("env-primary");
const otherEnvironmentId = EnvironmentId.make("env-remote");

const runtime = {
  status: "running" as const,
  activeRunId: RunId.make("run-1"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-10-19T10:00:00.000Z",
};

const completedRun = {
  runId: RunId.make("run-1"),
  status: "completed" as const,
  requestedAt: "2026-10-19T09:58:00.000Z",
  startedAt: "2026-10-19T09:58:01.000Z",
  completedAt: "2026-10-19T10:00:00.000Z",
  assistantMessageId: null,
};

function shell(overrides: Partial<BotThreadShell> = {}): BotThreadShell {
  return {
    environmentId,
    id: ThreadId.make("bot:b_1:1"),
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    lastVisitedAt: null,
    updatedAt: "2026-10-19T09:00:00.000Z",
    ...overrides,
  };
}

function bot(id: string, generation: number): BotDirectoryEntry {
  const botId = BotId.make(id);
  return {
    id: botId,
    name: id,
    emoji: "🤖",
    role: "",
    model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    homeGeneration: generation,
    position: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    homeThreadId: botThreadId(botId, generation),
    memories: [],
  };
}

describe("botStatusFromShell", () => {
  it("treats a missing or unloaded thread as idle", () => {
    expect(botStatusFromShell(null)).toEqual({ kind: "idle", detail: null });
  });

  it("asks for approval before reporting the running turn", () => {
    expect(botStatusFromShell(shell({ hasPendingApprovals: true, runtime }))).toEqual({
      kind: "needs-you",
      detail: "Needs approval",
    });
    expect(botStatusFromShell(shell({ pendingSubagentRequest: "approval", runtime }))).toEqual({
      kind: "needs-you",
      detail: "Needs approval",
    });
  });

  it("reports a pending question, its own or a subagent's", () => {
    expect(botStatusFromShell(shell({ hasPendingUserInput: true, runtime }))).toEqual({
      kind: "needs-you",
      detail: "Waiting for your answer",
    });
    expect(botStatusFromShell(shell({ pendingSubagentRequest: "user_input" }))).toEqual({
      kind: "needs-you",
      detail: "Waiting for your answer",
    });
  });

  it("separates usage limits from other failures", () => {
    const failed = { ...runtime, status: "failed" as const, activeRunId: null, lastError: "boom" };
    expect(botStatusFromShell(shell({ runtime: failed }))).toEqual({
      kind: "needs-you",
      detail: "Failed",
    });
    expect(
      botStatusFromShell(shell({ runtime: { ...failed, lastErrorClass: "usage_limit" } })),
    ).toEqual({ kind: "needs-you", detail: "Usage limit" });
  });

  it("reports running and background-waiting turns as working", () => {
    expect(botStatusFromShell(shell({ runtime }))).toEqual({ kind: "working", detail: "Working" });
    expect(
      botStatusFromShell(shell({ runtime: { ...runtime, status: "idle", activeRunId: null } })),
    ).toEqual({ kind: "working", detail: "Working" });
  });

  it("needs the user for a finished run they have not opened since", () => {
    expect(
      botStatusFromShell(
        shell({ latestRun: completedRun, lastVisitedAt: "2026-10-19T09:59:00.000Z" }),
      ),
    ).toEqual({ kind: "needs-you", detail: "Finished" });
  });

  it("rests once the user has seen the finished run", () => {
    expect(
      botStatusFromShell(
        shell({ latestRun: completedRun, lastVisitedAt: "2026-10-19T10:05:00.000Z" }),
      ),
    ).toEqual({ kind: "idle", detail: null });
  });

  it("rests when no turn ever ran", () => {
    expect(botStatusFromShell(shell())).toEqual({ kind: "idle", detail: null });
  });
});

describe("countBotsNeedingYou", () => {
  it("counts only bots that need the user", () => {
    expect(
      countBotsNeedingYou([
        { kind: "needs-you", detail: "Failed" },
        { kind: "working", detail: "Working" },
        { kind: "idle", detail: null },
        { kind: "needs-you", detail: "Finished" },
      ]),
    ).toBe(2);
    expect(countBotsNeedingYou([])).toBe(0);
  });
});

describe("botActivityAt", () => {
  it("prefers the latest run completion over the thread update", () => {
    expect(botActivityAt(shell({ latestRun: completedRun }))).toBe("2026-10-19T10:00:00.000Z");
    expect(botActivityAt(shell())).toBe("2026-10-19T09:00:00.000Z");
    expect(botActivityAt(null)).toBeNull();
  });
});

describe("resolveBotRows", () => {
  it("keeps directory order and reads only the current main thread in the environment", () => {
    const first = bot("b_1", 2);
    const second = bot("b_2", 1);
    const rows = resolveBotRows([first, second], environmentId, [
      // An earlier generation of the first bot is no longer its main thread.
      shell({ id: botThreadId(first.id, 1), hasPendingApprovals: true }),
      shell({ id: first.homeThreadId, runtime }),
      // Same thread id, other environment.
      shell({
        environmentId: otherEnvironmentId,
        id: second.homeThreadId,
        hasPendingUserInput: true,
      }),
    ]);

    expect(rows.map((row) => row.bot.id)).toEqual([first.id, second.id]);
    expect(rows[0]!.threadRef).toEqual({ environmentId, threadId: first.homeThreadId });
    expect(rows[0]!.status).toEqual({ kind: "working", detail: "Working" });
    expect(rows[1]!.status).toEqual({ kind: "idle", detail: null });
    expect(rows[1]!.activityAt).toBeNull();
  });
});
