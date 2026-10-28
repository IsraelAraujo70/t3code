import type { OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type QueueRun = Pick<
  OrchestrationV2Run,
  "id" | "status" | "queueHeld" | "queuePosition" | "ordinal" | "startedAt" | "completedAt"
>;

const blocking = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * Resume held messages only after the latest started run completes successfully.
 * Server messages can bypass a held queue; their completion releases older messages.
 */
export function botQueueResumeKey(runs: ReadonlyArray<QueueRun>): string | null {
  let held: QueueRun | undefined;
  let latest: QueueRun | undefined;
  for (const run of runs) {
    if (blocking.has(run.status)) return null;
    if (run.status === "queued") {
      if (
        run.queueHeld === true &&
        (held === undefined ||
          (run.queuePosition ?? run.ordinal) < (held.queuePosition ?? held.ordinal))
      ) {
        held = run;
      }
      continue;
    }
    if (
      run.startedAt !== null &&
      run.completedAt !== null &&
      (latest?.completedAt == null ||
        DateTime.toEpochMillis(run.completedAt) > DateTime.toEpochMillis(latest.completedAt))
    ) {
      latest = run;
    }
  }
  if (held === undefined || latest?.status !== "completed") return null;
  return `${latest.id}:${held.id}`;
}
