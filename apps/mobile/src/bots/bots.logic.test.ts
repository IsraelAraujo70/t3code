import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";
import { botActivityAt, botStatusFromShell, withoutBotThreads } from "./bots.logic";

const environmentId = EnvironmentId.make("bots-host");
const NOW = "2026-10-20T12:00:00.000Z";

function botShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make("bot:writer:1"),
    title: "Writer",
    updatedAt: NOW,
    ...overrides,
  });
}

function runtime(
  status: NonNullable<EnvironmentThreadShell["runtime"]>["status"],
  lastErrorClass: NonNullable<EnvironmentThreadShell["runtime"]>["lastErrorClass"] = null,
): EnvironmentThreadShell["runtime"] {
  return {
    status,
    activeRunId: status === "running" ? RunId.make("run-1") : null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: lastErrorClass === null ? null : "Plan limit reached",
    lastErrorClass,
    updatedAt: NOW,
  };
}

const completedRun = {
  runId: RunId.make("run-1"),
  status: "completed",
  requestedAt: "2026-10-20T11:00:00.000Z",
  startedAt: "2026-10-20T11:00:00.000Z",
  completedAt: "2026-10-20T11:10:00.000Z",
  assistantMessageId: null,
} as const;

describe("botStatusFromShell", () => {
  it("is idle before the bot's conversation has loaded", () => {
    expect(botStatusFromShell(null)).toEqual({ kind: "idle", detail: null });
  });

  it("needs the user for approvals, questions, failures and usage limits", () => {
    expect(botStatusFromShell(botShell({ hasPendingApprovals: true }))).toEqual({
      kind: "needs-you",
      detail: "Needs approval",
    });
    expect(botStatusFromShell(botShell({ hasPendingUserInput: true }))).toEqual({
      kind: "needs-you",
      detail: "Waiting for your answer",
    });
    expect(botStatusFromShell(botShell({ runtime: runtime("failed") }))).toEqual({
      kind: "needs-you",
      detail: "Failed",
    });
    expect(botStatusFromShell(botShell({ runtime: runtime("failed", "usage_limit") }))).toEqual({
      kind: "needs-you",
      detail: "Usage limit",
    });
  });

  it("is working while a run is in progress", () => {
    expect(
      botStatusFromShell(
        botShell({
          runtime: runtime("running"),
          latestRun: { ...completedRun, status: "running" },
        }),
      ),
    ).toEqual({ kind: "working", detail: "Working" });
  });

  it("needs the user once for a finished run they have not opened", () => {
    const finished = botShell({
      runtime: runtime("completed"),
      latestRun: completedRun,
      lastVisitedAt: "2026-10-20T11:05:00.000Z",
    });
    expect(botStatusFromShell(finished)).toEqual({ kind: "needs-you", detail: "Finished" });
    expect(botStatusFromShell({ ...finished, lastVisitedAt: "2026-10-20T11:20:00.000Z" })).toEqual({
      kind: "idle",
      detail: null,
    });
  });
});

describe("botActivityAt", () => {
  it("prefers the latest run's completion over the thread's last update", () => {
    expect(botActivityAt(null)).toBeNull();
    expect(botActivityAt(botShell())).toBe(NOW);
    expect(botActivityAt(botShell({ latestRun: completedRun }))).toBe(completedRun.completedAt);
  });
});

describe("withoutBotThreads", () => {
  it("drops every generation of bot conversations and keeps ordinary threads in order", () => {
    const threads = [
      botShell({ id: ThreadId.make("thread-a") }),
      botShell({ id: ThreadId.make("bot:writer:1") }),
      botShell({ id: ThreadId.make("bot:writer:2") }),
      botShell({ id: ThreadId.make("thread-b") }),
    ];
    expect(withoutBotThreads(threads).map((thread) => thread.id)).toEqual(["thread-a", "thread-b"]);
  });

  it("keeps ids that only look like bot ids", () => {
    const threads = [
      botShell({ id: ThreadId.make("bot:writer:0") }),
      botShell({ id: ThreadId.make("bot:writer") }),
      botShell({ id: ThreadId.make("robot:writer:1") }),
    ];
    expect(withoutBotThreads(threads)).toBe(threads);
  });
});
