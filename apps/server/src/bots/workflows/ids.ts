// @effect-diagnostics nodeBuiltinImport:off - ids are pure functions of keys, so the hash is synchronous.
/** Ids derived from journal keys, so a replayed intent reaches the same upstream receipt. */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  type ThreadId,
  WorkflowRunId,
  workflowStepThreadId,
} from "@t3tools/contracts";

const sha256Hex = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The run a trigger occurrence creates: the same occurrence always names the same run. */
export const runIdFor = (workflowId: string, occurrence: string): WorkflowRunId =>
  WorkflowRunId.make(`wfr_${sha256Hex(`${workflowId}\u0000${occurrence}`).slice(0, 20)}`);

/** 32 lowercase hex characters of an intent's run-scoped key. */
export const keyHash = (runId: string, key: string): string =>
  sha256Hex(`${runId}\u0000${key}`).slice(0, 32);

/** The thread of a step's turn: `wf:<runId>:<keyHash>`. */
export const stepThreadId = (runId: string, key: string): ThreadId =>
  workflowStepThreadId(runId, keyHash(runId, key));

export const commandIdFor = (runId: string, key: string): CommandId =>
  CommandId.make(`wf:${keyHash(runId, key)}`);

/** Passed to launch and send: upstream's fallback message id is random, so a retry would differ. */
export const messageIdFor = (runId: string, key: string): MessageId =>
  MessageId.make(`wf:${keyHash(runId, key)}:message`);
