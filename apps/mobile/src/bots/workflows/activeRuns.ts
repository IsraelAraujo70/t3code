import { activeWorkflowRuns } from "@t3tools/client-runtime/workflows";

import { useBotsEnvironmentId } from "../state";
import { useWorkflowsSnapshot } from "./state";

/**
 * The bots host's runs that have not ended, those that need the user first, live from the
 * workflows snapshot. `visible` false stops listening and keeps the last list.
 */
export function useActiveWorkflowRuns(visible = true) {
  const environmentId = useBotsEnvironmentId();
  const snapshot = useWorkflowsSnapshot(environmentId, visible).data;
  const runs = snapshot ? activeWorkflowRuns(snapshot) : [];
  return { environmentId, runs, needsYou: runs.filter((r) => r.needsYou).length };
}

/** Whether a workflow run on the bots host waits for the user, for the Bots tab's dot. */
export function useWorkflowsNeedYou(): boolean {
  return useActiveWorkflowRuns().needsYou > 0;
}
