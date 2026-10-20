import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";

import { THREAD_WATCH_MESSAGE_PREFIX, threadWatchNotice } from "./threadWatchNotice.ts";
import { type ThreadWatch, ThreadWatchStore, layerMemory } from "./ThreadWatchStore.ts";

const watcher = ThreadId.make("bot:b_watcher:1");
const target = ThreadId.make("mcp:target");
const watch: ThreadWatch = {
  watcherThreadId: watcher,
  targetThreadId: target,
  createdAt: "2026-10-20T12:00:00.000Z",
};

const at = (iso: string) => DateTime.makeUnsafe(iso);

const run = (overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: RunId.make("run-1"),
  threadId: target,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  providerThreadId: null,
  userMessageId: MessageId.make("message:user-1"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: at("2026-10-20T12:01:00.000Z"),
  startedAt: at("2026-10-20T12:01:00.000Z"),
  completedAt: at("2026-10-20T12:05:00.000Z"),
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

const request = (
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("request-1"),
  nodeId: NodeId.make("node-1"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input",
  status: "pending",
  responseCapability: { type: "message" },
  createdAt: at("2026-10-20T12:02:00.000Z"),
  resolvedAt: null,
  ...overrides,
});

describe("threadWatchNotice", () => {
  it("wakes the watcher once per ended run, naming the thread and its outcome", () => {
    const notice = threadWatchNotice(watch, "Refactor billing", { type: "run", run: run() });
    assert.isNotNull(notice);
    assert.strictEqual(notice!.key, `${watcher}:${target}:run-1:completed`);
    assert.strictEqual(notice!.notification.outcome, "completed");
    assert.include(notice!.text, `t3_thread_read using threadId ${target}`);
    assert.include(notice!.text, `t3-thread://v1/${target}`);
    assert.strictEqual(notice!.notification.summary, `Watched thread "Refactor billing" completed`);

    const failed = threadWatchNotice(watch, null, { type: "run", run: run({ status: "failed" }) });
    assert.strictEqual(failed!.notification.outcome, "failed");
    assert.notStrictEqual(failed!.key, notice!.key);
  });

  it("stays quiet for runs still going, runs that ended before the watch, and self-watches", () => {
    const going = run({ status: "running", completedAt: null });
    assert.isNull(threadWatchNotice(watch, null, { type: "run", run: going }));
    const before = run({ completedAt: at("2026-10-20T11:59:59.000Z") });
    assert.isNull(threadWatchNotice(watch, null, { type: "run", run: before }));
    const self = { ...watch, targetThreadId: watcher };
    assert.isNull(threadWatchNotice(self, null, { type: "run", run: run() }));
  });

  it("never wakes anyone for a run a wake started, so mutual watches cannot loop", () => {
    const woken = run({ userMessageId: MessageId.make(`${THREAD_WATCH_MESSAGE_PREFIX}x:y:run-0`) });
    assert.isNull(threadWatchNotice(watch, null, { type: "run", run: woken }));
  });

  it("wakes for a pending question or approval and not once it is answered", () => {
    const question = threadWatchNotice(watch, null, { type: "request", request: request() });
    assert.strictEqual(question!.key, `${watcher}:${target}:request-1`);
    assert.include(question!.text, "waiting for an answer");
    assert.include(question!.text, "requestId request-1");

    const approval = threadWatchNotice(watch, null, {
      type: "request",
      request: request({ kind: "command" }),
    });
    assert.include(approval!.text, "waiting for approval");

    const answered = request({ status: "resolved", resolvedAt: at("2026-10-20T12:03:00.000Z") });
    assert.isNull(threadWatchNotice(watch, null, { type: "request", request: answered }));
    const toolCall = request({ kind: "dynamic_tool_call" });
    assert.isNull(threadWatchNotice(watch, null, { type: "request", request: toolCall }));
  });
});

describe("ThreadWatchStore", () => {
  it.effect("keeps one watch per pair with its first start time, until unwatched", () =>
    Effect.gen(function* () {
      const store = yield* ThreadWatchStore;
      yield* store.watch(watch);
      yield* store.watch({ ...watch, createdAt: "2026-10-20T13:00:00.000Z" });
      const other = ThreadId.make("bot:b_other:1");
      yield* store.watch({ ...watch, watcherThreadId: other });

      const watchers = yield* store.watchersOf(target);
      assert.deepStrictEqual(
        watchers.map((entry) => [entry.watcherThreadId, entry.createdAt]),
        [
          [watcher, "2026-10-20T12:00:00.000Z"],
          [other, "2026-10-20T12:00:00.000Z"],
        ],
      );
      assert.isTrue(yield* store.unwatch(watcher, target));
      assert.isFalse(yield* store.unwatch(watcher, target));
      assert.deepStrictEqual(
        (yield* store.list).map((entry) => entry.watcherThreadId),
        [other],
      );
    }).pipe(Effect.provide(layerMemory)),
  );
});
