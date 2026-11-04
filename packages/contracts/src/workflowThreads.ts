/**
 * A workflow step runs as an ordinary T3 thread whose id is `wf:<runId>:<keyHash>`. Step threads
 * stay out of every normal thread list, search and per-thread notification; they open by direct
 * link and from the Workflows view.
 *
 * @module workflowThreads
 */
import { ThreadId } from "./baseSchemas.ts";

export const WORKFLOW_STEP_THREAD_PREFIX = "wf:";

/** Opens the id of every message a workflow posts in its bot's conversation (`postToBot`). */
export const WORKFLOW_POST_MESSAGE_PREFIX = "message:workflow-post:";

const WORKFLOW_STEP_THREAD_ID = /^wf:(wfr_[0-9a-f]{20}):([0-9a-f]{16,64})$/;

/** True for any `wf:` id; use `parseWorkflowStepThreadId` when the parts matter. */
export function isWorkflowStepThreadId(threadId: string): boolean {
  return threadId.startsWith(WORKFLOW_STEP_THREAD_PREFIX);
}

/** The run and step key of a well-formed step thread id; null for anything else. */
export function parseWorkflowStepThreadId(
  threadId: string,
): { readonly runId: string; readonly keyHash: string } | null {
  const match = WORKFLOW_STEP_THREAD_ID.exec(threadId);
  return match === null ? null : { runId: match[1]!, keyHash: match[2]! };
}

/** Inverse of `parseWorkflowStepThreadId`; callers pass a `wfr_` run id and a hex key hash. */
export function workflowStepThreadId(runId: string, keyHash: string): ThreadId {
  return ThreadId.make(`${WORKFLOW_STEP_THREAD_PREFIX}${runId}:${keyHash}`);
}

/**
 * A visible step thread (`thread: { visible: true }`): `wfi:<runId>:<keyHash>`. Unlike `wf:` it is
 * listed like any thread, so the user can follow and steer it; the prefix only names its run.
 */
export const WORKFLOW_ITEM_THREAD_PREFIX = "wfi:";

const WORKFLOW_ITEM_THREAD_ID = /^wfi:(wfr_[0-9a-f]{20}):([0-9a-f]{16,64})$/;

export function workflowItemThreadId(runId: string, keyHash: string): ThreadId {
  return ThreadId.make(`${WORKFLOW_ITEM_THREAD_PREFIX}${runId}:${keyHash}`);
}

/** The run of a well-formed visible step thread id; null for anything else. */
export function parseWorkflowItemThreadId(
  threadId: string,
): { readonly runId: string; readonly keyHash: string } | null {
  const match = WORKFLOW_ITEM_THREAD_ID.exec(threadId);
  return match === null ? null : { runId: match[1]!, keyHash: match[2]! };
}

/**
 * A step thread or a subagent or side chat inside one. A user's fork of a step thread keeps the
 * step as its root but is the user's own thread, so it stays listed.
 */
export function isWorkflowStepLineage(lineage: {
  readonly relationshipToParent: string | null;
  readonly rootThreadId: string;
}): boolean {
  return lineage.relationshipToParent !== "fork" && isWorkflowStepThreadId(lineage.rootThreadId);
}
