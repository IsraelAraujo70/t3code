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
 * Pure. Whether a bot thread's held queue should run again, as the stable key of that resume.
 *
 * A restart or a stop holds a thread's queued messages until the user sends one from a client or
 * presses Resume. Messages the server sends a bot (thread-watch notices, scheduled tasks) start
 * right away on an idle thread and pass the held ones, which then wait for a person who may not
 * come for a day. Once the bot's latest run that actually started has completed, the bot works
 * again and nothing should keep its older messages waiting. A latest run that failed, was
 * interrupted or was cut by the restart leaves the hold in place.
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
