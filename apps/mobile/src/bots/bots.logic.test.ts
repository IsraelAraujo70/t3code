import { groupBotRows, resolveBotRows } from "@t3tools/client-runtime/bot-directory";
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
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../test-fixtures";
import {
  botsTabGroups,
  toggleCollapsedKey,
  withoutBotThreads,
  workspaceTabForThread,
} from "./bots.logic";

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

describe("workspaceTabForThread", () => {
  it("sends bot conversations to the Bots tab and everything else to Chats", () => {
    expect(workspaceTabForThread("bot:writer:3")).toBe("bots");
    expect(workspaceTabForThread("thread-a")).toBe("threads");
    expect(workspaceTabForThread("robot:writer:1")).toBe("threads");
  });
});

function bot(id: string, sectionId: string | null): BotDirectoryEntry {
  const botId = BotId.make(id);
  return {
    id: botId,
    name: id,
    sectionId: sectionId === null ? null : BotSectionId.make(sectionId),
    role: "",
    model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    homeGeneration: 1,
    position: 0,
    canManageBots: false,
    rotation: "daily",
    createdAt: NOW,
    updatedAt: NOW,
    homeThreadId: botThreadId(botId, 1),
    memories: [],
  };
}

function section(id: string, name: string): BotSection {
  return { id: BotSectionId.make(id), name, position: 0, createdAt: NOW, updatedAt: NOW };
}

describe("botsTabGroups", () => {
  const casa = section("s_casa", "Casa");
  const codigo = section("s_codigo", "Codigo");
  const bots = [
    bot("secretario", "s_casa"),
    bot("linkedin", null),
    bot("father", "s_codigo"),
    bot("reviewer", "s_codigo"),
  ];
  const shells = [
    // The reviewer is working, so it leads its section; the father's reply is unread.
    botShell({ id: bots[3]!.homeThreadId, runtime: runtime("running") }),
    botShell({
      id: bots[2]!.homeThreadId,
      latestRun: completedRun,
      lastVisitedAt: "2026-10-20T11:05:00.000Z",
    }),
    botShell({ id: bots[0]!.homeThreadId, settledOverride: "settled" }),
  ];
  const rows = resolveBotRows(bots, environmentId, shells);

  it("shows the sidebar's sections, order and status from the phone's thread shells", () => {
    const groups = botsTabGroups(groupBotRows([codigo, casa], rows), []);
    expect(groups.map((group) => [group.title, group.rows.map((row) => row.bot.id)])).toEqual([
      ["Codigo", ["father", "reviewer"]],
      ["Casa", ["secretario"]],
      ["Bots", ["linkedin"]],
    ]);
    const codigoRows = groups[0]!.rows;
    expect(codigoRows.map((row) => row.preview)).toEqual(["New reply", "Working…"]);
    expect(groups[1]!.rows[0]!.status).toEqual({ kind: "settled" });
  });

  it("folds the sections the user folded, keyed by section id or the default list", () => {
    const groups = botsTabGroups(groupBotRows([codigo, casa], rows), ["s_casa", "default"]);
    expect(groups.map((group) => [group.key, group.collapsed])).toEqual([
      ["s_codigo", false],
      ["s_casa", true],
      ["default", true],
    ]);
  });

  it("shows no headers and folds nothing without sections, like the sidebar", () => {
    const groups = botsTabGroups(groupBotRows([], rows), ["default"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBeNull();
    expect(groups[0]!.collapsed).toBe(false);
    expect(groups[0]!.rows).toHaveLength(4);
  });
});

describe("toggleCollapsedKey", () => {
  it("folds an open section and opens a folded one", () => {
    expect(toggleCollapsedKey([], "s_casa")).toEqual(["s_casa"]);
    expect(toggleCollapsedKey(["default", "s_casa"], "s_casa")).toEqual(["default"]);
  });
});
