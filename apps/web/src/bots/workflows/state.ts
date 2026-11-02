import { createWorkflowsEnvironmentAtoms } from "@t3tools/client-runtime/workflows";
import type {
  EnvironmentId,
  WorkflowId,
  WorkflowRunId,
  WorkflowRunsListInput,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

/** Workflows queries and commands bound to the web connection runtime. */
export const workflowsEnvironment = createWorkflowsEnvironmentAtoms(connectionAtomRuntime);

/** Subscribe to the definitions on the selected host. */
export function useWorkflowsSnapshot(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : workflowsEnvironment.snapshot({ environmentId, input: {} }),
  );
}

/** Subscribe to one workflow document. */
export function useWorkflowDocument(environmentId: EnvironmentId | null, workflowId: WorkflowId) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : workflowsEnvironment.document({ environmentId, input: { workflowId } }),
  );
}

/** Subscribe to a run and fold subsequent deltas. */
export function useWorkflowRun(environmentId: EnvironmentId | null, runId: WorkflowRunId) {
  return useEnvironmentQuery(
    environmentId === null ? null : workflowsEnvironment.run({ environmentId, input: { runId } }),
  );
}

/** Query the host's run history. */
export function useWorkflowRuns(environmentId: EnvironmentId | null, input: WorkflowRunsListInput) {
  return useEnvironmentQuery(
    environmentId === null ? null : workflowsEnvironment.runs({ environmentId, input }),
  );
}
