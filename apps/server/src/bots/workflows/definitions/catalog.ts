import { WorkflowTrigger } from "@t3tools/contracts";
import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { WorkflowCatalog, type CurrentVersion } from "../Catalog.ts";
import { Journal, WorkflowJournalError } from "../Journal.ts";
import * as Definitions from "./WorkflowDefinitions.ts";
import * as Store from "./definitionsStore.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTriggers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, WorkflowTrigger)),
);
const failure = (cause: unknown) =>
  new WorkflowJournalError({ message: "Workflow catalog operation failed.", cause });
const make = Effect.gen(function* () {
  const definitions = yield* Definitions.WorkflowDefinitions;
  const journal = yield* Journal;
  const sql = yield* SqlClient.SqlClient;
  const pinned = Effect.fn("WorkflowCatalog.pinned")(function* (
    workflowId: string,
    commit: string,
  ) {
    const row = yield* Store.getVersion(workflowId, commit).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(failure),
    );
    if (!row) return yield* failure(undefined);
    const json: unknown = yield* decodeJson(row.definition_json).pipe(Effect.mapError(failure));
    const compiled = compileWorkflow(json, DEFAULT_HOST_LIMITS);
    if (Result.isFailure(compiled)) return yield* failure(compiled.failure);
    return { workflowId, commit, compiled: compiled.success };
  });
  return WorkflowCatalog.of({
    pinned,
    current: Effect.fn("WorkflowCatalog.current")(function* (
      workflowId: string,
    ): Effect.fn.Return<CurrentVersion, WorkflowJournalError> {
      yield* definitions.ingest(workflowId).pipe(Effect.mapError(failure));
      const document = yield* definitions.document(workflowId).pipe(
        Effect.catchTags({
          WorkflowsError: (error) =>
            error.code === "not-found" ? Effect.succeed(null) : Effect.fail(failure(error)),
        }),
      );
      if (!document) return { _tag: "Missing" };
      if (!document.valid || document.dirty || !document.headCommit) return { _tag: "Invalid" };
      const row = yield* Store.getVersion(workflowId, document.headCommit).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(failure),
      );
      if (!row) return { _tag: "Invalid" };
      const parsed = yield* decodeJson(row.definition_json).pipe(Effect.result);
      if (Result.isFailure(parsed)) return { _tag: "Invalid" };
      const compiled = compileWorkflow(parsed.success, DEFAULT_HOST_LIMITS);
      if (Result.isFailure(compiled)) return { _tag: "Invalid" };
      return {
        _tag: "Ready",
        off: (yield* journal.workflowStatus(workflowId)).off,
        version: { workflowId, commit: document.headCommit, compiled: compiled.success },
        enabled: document.enabled,
        suspended: document.suspended,
      };
    }),
    failureSubscribers: Effect.fn("WorkflowCatalog.failureSubscribers")(function* (
      workflowId: string,
    ) {
      const rows = yield* Store.listIndex().pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const subscribers: Array<{
        workflowId: string;
        triggerId: string;
        params?: Readonly<Record<string, string>>;
      }> = [];
      for (const row of rows) {
        if (row.valid !== 1 || row.workflow_id === workflowId) continue;
        const triggers = yield* decodeTriggers(row.triggers_json);
        for (const [id, trigger] of Object.entries(triggers))
          if (
            trigger.kind === "workflowFailed" &&
            (!trigger.workflow || trigger.workflow === workflowId)
          )
            subscribers.push({
              workflowId: row.workflow_id,
              triggerId: id,
              params: trigger.params ?? {},
            });
      }
      return subscribers.sort(
        (a, b) =>
          a.workflowId.localeCompare(b.workflowId) || a.triggerId.localeCompare(b.triggerId),
      );
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(WorkflowCatalog, make);
