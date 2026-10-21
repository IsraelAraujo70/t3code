import {
  BotId,
  BotSectionId,
  botThreadId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type BotDirectoryEntry,
  type BotSection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyArrangement,
  botActivityAt,
  botStatusFromShell,
  countBotsNeedingYou,
  currentArrangement,
  groupBotRows,
  moveBot,
  moveSection,
  resolveBotRows,
  type BotRowModel,
  type BotStatus,
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
    settledOverride: null,
    ...overrides,
  };
}

function bot(id: string, generation = 1, sectionId: string | null = null): BotDirectoryEntry {
  const botId = BotId.make(id);
  return {
    id: botId,
    name: id,
    sectionId: sectionId === null ? null : BotSectionId.make(sectionId),
    role: "",
    model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    homeGeneration: generation,
    position: 0,
    canManageBots: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    homeThreadId: botThreadId(botId, generation),
    memories: [],
  };
}

function section(id: string): BotSection {
  return {
    id: BotSectionId.make(id),
    name: id,
    position: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const request: BotStatus = { kind: "needs-you", attention: "request" };
const quiet: BotStatus = { kind: "needs-you", attention: null };

describe("botStatusFromShell", () => {
  it("needs nothing from a missing or unloaded thread", () => {
    expect(botStatusFromShell(null)).toEqual(quiet);
    expect(botStatusFromShell(shell())).toEqual(quiet);
  });

  it("puts approvals, questions, and failures ahead of the running turn", () => {
    expect(botStatusFromShell(shell({ hasPendingApprovals: true, runtime }))).toEqual(request);
    expect(botStatusFromShell(shell({ pendingSubagentRequest: "user_input" }))).toEqual(request);
    const failed = { ...runtime, status: "failed" as const, activeRunId: null, lastError: "boom" };
    expect(botStatusFromShell(shell({ runtime: failed }))).toEqual(request);
  });

  it("reports running and background-waiting turns as working, even when settled", () => {
    expect(botStatusFromShell(shell({ runtime, settledOverride: "settled" }))).toEqual({
      kind: "working",
    });
    expect(
      botStatusFromShell(shell({ runtime: { ...runtime, status: "idle", activeRunId: null } })),
    ).toEqual({ kind: "working" });
  });

  it("keeps a settled conversation settled once it rests", () => {
    expect(
      botStatusFromShell(
        shell({
          settledOverride: "settled",
          latestRun: completedRun,
          lastVisitedAt: "2026-10-19T09:59:00.000Z",
        }),
      ),
    ).toEqual({ kind: "settled" });
  });

  it("marks an unseen finished run, and rests once the user saw it", () => {
    expect(
      botStatusFromShell(
        shell({ latestRun: completedRun, lastVisitedAt: "2026-10-19T09:59:00.000Z" }),
      ),
    ).toEqual({ kind: "needs-you", attention: "unseen" });
    expect(
      botStatusFromShell(
        shell({ latestRun: completedRun, lastVisitedAt: "2026-10-19T10:05:00.000Z" }),
      ),
    ).toEqual(quiet);
  });
});

describe("countBotsNeedingYou", () => {
  it("counts only bots with something new for the user", () => {
    expect(
      countBotsNeedingYou([
        request,
        { kind: "working" },
        { kind: "settled" },
        quiet,
        { kind: "needs-you", attention: "unseen" },
      ]),
    ).toBe(2);
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
    expect(rows[0]!.status).toEqual({ kind: "working" });
    expect(rows[0]!.preview).toBe("Working…");
    expect(rows[1]!.status).toEqual(quiet);
    expect(rows[1]!.activityAt).toBeNull();
  });

  it("says what the bot waits on or does under its name", () => {
    const only = bot("b_1");
    const preview = (overrides: Partial<BotThreadShell>) =>
      resolveBotRows([only], environmentId, [shell({ id: only.homeThreadId, ...overrides })])[0]!
        .preview;
    expect(preview({ hasPendingUserInput: true })).toBe("Waiting for your answer");
    expect(preview({ latestRun: completedRun, lastVisitedAt: "2026-10-19T09:59:00.000Z" })).toBe(
      "New reply",
    );
    expect(preview({ settledOverride: "settled" })).toBe("Settled");
    expect(preview({})).toBeNull();
  });
});

function row(id: string, sectionId: string | null, status: BotStatus): BotRowModel {
  const entry = bot(id, 1, sectionId);
  return {
    bot: entry,
    threadRef: { environmentId, threadId: entry.homeThreadId },
    status,
    preview: null,
    activityAt: null,
  };
}

describe("groupBotRows", () => {
  it("lists sections in order, then unsorted bots, each by status then the user's order", () => {
    const groups = groupBotRows(
      [section("s_work"), section("s_home")],
      [
        row("settled", "s_work", { kind: "settled" }),
        row("busy", "s_work", { kind: "working" }),
        row("asks", "s_work", request),
        row("calm", "s_work", quiet),
        row("loose", null, quiet),
        // A section deleted on another device: the bot shows in the default list.
        row("orphan", "s_gone", { kind: "settled" }),
      ],
    );
    expect(groups.map((group) => group.section?.id ?? null)).toEqual(["s_work", "s_home", null]);
    expect(groups[0]!.rows.map((r) => r.bot.id)).toEqual(["asks", "calm", "busy", "settled"]);
    expect(groups[1]!.rows).toEqual([]);
    expect(groups[2]!.rows.map((r) => r.bot.id)).toEqual(["loose", "orphan"]);
  });

  it("drops an empty default list once sections exist, but keeps it when there are none", () => {
    expect(groupBotRows([section("s_a")], [row("a", "s_a", quiet)])).toHaveLength(1);
    expect(groupBotRows([], [])).toEqual([{ section: null, rows: [] }]);
  });
});

describe("arranging", () => {
  const sections = [section("s_a"), section("s_b")];
  const bots = [bot("b_1", 1, "s_a"), bot("b_2", 1, "s_a"), bot("b_3"), bot("b_4", 1, "s_b")];
  const start = currentArrangement(sections, bots);
  const order = (arrangement: typeof start) =>
    arrangement.bots.map((b) => `${b.botId}@${b.sectionId ?? "-"}`);

  it("moves a bot before another one in a section", () => {
    expect(
      order(moveBot(start, BotId.make("b_2"), BotSectionId.make("s_a"), BotId.make("b_1"))),
    ).toEqual(["b_2@s_a", "b_1@s_a", "b_3@-", "b_4@s_b"]);
  });

  it("moves a bot to the end of another section, or out of every section", () => {
    expect(order(moveBot(start, BotId.make("b_1"), BotSectionId.make("s_b"), null))).toEqual([
      "b_2@s_a",
      "b_3@-",
      "b_4@s_b",
      "b_1@s_b",
    ]);
    expect(order(moveBot(start, BotId.make("b_4"), null, null))).toEqual([
      "b_1@s_a",
      "b_2@s_a",
      "b_3@-",
      "b_4@-",
    ]);
  });

  it("reorders sections", () => {
    expect(
      moveSection(start, BotSectionId.make("s_b"), BotSectionId.make("s_a")).sectionIds,
    ).toEqual(["s_b", "s_a"]);
  });

  it("shows a pending arrangement, and ignores one that no longer fits the directory", () => {
    const moved = moveBot(start, BotId.make("b_3"), BotSectionId.make("s_b"), BotId.make("b_4"));
    const shown = applyArrangement(sections, bots, moved);
    expect(shown.bots.map((b) => `${b.id}@${b.sectionId ?? "-"}`)).toEqual(order(moved));
    expect(applyArrangement(sections, bots.slice(1), moved).bots).toHaveLength(3);
  });
});
