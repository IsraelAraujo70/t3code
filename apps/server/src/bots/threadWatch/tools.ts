import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { ThreadWatchStore } from "./ThreadWatchStore.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadWatchStore,
  ],
};

const Target = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread to watch, in this environment." }),
});

const WatchResult = Schema.Struct({
  threadId: ThreadId,
  watching: Schema.Boolean,
  /** True when the target has a run going right now. */
  running: Schema.Boolean,
});

const WatchThreadTool = Tool.make("watch_thread", {
  ...shared,
  description:
    "Have T3 Code wake this thread when another thread needs you: when one of its runs ends (completed, failed, cancelled, or interrupted), and when it waits on a question or an approval. Use it after t3_thread_launch or t3_thread_send instead of polling with t3_thread_wait, then end your turn; the wake arrives as a message in this thread, queued behind any turn you are in. Runs that ended before this call do not wake you, so check the thread's current state yourself first. Watching lasts until you call unwatch_thread, so a thread that runs again wakes you again.",
  parameters: Target,
  success: WatchResult,
})
  .annotate(Tool.Title, "Watch thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnwatchThreadTool = Tool.make("unwatch_thread", {
  ...shared,
  description:
    "Stop T3 Code from waking this thread for a thread it watches. Call it once the watched work is done and reported.",
  parameters: Target,
  success: WatchResult,
})
  .annotate(Tool.Title, "Stop watching thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadWatchToolkit = Toolkit.make(WatchThreadTool, UnwatchThreadTool);
