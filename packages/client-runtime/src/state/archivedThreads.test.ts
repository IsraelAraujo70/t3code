import { EnvironmentId, OrchestrationV2ArchivedShellSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

const decodeArchivedSnapshot = Schema.decodeUnknownSync(OrchestrationV2ArchivedShellSnapshot);

it("hides archived workflow steps while retaining ordinary threads and user forks", () => {
  const workflowId = "wf:wfr_0123456789abcdef0123:0123456789abcdef";
  const at = DateTime.makeUnsafe("2026-11-02T00:00:00.000Z");
  const snapshot = decodeArchivedSnapshot({
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    threads: [workflowId, "ordinary", "fork"].map((id) => ({
      id,
      projectId: "project",
      title: id,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        rootThreadId: id === "fork" ? workflowId : id,
        parentThreadId: id === "fork" ? workflowId : null,
        relationshipToParent: id === "fork" ? "fork" : null,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: at,
      updatedAt: at,
      archivedAt: at,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    })),
  });
  const environmentId = EnvironmentId.make("env");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () => Atom.make(AsyncResult.success(snapshot)),
    labelPrefix: "test:archive",
  });
  const registry = AtomRegistry.make();
  try {
    const result = registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])));
    expect(result.snapshots[0]?.snapshot.threads.map((thread) => thread.id)).toEqual([
      "ordinary",
      "fork",
    ]);
  } finally {
    registry.dispose();
  }
});
