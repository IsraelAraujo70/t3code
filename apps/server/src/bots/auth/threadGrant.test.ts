import { AuthThreadGrant, ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  threadGrantAllows,
  threadGrantAllowsHttpRequest,
  threadGrantRpcDenial,
} from "./threadGrant.ts";

const grant = Schema.decodeUnknownSync(AuthThreadGrant);
const SIDE = "bot:b_fin:t-a964d5bc484f4373";
const exact = grant(SIDE);
const wildcard = grant("bot:b_fin:*");

const dispatch = (overrides: Record<string, unknown> = {}) => ({
  type: "message.dispatch",
  commandId: "cmd-1",
  threadId: SIDE,
  messageId: "msg-1",
  text: "oi",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
  createdBy: "user",
  creationSource: "server",
  ...overrides,
});

describe("AuthThreadGrant", () => {
  it.each([SIDE, "bot:b_fin:3", "thread-123", "bot:b_fin:*"])("accepts %s", (value) => {
    expect(grant(value)).toBe(value);
  });

  it.each(["", " bot:b_fin:3", "*", "bot:*", "bot:b_fin:t-*", "thread-*", "bot:b fin:*", "a:*"])(
    "rejects %j",
    (value) => {
      expect(() => grant(value)).toThrow();
    },
  );
});

describe("threadGrantAllows", () => {
  it("matches an exact grant only to that thread", () => {
    expect(threadGrantAllows(exact, SIDE)).toBe(true);
    expect(threadGrantAllows(exact, "bot:b_fin:1")).toBe(false);
    expect(threadGrantAllows(exact, `${SIDE}x`)).toBe(false);
    expect(threadGrantAllows(exact, undefined)).toBe(false);
  });

  it("matches bot:<id>:* to that bot's generations and side threads only", () => {
    expect(threadGrantAllows(wildcard, "bot:b_fin:1")).toBe(true);
    expect(threadGrantAllows(wildcard, "bot:b_fin:42")).toBe(true);
    expect(threadGrantAllows(wildcard, SIDE)).toBe(true);
    for (const other of [
      "bot:b_finx:1",
      "bot:b_fi:1",
      "bot:b_finx:t-a964d5bc484f4373",
      "bot:other:1",
      "bot:b_fin:*",
      "bot:b_fin:0",
      "bot:b_fin:t-",
      "bot:b_fin:1:x",
      "xbot:b_fin:1",
      "thread-1",
    ]) {
      expect(threadGrantAllows(wildcard, other)).toBe(false);
    }
  });
});

describe("threadGrantRpcDenial", () => {
  it.each([
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    ORCHESTRATION_V2_WS_METHODS.subscribeShell,
    ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
    ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
    WS_METHODS.projectsMutate,
    WS_METHODS.subscribeServerConfig,
    WS_METHODS.subscribeServerLifecycle,
    "bots.thread.open",
    "toString",
  ])("denies %s even for the granted thread", (method) => {
    expect(threadGrantRpcDenial(exact, method, { threadId: SIDE })).toContain("not available");
  });

  it("allows the relay's calls on the granted thread", () => {
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, dispatch()),
    ).toBeUndefined();
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
        threadId: SIDE,
        afterSequence: 4,
        acceptCompactIds: true,
      }),
    ).toBeUndefined();
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
        threadId: SIDE,
      }),
    ).toBeUndefined();
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
        threadId: SIDE,
        itemId: "item-1",
      }),
    ).toBeUndefined();
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "run.interrupt",
        commandId: "cmd-2",
        threadId: SIDE,
        runId: "run-1",
        reason: "relay",
      }),
    ).toBeUndefined();
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "run.interrupt",
        commandId: "cmd-2",
        threadId: SIDE,
        runId: "run-1",
        holdQueue: true,
      }),
    ).toBe("field holdQueue is not allowed on run.interrupt");
  });

  it("denies every allowed method on another thread", () => {
    for (const [method, payload] of [
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand, dispatch({ threadId: "bot:b_fin:1" })],
      [ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId: "bot:b_fin:1" }],
      [ORCHESTRATION_V2_WS_METHODS.getThreadProjection, { threadId: "other" }],
      [ORCHESTRATION_V2_WS_METHODS.getTurnItem, { threadId: "other", itemId: "item-1" }],
      [ORCHESTRATION_V2_WS_METHODS.subscribeThread, {}],
      [ORCHESTRATION_V2_WS_METHODS.subscribeThread, null],
    ] as const) {
      expect(threadGrantRpcDenial(exact, method, payload)).toBeDefined();
    }
    expect(
      threadGrantRpcDenial(
        wildcard,
        ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        dispatch({ threadId: "bot:b_finx:1" }),
      ),
    ).toBe("thread is outside this session's grant");
  });

  it.each([
    "thread.create",
    "thread.fork",
    "thread.delete",
    "thread.model-selection.set",
    "thread.runtime-mode.set",
    "runtime-request.respond",
    "queue.resume",
    "subagent.stop",
  ])("denies command %s on the granted thread", (type) => {
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type,
        commandId: "cmd-3",
        threadId: SIDE,
      }),
    ).toBe(`command ${type} is not allowed`);
  });

  it.each([
    { senderThreadId: "other" },
    { sourcePlanRef: { threadId: "other", planId: "plan-1" } },
    { guestMessageId: "guest-1" },
    { scheduledTaskId: "task-1" },
    { modelSelection: { instanceId: "codex", model: "gpt" } },
    { context: { version: 1, records: [] } },
    { delegatedCompletion: { parentRunId: "run-1", generation: 1, taskIds: [] } },
    { notification: {} },
    { titleSeed: "a title" },
    { text: "/compact" },
    { text: " /LOGOUT " },
    { attachments: [{ type: "image", id: "att-1" }] },
    { dispatchMode: { type: "defer_start", workspaceStrategy: { type: "worktree" } } },
    { dispatchMode: { type: "steer_active", targetRunId: "run-1" } },
    { dispatchMode: { type: "queue_after_active", extra: 1 } },
  ])("denies message.dispatch with %j", (overrides) => {
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.dispatchCommand, dispatch(overrides)),
    ).toBeDefined();
  });

  it("denies unlisted fields on read methods", () => {
    expect(
      threadGrantRpcDenial(exact, ORCHESTRATION_V2_WS_METHODS.getThreadProjection, {
        threadId: SIDE,
        parentThreadId: "other",
      }),
    ).toBe(
      `field parentThreadId is not allowed on ${ORCHESTRATION_V2_WS_METHODS.getThreadProjection}`,
    );
  });
});

describe("threadGrantAllowsHttpRequest", () => {
  it("allows only minting the RPC socket ticket", () => {
    expect(threadGrantAllowsHttpRequest("POST", "/api/auth/websocket-ticket")).toBe(true);
    expect(threadGrantAllowsHttpRequest("POST", "/api/auth/websocket-ticket/rpc")).toBe(true);
    expect(threadGrantAllowsHttpRequest("POST", "/api/auth/websocket-ticket/media")).toBe(false);
    expect(threadGrantAllowsHttpRequest("GET", "/api/auth/websocket-ticket")).toBe(false);
    expect(threadGrantAllowsHttpRequest("POST", "/api/auth/pairing-credential")).toBe(false);
    expect(threadGrantAllowsHttpRequest("POST", "/api/attachments")).toBe(false);
  });
});
