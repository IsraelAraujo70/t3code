/** What a settled turn produced: its structured output and its token cost, or that it was lost. Pure. */
import type { Json } from "effect/Schema";

import type { Intent, NewFact } from "../facts.ts";
import { runStream } from "../facts.ts";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadProjection,
  WorkflowStepCost,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";

const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)```/g;

/** The last ```json block of a reply, decoded; the error says why there is none. */
export const lastJsonBlock = (
  text: string,
): { readonly output: Json; readonly error: string | null } => {
  const blocks = [...text.matchAll(JSON_BLOCK)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return { output: null, error: "the reply has no ```json block" };
  try {
    return { output: JSON.parse(last) as Json, error: null };
  } catch (error) {
    return { output: null, error: `the last json block does not parse: ${String(error)}` };
  }
};

type OrderedRun = Pick<OrchestrationV2Run, "id" | "ordinal">;

/**
 * The runs a step's turn spent: from the run of its message to the run whose reply it consumed,
 * restart continuations and delegated-work follow-ups included. Later runs belong to later steps.
 */
export const stepRuns = <Run extends OrderedRun>(
  runs: ReadonlyArray<Run>,
  first: OrderedRun,
  last: OrderedRun,
): ReadonlyArray<Run> =>
  runs
    .filter((run) => run.ordinal >= first.ordinal && run.ordinal <= last.ordinal)
    .sort((a, b) => a.ordinal - b.ordinal);

/**
 * The reply a step's turn produced: the last run of its chain that replied. A run that completed
 * without assistant text, such as a background-task notification the agent had already answered
 * in an earlier run, does not replace that answer. A failed run still does, with its error.
 */
export const stepReply = (
  thread: Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">,
  first: OrchestrationV2Run,
  last: OrchestrationV2Run,
): { readonly run: OrchestrationV2Run; readonly text: string } => {
  for (const run of stepRuns(thread.runs, first, last).toReversed()) {
    const reply = subagentResultForRun(thread, run);
    if (run.status !== "completed" || reply.messageId !== null) return { run, text: reply.text };
  }
  return { run: last, text: subagentResultForRun(thread, last).text };
};

/**
 * Billable tokens are input without cache reads plus output (input already counts cache reads and
 * writes, output already counts reasoning). Unknown usage is "unavailable", never zero cost.
 */
export const turnCost = (
  chain: ReadonlyArray<Pick<OrchestrationV2Run, "id">>,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "turnTokenUsage">
  >,
): WorkflowStepCost => {
  const runIds = new Set(chain.map((run) => run.id));
  const attemptIds = new Set(attempts.filter((a) => runIds.has(a.runId)).map((a) => a.id));
  const usages = providerTurns
    .filter((turn) => turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId))
    .map((turn) => turn.turnTokenUsage);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let complete = usages.length > 0;
  for (const usage of usages) {
    if (usage === undefined || usage.usageStatus !== "complete") complete = false;
    input += usage?.inputTokens ?? 0;
    output += usage?.outputTokens ?? 0;
    cacheRead += usage?.cachedInputTokens ?? 0;
  }
  const known = usages.some((usage) => usage?.inputTokens !== undefined);
  return {
    billable: Math.max(0, input - cacheRead) + output,
    input,
    output,
    cacheRead,
    usage: complete ? "complete" : known ? "partial" : "unavailable",
    usdEstimate: null,
  };
};

/**
 * A turn settled without its run's outcome. `lost` (status cancelled) is replayed by the engine, so
 * it is only for a turn that never ran (no run for its message); `unknown` pauses the run for Israel,
 * because the original may still be running.
 */
export const unobservedTurn = (
  runId: string,
  intent: Extract<Intent, { readonly _tag: "StartTurn" }>,
  outcome: "lost" | "unknown",
  text: string,
): NewFact => ({
  stream: runStream(runId),
  key: `settled:${intent.step}@${intent.attempt}${intent.key.startsWith("nudge:") ? ":nudge" : ""}`,
  fact: {
    _tag: "TurnSettled",
    step: intent.step,
    attempt: intent.attempt,
    status: outcome === "lost" ? "cancelled" : "failed",
    text,
    output: null,
    outputError: null,
    cost: {
      billable: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      usage: "unavailable",
      usdEstimate: null,
    },
    headSha: null,
    ...(outcome === "unknown" ? { unobserved: true } : {}),
  },
});
