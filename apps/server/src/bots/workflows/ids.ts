// @effect-diagnostics nodeBuiltinImport:off - ids are pure functions of keys, so the hash is synchronous.
/** Ids derived from journal keys, so a replayed intent reaches the same upstream receipt. */
import * as NodeCrypto from "node:crypto";

import { CommandId, MessageId, ThreadId, WorkflowRunId } from "@t3tools/contracts";

const sha256Hex = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The run a trigger occurrence creates: the same occurrence always names the same run. */
export const runIdFor = (workflowId: string, occurrence: string): WorkflowRunId =>
  WorkflowRunId.make(`wfr_${sha256Hex(`${workflowId}\u0000${occurrence}`).slice(0, 20)}`);

/** 32 lowercase hex characters of an intent's run-scoped key. */
export const keyHash = (runId: string, key: string): string =>
  sha256Hex(`${runId}\u0000${key}`).slice(0, 32);

// The workflow-threads front owns `workflowStepThreadId` in packages/contracts/src/workflowThreads.ts
// with this exact format; this local copy is swapped for that import when the fronts merge.
const STEP_THREAD_ID = /^wf:wfr_[a-f0-9]{20}:[a-f0-9]{16,64}$/;
const workflowStepThreadId = (runId: string, hash: string): ThreadId => {
  const id = `wf:${runId}:${hash}`;
  if (!STEP_THREAD_ID.test(id)) throw new Error(`not a workflow step thread id: ${id}`);
  return ThreadId.make(id);
};

/** The thread of a step's turn: `wf:<runId>:<keyHash>`. */
export const stepThreadId = (runId: string, key: string): ThreadId =>
  workflowStepThreadId(runId, keyHash(runId, key));

export const commandIdFor = (runId: string, key: string): CommandId =>
  CommandId.make(`wf:${keyHash(runId, key)}`);

/** Passed to launch and send: upstream's fallback message id is random, so a retry would differ. */
export const messageIdFor = (runId: string, key: string): MessageId =>
  MessageId.make(`wf:${keyHash(runId, key)}:message`);
