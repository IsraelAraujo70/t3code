import { AsyncResult, Atom } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useAtomValueWhileVisible } from "../../features/home/home-route-visibility";

import { createWorkflowsEnvironmentAtoms } from "@t3tools/client-runtime/workflows";
import type {
  EnvironmentId,
  WorkflowId,
  WorkflowRunId,
  WorkflowRunsListInput,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

const empty = Atom.make(AsyncResult.initial<never, never>(false));
function useVisibleQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  visible: boolean,
) {
  const result = useAtomValueWhileVisible<AsyncResult.AsyncResult<A, E>>(atom ?? empty, visible);
  const failure = result._tag === "Failure" ? Cause.squash(result.cause) : null;
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error:
      failure === null
        ? null
        : failure instanceof Error
          ? failure.message
          : "Environment unavailable.",
  };
}
/** Workflows queries and commands bound to the mobile connection runtime. */
export const workflowsEnvironment = createWorkflowsEnvironmentAtoms(connectionAtomRuntime);

/** Subscribe to the definitions on the selected host. */
export function useWorkflowsSnapshot(environmentId: EnvironmentId | null, visible = true) {
  return useVisibleQuery(
    environmentId === null ? null : workflowsEnvironment.snapshot({ environmentId, input: {} }),
    visible,
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
