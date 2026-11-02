// @effect-diagnostics effectFnIife:off - The fixed contract exposes a list effect with a named span.
// @effect-diagnostics preferSchemaOverJson:off - SQL rows store encoded JSON snapshots.
/**
 * The workflow definitions service (design §7.3): the only writer of the definitions repository.
 * Canvas, Source tab, bots (MCP) and hand edits all end here, pass the same compiler and become a
 * commit. Each committed version is kept in `workflow_versions`; `workflow_index` is a rebuildable
 * cache of what is on disk. A workflow is off until its first `Toggled` fact.
 */
import type {
  WorkflowDeleteInput,
  WorkflowDeleteResult,
  WorkflowDocument,
  WorkflowFromTemplateInput,
  WorkflowHistoryInput,
  WorkflowHistoryPage,
  WorkflowRestoreInput,
  WorkflowSaveInput,
  WorkflowSaveResult,
  WorkflowSetEnabledInput,
  WorkflowsSnapshot,
  WorkflowSummary,
  WorkflowValidateInput,
  WorkflowValidateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Who writes. Commit author: `Owner`, `Owner (hand edit)` for ingestion, `<name> (bot)`. */
export type WorkflowAuthor =
  | { readonly kind: "user" }
  | { readonly kind: "bot"; readonly name: string; readonly canManageBots: boolean };

export class WorkflowDefinitions extends Context.Service<
  WorkflowDefinitions,
  {
    /** Absolute path of the definitions repository. */
    readonly repoPath: string;
    /** The snapshot now, then again after every change (any writer, hand edits, toggles). */
    readonly snapshot: Stream.Stream<WorkflowsSnapshot, WorkflowsError>;
    readonly list: Effect.Effect<ReadonlyArray<WorkflowSummary>, WorkflowsError>;
    /** Fails `not-found` when no file exists. */
    readonly document: (workflowId: string) => Effect.Effect<WorkflowDocument, WorkflowsError>;
    /** The document now, then after every change to that workflow. */
    readonly documentChanges: (
      workflowId: string,
    ) => Stream.Stream<WorkflowDocument, WorkflowsError>;
    /** Same checks as `save`, nothing written. */
    readonly validate: (
      input: WorkflowValidateInput,
    ) => Effect.Effect<WorkflowValidateResult, WorkflowsError>;
    readonly save: (
      input: WorkflowSaveInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSaveResult, WorkflowsError>;
    readonly fromTemplate: (
      input: WorkflowFromTemplateInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSaveResult, WorkflowsError>;
    /** `permission` for a bot without canManageBots. */
    readonly setEnabled: (
      input: WorkflowSetEnabledInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSummary, WorkflowsError>;
    readonly delete: (
      input: WorkflowDeleteInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowDeleteResult, WorkflowsError>;
    /** Brings back the last version of a deleted workflow, off. */
    readonly restore: (
      input: WorkflowRestoreInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSummary, WorkflowsError>;
    readonly history: (
      input: WorkflowHistoryInput,
    ) => Effect.Effect<WorkflowHistoryPage, WorkflowsError>;
    /**
     * Converges disk, git and the tables for one workflow (or all): a valid hand edit becomes a
     * commit and a version; an invalid one marks the workflow dirty and invalid; a commit with no
     * version row gets one. The watcher, the startup scan and `save` call it.
     */
    readonly ingest: (workflowId?: string) => Effect.Effect<void, WorkflowsError>;
    /** Ids of workflows that changed, as they change; the trigger sources reconcile on it. */
    readonly changes: Stream.Stream<string>;
  }
>()("t3/bots/workflows/definitions/WorkflowDefinitions") {}

import { WorkflowsError, type WorkflowTrigger, type WorkflowNode } from "@t3tools/contracts";
import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { WorkflowId, WorkflowDocRevision } from "@t3tools/contracts";
import * as Path from "effect/Path";
import { ServerConfig } from "../../../config.ts";
import { Journal } from "../Journal.ts";
import { workflowStream } from "../facts.ts";
import { workflowStatus } from "../workflowStatus.ts";
import { WorkflowRepo, layer as repoLayer } from "./WorkflowRepo.ts";
import { parseWorkflowSource, toCanonicalYaml } from "./yamlCodec.ts";
import * as Store from "./definitionsStore.ts";

const workflowId = Schema.decodeSync(WorkflowId);
const revision = Schema.decodeSync(WorkflowDocRevision);
const isWorkflowsError = Schema.is(WorkflowsError);
const internal = (cause: unknown) =>
  isWorkflowsError(cause)
    ? cause
    : new WorkflowsError({
        code: "internal",
        message: "Workflow definitions operation failed.",
        cause,
      });
const label = (t: WorkflowTrigger): string => {
  switch (t.kind) {
    case "cron":
      return `${t.expr} (${t.tz})`;
    case "webhook":
      return "webhook";
    case "upstreamTag":
      return `tag ${t.pattern} on ${t.remote}`;
    case "prMerged":
      return `PR merged in ${t.repo}`;
    case "threadSettled":
      return "thread settled";
    case "workflowFailed":
      return `${t.workflow ?? "any"} failed`;
  }
};
import * as SqlClient from "effect/sql/SqlClient";
const make = Effect.gen(function* () {
  const repo = yield* WorkflowRepo;
  const journal = yield* Journal;
  const sql = yield* SqlClient.SqlClient;
  const store = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    e.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const bus = yield* PubSub.unbounded<string>();
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const status = (id: string) => journal.read(workflowStream(id)).pipe(Effect.map(workflowStatus));
  const callGraph = new Map<string, ReadonlyArray<string>>();
  const calls = (nodes: Readonly<Record<string, WorkflowNode>>): string[] =>
    Object.values(nodes).flatMap((node) =>
      node.kind === "call"
        ? [node.workflow]
        : node.kind === "map" || node.kind === "loop"
          ? calls(node.body.nodes)
          : [],
    );
  const refreshGraph = Effect.fn("WorkflowDefinitions.refreshGraph")(function* () {
    callGraph.clear();
    for (const id of yield* repo.listIds) {
      const file = Option.getOrNull(yield* repo.read(id));
      if (!file) continue;
      const parsed = parseWorkflowSource(file.text);
      if (Result.isFailure(parsed)) continue;
      const compiled = compileWorkflow(parsed.success, DEFAULT_HOST_LIMITS);
      if (Result.isSuccess(compiled)) callGraph.set(id, calls(compiled.success.definition.nodes));
    }
  });
  const compile = (input: WorkflowValidateInput) => {
    const parsed =
      "source" in input ? parseWorkflowSource(input.source) : Result.succeed(input.definition);
    return Result.isFailure(parsed)
      ? Result.fail([parsed.failure])
      : compileWorkflow(parsed.success, { ...DEFAULT_HOST_LIMITS, callGraph });
  };
  const validate = Effect.fn("WorkflowDefinitions.validate")(function* (
    input: WorkflowValidateInput,
  ) {
    yield* refreshGraph().pipe(Effect.mapError(internal));
    const result = compile(input);
    if (Result.isFailure(result))
      return { diagnostics: result.failure, normalizedSource: null, semanticHash: null };
    const normalizedSource = toCanonicalYaml(result.success.definition);
    const again = compile({ source: normalizedSource });
    if (Result.isFailure(again) || again.success.hash !== result.success.hash)
      return yield* internal("Canonical hash mismatch");
    return { diagnostics: [], normalizedSource, semanticHash: result.success.hash };
  });
  const document = Effect.fn("WorkflowDefinitions.document")(function* (id: string) {
    const file = yield* repo.read(id);
    if (Option.isNone(file))
      return yield* new WorkflowsError({ code: "not-found", message: "Workflow not found." });
    const head = Option.getOrNull(yield* repo.head(id));
    const result = compile({ source: file.value.text });
    return {
      workflowId: workflowId(id),
      source: file.value.text,
      revision: revision(file.value.revision),
      headCommit: head?.commit ?? null,
      definition: Result.isSuccess(result) ? result.success.definition : null,
      hash: Result.isSuccess(result) ? result.success.hash : null,
      valid: Result.isSuccess(result),
      dirty: head?.revision !== file.value.revision,
      diagnostics: Result.isFailure(result) ? result.failure : [],
      ...(yield* status(id)),
      updatedBy: head?.author ?? null,
      updatedAt: head?.at ?? null,
    };
  }, Effect.mapError(internal));
  const index = Effect.fn("WorkflowDefinitions.index")(function* (id: string) {
    const d = yield* document(id);
    yield* store(
      Store.upsertIndex({
        workflow_id: id,
        path: `${id}.workflow.yaml`,
        head_commit: d.headCommit,
        revision: d.revision,
        title: d.definition?.title ?? id,
        valid: Number(d.valid),
        dirty: Number(d.dirty),
        diagnostics_json: JSON.stringify(d.diagnostics),
        triggers_json: JSON.stringify(d.definition?.triggers ?? []),
        scanned_at: yield* now,
      }),
    );
    if (d.valid && d.headCommit && !d.dirty)
      yield* store(
        Store.insertVersion({
          workflow_id: id,
          commit_sha: d.headCommit,
          revision: d.revision,
          semantic_hash: d.hash!,
          source: d.source,
          definition_json: JSON.stringify(d.definition),
          author: d.updatedBy!,
          created_at: d.updatedAt!,
        }),
      );
  });
  const toggle = Effect.fn("WorkflowDefinitions.toggle")(function* (
    id: string,
    commit: string,
    enabled: boolean,
    by: string,
    key: string,
  ) {
    yield* journal.append([
      {
        stream: workflowStream(id),
        key: `toggled:${key}:${commit}`,
        fact: { _tag: "Toggled", enabled, by, at: yield* now },
      },
    ]);
  });
  const ingestInternal = Effect.fn("WorkflowDefinitions.ingestInternal")(function* (
    id: string | undefined,
  ) {
    const ids = id
      ? [id]
      : [
          ...new Set([
            ...(yield* repo.listIds),
            ...(yield* repo.dirtyIds),
            ...(yield* store(Store.listIndex())).map((r) => r.workflow_id),
          ]),
        ];
    for (const current of ids) {
      const file = yield* repo.read(current);
      const head = Option.getOrNull(yield* repo.head(current));
      if (Option.isNone(file)) {
        if (head) {
          const commit = yield* repo.commit({
            workflowId: current,
            author: "Owner (hand edit)",
            message: "Hand edit",
          });
          yield* toggle(current, commit, false, "Owner (hand edit)", "deleted");
          yield* store(Store.deleteIndex(current));
          yield* PubSub.publish(bus, current);
        }
        continue;
      }
      const dirty = head?.revision !== file.value.revision;
      if (dirty && Result.isSuccess(compile({ source: file.value.text })))
        yield* repo.commit({
          workflowId: current,
          author: "Owner (hand edit)",
          message: "Hand edit",
        });
      yield* index(current);
      if (dirty) yield* PubSub.publish(bus, current);
    }
  }, Effect.mapError(internal));
  const ingest = Effect.fn("WorkflowDefinitions.ingest")((id?: string) =>
    lock.withPermits(1)(ingestInternal(id)),
  );
  const save = Effect.fn("WorkflowDefinitions.save")(
    (input: WorkflowSaveInput, author: WorkflowAuthor) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* refreshGraph();
            const prepared =
              "definition" in input
                ? {
                    definition: {
                      ...input.definition,
                      ...(input.canvas ? { canvas: input.canvas } : {}),
                    },
                  }
                : input;
            const result = compile(prepared);
            const id =
              input.workflowId ??
              (Result.isSuccess(result) ? result.success.definition.id : undefined);
            if (!id)
              return {
                _tag: "Invalid" as const,
                diagnostics: Result.isFailure(result) ? result.failure : [],
              };
            for (let attempt = 0; attempt < 3; attempt++) {
              yield* ingestInternal(id);
              const file = Option.getOrNull(yield* repo.read(id));
              if (!file && input.baseRevision)
                return yield* new WorkflowsError({
                  code: "not-found",
                  message: "Workflow not found.",
                });
              if (file && (input.baseRevision !== file.revision || attempt === 2)) {
                const base = input.baseRevision
                  ? yield* store(Store.findVersionByRevision(id, input.baseRevision))
                  : undefined;
                return {
                  _tag: "Conflict" as const,
                  workflowId: workflowId(id),
                  base: base ? { revision: revision(base.revision), source: base.source } : null,
                  current: yield* document(id),
                };
              }
              if (Result.isFailure(result))
                return { _tag: "Invalid" as const, diagnostics: result.failure };
              if (id !== result.success.definition.id)
                return {
                  _tag: "Invalid" as const,
                  diagnostics: [
                    { path: "id", code: "schema" as const, message: "Workflow id does not match." },
                  ],
                };
              const checked = yield* validate(prepared);
              const canonical = checked.normalizedSource!;
              const reread = Option.getOrNull(yield* repo.read(id));
              if (file?.revision !== reread?.revision) continue;
              const by = author.kind === "user" ? "Owner" : `${author.name} (bot)`;
              if (file?.text !== canonical) {
                const head = Option.getOrNull(yield* repo.head(id));
                if (file && file.revision !== head?.revision)
                  yield* repo.keepOverwritten(id, file.text);
                yield* repo.writeAtomic(id, canonical);
              }
              const commit = yield* repo.commit({
                workflowId: workflowId(id),
                author: by,
                message: input.message.trim() || `Save ${id}`,
              });
              yield* index(id);
              if (!file)
                yield* toggle(
                  id,
                  commit,
                  author.kind === "user" || author.canManageBots,
                  by,
                  "created",
                );
              else if (
                author.kind === "bot" &&
                !author.canManageBots &&
                (result.success.definition.triggers?.length ?? 0) > 0 &&
                (yield* status(id)).enabled
              )
                yield* toggle(id, commit, false, by, "bot-save");
              yield* PubSub.publish(bus, id);
              return {
                _tag: "Saved" as const,
                workflowId: workflowId(id),
                revision: revision(repo.revisionOf(canonical)),
                commit,
                hash: result.success.hash,
                enabled: (yield* status(id)).enabled,
              };
            }
            return yield* internal("Concurrent edits");
          }),
        )
        .pipe(Effect.mapError(internal)),
  );
  const list = Effect.fn("WorkflowDefinitions.list")(function* () {
    return yield* Effect.forEach(yield* repo.listIds, (id) =>
      document(id).pipe(
        Effect.map((d) => ({
          workflowId: workflowId(id),
          title: d.definition?.title ?? id,
          description: d.definition?.description ?? null,
          path: `${id}.workflow.yaml`,
          valid: d.valid,
          dirty: d.dirty,
          enabled: d.enabled,
          suspended: d.suspended,
          diagnostics: d.diagnostics.length,
          triggers: (d.definition?.triggers ?? []).map((t) => ({
            id: t.id,
            kind: t.kind,
            label: label(t),
            webhookUrl: null,
          })),
          headCommit: d.headCommit,
          revision: d.revision,
          updatedAt: d.updatedAt,
          lastRun: null,
        })),
      ),
    );
  }, Effect.mapError(internal))();
  const changes = Stream.fromPubSub(bus);
  const documentChanges = (id: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(bus);
        return Stream.concat(
          Stream.fromEffect(document(id)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === id),
            Stream.mapEffect(() => document(id)),
          ),
        );
      }),
    );
  const snapshot = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(bus);
      const read = list.pipe(
        Effect.map((workflows) => ({ repoPath: repo.root, workflows, deleted: [], templates: [] })),
      );
      return Stream.concat(
        Stream.fromEffect(read),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
      );
    }),
  );
  const unavailable = () =>
    Effect.fail(new WorkflowsError({ code: "unavailable", message: "Not implemented yet." }));
  yield* repo.ensure.pipe(Effect.mapError(internal));
  yield* ingest();
  return WorkflowDefinitions.of({
    repoPath: repo.root,
    validate,
    document,
    documentChanges,
    list,
    save,
    ingest,
    changes,
    snapshot,
    fromTemplate: unavailable,
    setEnabled: unavailable,
    delete: unavailable,
    restore: unavailable,
    history: unavailable,
  });
});
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(WorkflowDefinitions, make).pipe(
      Layer.provide(repoLayer(path.join(config.baseDir, "workflows", "definitions"))),
    );
  }),
);
