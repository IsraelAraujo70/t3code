import { type BotsError, OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadWatchStore } from "./ThreadWatchStore.ts";
import { ThreadWatchToolkit } from "./tools.ts";

const storeFailure = (error: BotsError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * The calling thread and the live thread it names. The watcher always comes from the trusted
 * caller scope, so one thread cannot make another one watch.
 */
const resolve = Effect.fnUntraced(function* (targetThreadId: ThreadId) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Watching a thread");
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const target = yield* threads
    .getThreadShell(targetThreadId)
    .pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Could not read threads.",
          }),
      ),
    );
  if (target === null || target.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `There is no thread ${targetThreadId} in this environment.`,
    });
  }
  if (target.id === caller.thread.threadId) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "A thread cannot watch itself.",
    });
  }
  return { watcherThreadId: caller.thread.threadId, target };
});

export const layer = McpToolAccess.toLayer(ThreadWatchToolkit, {
  watch_thread: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { watcherThreadId, target } = yield* resolve(input.threadId);
      const store = yield* ThreadWatchStore;
      const now = yield* DateTime.now;
      yield* store
        .watch({ watcherThreadId, targetThreadId: target.id, createdAt: DateTime.formatIso(now) })
        .pipe(Effect.mapError(storeFailure));
      return { threadId: target.id, watching: true, running: target.activeRunId !== null };
    }),
  ),
  unwatch_thread: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { watcherThreadId, target } = yield* resolve(input.threadId);
      const store = yield* ThreadWatchStore;
      yield* store.unwatch(watcherThreadId, target.id).pipe(Effect.mapError(storeFailure));
      return { threadId: target.id, watching: false, running: target.activeRunId !== null };
    }),
  ),
});
