/**
 * The workflow decider (§3.2): turns each pending TriggerFired into a run, a skip, or a wait.
 * Pure, like `decide`; the engine appends what it returns in one transaction.
 */
import * as DateTime from "effect/DateTime";
import { runStream, workflowStream } from "./facts.ts";
import { runIdFor } from "./ids.ts";
import type { CurrentVersion } from "./Catalog.ts";
import type { NewFact, StoredFact } from "./facts.ts";

export interface DecideWorkflowInput {
  readonly workflowId: string;
  /** The workflow's stream. */
  readonly facts: ReadonlyArray<StoredFact>;
  readonly current: CurrentVersion;
  /** Runs of this workflow that started and did not end. */
  readonly liveRuns: number;
  readonly now: number;
}

/** Promotes pending occurrences in sequence order using the current pinned definition. */
export const decideWorkflow = (input: DecideWorkflowInput): ReadonlyArray<NewFact> => {
  const output: NewFact[] = [];
  const keys = new Set(input.facts.map((entry) => entry.key));
  let busy = input.liveRuns > 0;
  const tripped = fatigueTrip(input);
  if (tripped !== null) {
    keys.add(tripped.key);
    output.push(tripped);
  }
  const suspendedNow = tripped !== null;
  for (const entry of [...input.facts].sort((a, b) => a.seq - b.seq)) {
    const trigger = entry.fact;
    if (trigger._tag !== "TriggerFired") continue;
    const occurrence = trigger.occurrence;
    if (keys.has(`created:${occurrence}`) || keys.has(`skipped:${occurrence}`)) continue;
    const skip = (reason: "invalid" | "disabled" | "suspended" | "busy") => {
      const key = `skipped:${occurrence}`;
      keys.add(key);
      output.push({
        stream: workflowStream(input.workflowId),
        key,
        fact: { _tag: "TriggerSkipped", occurrence, reason },
      });
    };
    const current = input.current;
    if (current._tag !== "Ready") {
      skip("invalid");
      continue;
    }
    if (!current.enabled) {
      skip("disabled");
      continue;
    }
    if (current.suspended || suspendedNow) {
      skip("suspended");
      continue;
    }
    const { definition } = current.version.compiled;
    const declarations = definition.params ?? {};
    const params: Record<string, string | number | boolean> = {};
    let valid = Object.keys(trigger.params).every((key) => Object.hasOwn(declarations, key));
    for (const [name, spec] of Object.entries(declarations)) {
      const value = Object.hasOwn(trigger.params, name) ? trigger.params[name] : spec.default;
      if (
        (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
        typeof value !== spec.type
      ) {
        valid = false;
        continue;
      }
      if (typeof value === "string" && spec.pattern !== undefined) {
        try {
          if (!new RegExp(spec.pattern).test(value)) valid = false;
        } catch {
          valid = false;
        }
      }
      params[name] = value;
    }
    if (!valid) {
      skip("invalid");
      continue;
    }
    const concurrency = definition.concurrency ?? "single";
    if (busy && concurrency === "queue") break;
    if (busy && concurrency === "single") {
      skip("busy");
      continue;
    }
    const runId = runIdFor(input.workflowId, occurrence);
    const key = `created:${occurrence}`;
    keys.add(key);
    output.push({
      stream: workflowStream(input.workflowId),
      key,
      fact: { _tag: "RunCreated", runId, occurrence },
    });
    const wall = definition.budget.wall;
    const unit = wall.slice(-1);
    const wallMs =
      Number(wall.slice(0, -1)) * (unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000);
    output.push({
      stream: runStream(runId),
      key: "started",
      fact: {
        _tag: "RunStarted",
        workflowId: input.workflowId,
        commit: current.version.commit,
        hash: current.version.compiled.hash,
        title: definition.title,
        params,
        trigger: { kind: trigger.kind, occurrence, label: trigger.label, payload: trigger.payload },
        budget: {
          steps: definition.budget.steps,
          wallMs,
          tokens: definition.budget.tokens,
          usd: definition.budget.usd ?? null,
        },
        parent: trigger.parent,
        causalDepth: trigger.causalDepth,
        at: DateTime.formatIso(DateTime.makeUnsafe(input.now)),
      },
    });
    busy = true;
  }
  return output;
};

/**
 * Suspended when the last `fatigue.consecutiveFailures` outcomes since the last Unsuspended all
 * failed; keyed by the run that reached the limit, so the trip is recorded once.
 */
const fatigueTrip = (input: DecideWorkflowInput): NewFact | null => {
  const current = input.current;
  if (current._tag !== "Ready" || current.suspended) return null;
  const limit = current.version.compiled.definition.fatigue.consecutiveFailures;
  let streak = 0;
  let last: string | null = null;
  for (const { fact } of input.facts) {
    if (fact._tag === "Unsuspended" || fact._tag === "Suspended") streak = 0;
    if (fact._tag !== "RunOutcome") continue;
    const failed = fact.status === "failed" || fact.status === "budget_exhausted";
    streak = failed ? streak + 1 : 0;
    if (failed) last = fact.runId;
  }
  if (streak < limit || last === null) return null;
  return {
    stream: workflowStream(input.workflowId),
    key: `suspended:${last}`,
    fact: {
      _tag: "Suspended",
      reason: "fatigue",
      at: DateTime.formatIso(DateTime.makeUnsafe(input.now)),
    },
  };
};
