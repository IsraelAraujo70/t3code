/**
 * Wakes a watcher thread when a thread it watches ends a run or waits on a request, the way
 * DelegatedTaskQuestionReactor wakes the parent of a delegated task. Messages queue behind the
 * watcher's active turn, and a stable command id keeps each change to one wake.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  THREAD_WATCH_MESSAGE_PREFIX,
  threadWatchNotice,
  type ThreadWatchNotice,
  type WatchedChange,
} from "./threadWatchNotice.ts";
import { type ThreadWatch, ThreadWatchStore } from "./ThreadWatchStore.ts";

export class ThreadWatchReactor extends Context.Service<
  ThreadWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/bots/threadWatch/ThreadWatchReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* ThreadWatchStore;

  const messageIdOf = (notice: ThreadWatchNotice) =>
    MessageId.make(`${THREAD_WATCH_MESSAGE_PREFIX}${notice.key}`);

  const wake = Effect.fnUntraced(function* (watch: ThreadWatch, notice: ThreadWatchNotice) {
    const watcher = yield* projections.getThread(watch.watcherThreadId);
    // A deleted watcher can never be woken again; an archived one may come back.
    if (watcher.deletedAt !== null) {
      yield* store.unwatch(watch.watcherThreadId, watch.targetThreadId);
      return;
    }
    if (watcher.archivedAt !== null) return;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:thread-watch:${notice.key}`),
      threadId: watch.watcherThreadId,
      messageId: messageIdOf(notice),
      text: notice.text,
      notification: notice.notification,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  /** A request answered before its wake ran needs no wake. */
  const withdraw = Effect.fnUntraced(function* (watch: ThreadWatch, requestId: string) {
    const messageId = MessageId.make(
      `${THREAD_WATCH_MESSAGE_PREFIX}${watch.watcherThreadId}:${watch.targetThreadId}:${requestId}`,
    );
    const { runs } = yield* projections.getThreadRecords(watch.watcherThreadId, ["runs"]);
    const queued = runs.find((run) => run.status === "queued" && run.userMessageId === messageId);
    if (queued === undefined) return;
    yield* engine.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(`server:thread-watch-cancel:${messageId}`),
      threadId: watch.watcherThreadId,
      runId: queued.id,
    });
  });

  const notify = Effect.fnUntraced(function* (target: ThreadId, change: WatchedChange) {
    const watches = yield* store.watchersOf(target);
    if (watches.length === 0) return;
    const thread = yield* projections.getThread(target);
    for (const watch of watches) {
      const notice = threadWatchNotice(watch, thread.title, change);
      const step =
        notice !== null
          ? wake(watch, notice)
          : change.type === "request"
            ? withdraw(watch, change.request.id)
            : Effect.void;
      yield* step.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking a thread watcher failed", {
            watcherThreadId: watch.watcherThreadId,
            targetThreadId: target,
            cause,
          }),
        ),
      );
    }
  });

  const handle: ThreadWatchReactor["Service"]["handle"] = Effect.fn("ThreadWatchReactor.handle")(
    function* (event) {
      if (event.type === "run.updated") {
        yield* notify(event.threadId, { type: "run", run: event.payload });
        return;
      }
      if (event.type !== "runtime-request.updated") return;
      // Read the stored request: the event may be older than an answer already recorded.
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      yield* notify(event.threadId, { type: "request", request: request ?? event.payload });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("handling a watched thread event failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  /** Changes that landed while the server was down; replays are no-ops by command id. */
  const catchUp = Effect.gen(function* () {
    for (const watch of yield* store.list) {
      yield* Effect.gen(function* () {
        const { thread, runs, runtimeRequests } = yield* projections.getThreadRecords(
          watch.targetThreadId,
          ["runs", "runtimeRequests"],
        );
        const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
        const changes: Array<WatchedChange> = [
          ...(latest === undefined ? [] : [{ type: "run" as const, run: latest }]),
          ...runtimeRequests
            .filter((request) => request.status === "pending")
            .map((request) => ({ type: "request" as const, request })),
        ];
        for (const change of changes) {
          const notice = threadWatchNotice(watch, thread.title, change);
          if (notice !== null) yield* wake(watch, notice);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("catching up a thread watch failed", {
            watcherThreadId: watch.watcherThreadId,
            targetThreadId: watch.targetThreadId,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("catching up thread watches failed", { cause })),
  );

  const start: ThreadWatchReactor["Service"]["start"] = () =>
    // Catching up alongside the live stream leaves no gap; a change seen by both wakes once.
    forkParked(
      Effect.all(
        [
          Stream.runForEach(engine.streamDomainEvents, handle).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("thread watch event stream failed", { cause }),
            ),
          ),
          catchUp,
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return { start, handle } satisfies ThreadWatchReactor["Service"];
});

const layer = Layer.effect(ThreadWatchReactor, make);

/** Starts the reactor with the server. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* ThreadWatchReactor;
    yield* reactor.start();
  }),
).pipe(Layer.provide(layer), Layer.provide(ProjectionStore.layer));
