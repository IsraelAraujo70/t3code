// @effect-diagnostics effectFnIife:off - The fixed contract exposes a list effect with a named span.
// @effect-diagnostics preferSchemaOverJson:off - SQL rows store encoded JSON snapshots.
/**
 * The workflow definitions service (design §7.3): the only writer of the definitions repository.
 * Canvas, Source tab, bots (MCP) and hand edits all end here, pass the same compiler and become a
 * commit. Each committed version is kept in `workflow_versions`; `workflow_index` is a rebuildable
 * cache of what is on disk. A workflow is off until its first `Toggled` fact.
 */
import {
  BotId,
  WorkflowDocRevision,
  WorkflowId,
  WorkflowsError,
  type WorkflowDeleteInput,
  type WorkflowDeleteResult,
  type WorkflowDocument,
  type WorkflowFromTemplateInput,
  type WorkflowHistoryInput,
  type WorkflowHistoryPage,
  type WorkflowNode,
  type WorkflowParamSpec,
  type WorkflowRestoreInput,
  type WorkflowSaveInput,
  type WorkflowSaveResult,
  type WorkflowSetEnabledInput,
  type WorkflowsSnapshot,
  type WorkflowSummary,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowTriggerSummary,
  type WorkflowValidateInput,
  type WorkflowValidateResult,
} from "@t3tools/contracts";
import {
  compileWorkflow,
  DEFAULT_HOST_LIMITS,
  triggerLabel,
  triggerParts,
} from "@t3tools/shared/workflows";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { stringify } from "yaml";

import { ServerConfig } from "../../../config.ts";
import * as BotsStore from "../../BotsStore.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { workflowHookTaskId } from "../triggers/hook.ts";
import { Journal } from "../Journal.ts";
import { workflowStream } from "../facts.ts";
import * as Store from "./definitionsStore.ts";
import { WorkflowRepo, layer as repoLayer } from "./WorkflowRepo.ts";
import { parseWorkflowSource, toCanonicalYaml } from "./yamlCodec.ts";

/** Who writes. Commit author: `Owner`, `Owner (hand edit)` for ingestion, `<name> (bot)`. */
/** A workflow as a tool for one bot (`workflow_list`'s `bot` entry, `workflow_run`'s check). */
export interface BotEntry {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly description: string;
  readonly params: Readonly<Record<string, WorkflowParamSpec>>;
  /** A run would start now: the workflow and the trigger are on and it is not suspended. */
  readonly on: boolean;
}

export type WorkflowAuthor =
  | { readonly kind: "user" }
  | {
      readonly kind: "bot";
      readonly id: string;
      readonly name: string;
      readonly canManageBots: boolean;
    };

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
    /** Same checks as `save`, nothing written; the bot binding rules apply when `author` is given. */
    readonly validate: (
      input: WorkflowValidateInput,
      author?: WorkflowAuthor,
    ) => Effect.Effect<WorkflowValidateResult, WorkflowsError>;
    readonly save: (
      input: WorkflowSaveInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSaveResult, WorkflowsError>;
    /** A ready-made workflow's YAML, as shipped; `not-found` for an unknown id. */
    readonly template: (templateId: string) => Effect.Effect<string, WorkflowsError>;
    readonly fromTemplate: (
      input: WorkflowFromTemplateInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSaveResult, WorkflowsError>;
    /** `permission` for a bot without canManageBots. */
    readonly setEnabled: (
      input: WorkflowSetEnabledInput,
      author: WorkflowAuthor,
    ) => Effect.Effect<WorkflowSummary, WorkflowsError>;
    /** The workflows `botId` may run: valid HEADs with a `bot` trigger whose `bots` lists it or is absent. */
    readonly botEntries: (botId: string) => Effect.Effect<ReadonlyArray<BotEntry>, WorkflowsError>;
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

const workflowId = Schema.decodeSync(WorkflowId);
const isBotId = Schema.is(BotId);
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
/** Template ids are file names in the library; the pattern keeps `../` out of the path. */
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,62}$/;

/** The summaries of a definition's triggers; `urls` maps webhook task ids to their public URLs. */
const triggerSummaries = (
  workflowId: string,
  triggers: WorkflowDefinition["triggers"],
  urls: ReadonlyMap<string, string>,
  off: ReadonlySet<string> = new Set(),
  fired: ReadonlyMap<string, string> = new Map(),
): Array<WorkflowTriggerSummary> =>
  Object.entries(triggers ?? {}).map(([id, trigger]) => ({
    id,
    kind: trigger.kind,
    title: trigger.title ?? null,
    label: triggerLabel(trigger),
    ...triggerParts(trigger),
    webhookUrl:
      trigger.kind === "webhook" ? (urls.get(workflowHookTaskId(workflowId, id)) ?? null) : null,
    enabled: trigger.kind === "manual" || !off.has(id),
    lastFiredAt: fired.get(JSON.stringify([workflowId, id])) ?? null,
  }));
const make = Effect.gen(function* () {
  const repo = yield* WorkflowRepo;
  // Webhook triggers are scheduled tasks; their URLs come from there when the service is present.
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService);
  const webhookUrls = Option.isNone(scheduledTasks)
    ? Effect.succeed(new Map<string, string>())
    : scheduledTasks.value.list().pipe(
        Effect.map(
          ({ tasks }) =>
            new Map(
              tasks.flatMap((task) =>
                task.webhook === undefined
                  ? []
                  : [[task.id as string, task.webhook.url ?? task.webhook.path] as const],
              ),
            ),
        ),
        Effect.orElseSucceed(() => new Map<string, string>()),
      );
  const fs = yield* FileSystem.FileSystem;
  const nodePath = yield* Path.Path;
  const journal = yield* Journal;
  // Optional so definitions work without bots (tests); the bots host always has the store.
  const bots = yield* Effect.serviceOption(BotsStore.BotsStore);
  const sql = yield* SqlClient.SqlClient;
  const store = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    e.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const bus = yield* PubSub.unbounded<string>();
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const status = journal.workflowStatus;
  const callGraph = new Map<string, ReadonlyArray<string>>();
  const callTargets = new Map<string, { readonly from: ReadonlyArray<string> | null }>();
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
    callTargets.clear();
    for (const id of yield* repo.listIds) {
      const file = Option.getOrNull(yield* repo.read(id));
      if (!file) continue;
      const parsed = parseWorkflowSource(file.text);
      if (Result.isFailure(parsed)) continue;
      const compiled = compileWorkflow(parsed.success, DEFAULT_HOST_LIMITS);
      if (Result.isSuccess(compiled)) {
        callGraph.set(id, calls(compiled.success.definition.nodes));
        const trigger = Object.values(compiled.success.definition.triggers ?? {}).find(
          (trigger) => trigger.kind === "call",
        );
        if (trigger?.kind === "call") callTargets.set(id, { from: trigger.from ?? null });
      }
    }
  });
  const compile = (input: WorkflowValidateInput) => {
    const parsed =
      "source" in input ? parseWorkflowSource(input.source) : Result.succeed(input.definition);
    return Result.isFailure(parsed)
      ? Result.fail([parsed.failure])
      : compileWorkflow(parsed.success, { ...DEFAULT_HOST_LIMITS, callGraph, callTargets });
  };
  /** A file compiles only under its own name: `<id>.workflow.yaml` must say `id: <id>`. */
  const compileFile = (id: string, text: string) => {
    const result = compile({ source: text });
    return Result.isSuccess(result) && result.success.definition.id !== id
      ? Result.fail([
          {
            path: "id",
            code: "schema" as const,
            message: `id must match the file name ${id}.workflow.yaml`,
          },
        ])
      : result;
  };
  /** The bot the workflow's file binds now, or else its last committed version; null when none. */
  const boundBot = Effect.fn("WorkflowDefinitions.boundBot")(function* (id: string) {
    const file = Option.getOrNull(yield* repo.read(id));
    if (file) {
      const current = compileFile(id, file.text);
      if (Result.isSuccess(current)) return current.success.definition.bot ?? null;
    }
    const head = Option.getOrNull(yield* repo.head(id));
    const version = head ? yield* store(Store.getVersion(id, head.commit)) : undefined;
    if (!version) return null;
    const bot = (JSON.parse(version.definition_json) as { readonly bot?: unknown }).bot;
    return typeof bot === "string" ? bot : null;
  });
  /**
   * Who may bind a workflow to which bot: the bot must exist, and a bot author never saves a
   * workflow bound to another bot, before or after the save: keeping that binding while editing
   * the prompts would hand the other bot's tools to its own prompts. The owner binds freely.
   */
  const bindingIssues = Effect.fn("WorkflowDefinitions.bindingIssues")(function* (
    definition: WorkflowDefinition,
    author: WorkflowAuthor | undefined,
  ) {
    const issues: WorkflowDiagnostic[] = [];
    const next = definition.bot ?? null;
    if (author?.kind === "bot") {
      const before = yield* boundBot(definition.id);
      const own = (bot: string | null) => bot === null || bot === author.id;
      if (!own(before) || !own(next))
        issues.push({
          path: "bot",
          code: "bot",
          message:
            before !== null && !own(before)
              ? `This workflow works for bot ${before}; only that bot or the owner can change its bot.`
              : `A bot can only bind a workflow to itself: use bot: ${author.id} or leave bot out.`,
        });
    }
    if (next !== null && Option.isSome(bots)) {
      const found = isBotId(next) ? yield* bots.value.getBot(next) : Option.none();
      if (Option.isNone(found))
        issues.push({ path: "bot", code: "bot", message: `There is no bot ${next}.` });
    }
    return issues;
  });
  const validate = Effect.fn("WorkflowDefinitions.validate")(function* (
    input: WorkflowValidateInput,
    author?: WorkflowAuthor,
  ) {
    yield* refreshGraph().pipe(Effect.mapError(internal));
    const result = compile(input);
    if (Result.isFailure(result))
      return { diagnostics: result.failure, normalizedSource: null, semanticHash: null };
    const binding = yield* bindingIssues(result.success.definition, author).pipe(
      Effect.mapError(internal),
    );
    if (binding.length > 0)
      return { diagnostics: binding, normalizedSource: null, semanticHash: null };
    const normalizedSource = toCanonicalYaml(result.success.definition);
    const again = compile({ source: normalizedSource });
    if (Result.isFailure(again) || again.success.hash !== result.success.hash)
      return yield* internal("Canonical hash mismatch");
    return { diagnostics: [], normalizedSource, semanticHash: result.success.hash };
  });
  const lastFired = journal.triggerLastFired.pipe(
    Effect.map(
      (rows) =>
        new Map(rows.map((row) => [JSON.stringify([row.workflowId, row.triggerId]), row.at])),
    ),
  );
  const document = Effect.fn("WorkflowDefinitions.document")(function* (
    id: string,
    fired?: ReadonlyMap<string, string>,
  ) {
    const samples = fired ?? (yield* lastFired);
    const file = yield* repo.read(id);
    if (Option.isNone(file))
      return yield* new WorkflowsError({ code: "not-found", message: "Workflow not found." });
    const head = Option.getOrNull(yield* repo.head(id));
    const result = compileFile(id, file.value.text);
    const definition = Result.isSuccess(result) ? result.success.definition : null;
    const { enabled, suspended, off } = yield* status(id);
    const hasWebhook = Object.values(definition?.triggers ?? {}).some((t) => t.kind === "webhook");
    return {
      workflowId: workflowId(id),
      source: file.value.text,
      revision: revision(file.value.revision),
      headCommit: head?.commit ?? null,
      definition,
      hash: Result.isSuccess(result) ? result.success.hash : null,
      valid: Result.isSuccess(result),
      dirty: head?.revision !== file.value.revision,
      diagnostics: Result.isFailure(result) ? result.failure : [],
      enabled,
      suspended,
      triggers: triggerSummaries(
        id,
        definition?.triggers,
        hasWebhook ? yield* webhookUrls : new Map<string, string>(),
        off,
        samples,
      ),
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
        triggers_json: JSON.stringify(d.definition?.triggers ?? {}),
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
    enabled: boolean,
    by: string,
    key: string,
  ) {
    yield* journal.append([
      {
        stream: workflowStream(id),
        key,
        fact: { _tag: "Toggled", enabled, by, at: yield* now },
      },
    ]);
  });
  const ingestInternal = Effect.fn("WorkflowDefinitions.ingestInternal")(function* (
    id: string | undefined,
  ) {
    yield* refreshGraph();
    const indexed = new Map(
      (yield* store(Store.listIndex())).map((row) => [row.workflow_id, row] as const),
    );
    const ids = id
      ? [id]
      : [...new Set([...(yield* repo.listIds), ...(yield* repo.dirtyIds), ...indexed.keys()])];
    for (const current of ids) {
      const file = yield* repo.read(current);
      const head = Option.getOrNull(yield* repo.head(current));
      if (Option.isNone(file)) {
        // Removed by hand (still on HEAD), or a removal committed before a crash finished it.
        const lastWithFile = head
          ? head.commit
          : (yield* repo.deleted).find((entry) => entry.workflowId === current)?.commit;
        if (head)
          yield* repo.commit({
            workflowId: current,
            author: "Owner (hand edit)",
            message: "Hand edit",
          });
        if (lastWithFile !== undefined && (head || indexed.has(current))) {
          yield* toggle(current, false, "Owner (hand edit)", `toggled:deleted:${lastWithFile}`);
          yield* store(Store.deleteIndex(current));
          yield* PubSub.publish(bus, current);
        }
        continue;
      }
      const dirty = head?.revision !== file.value.revision;
      if (dirty && Result.isSuccess(compileFile(current, file.value.text)))
        yield* repo.commit({
          workflowId: current,
          author: "Owner (hand edit)",
          message: "Hand edit",
        });
      yield* index(current);
      const before = indexed.get(current);
      const after = (yield* store(Store.listIndex())).find((row) => row.workflow_id === current);
      if (
        dirty ||
        before === undefined ||
        before.head_commit !== after?.head_commit ||
        before.revision !== after?.revision ||
        before.valid !== after?.valid
      )
        yield* PubSub.publish(bus, current);
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
              const checked = yield* validate(prepared, author);
              if (checked.normalizedSource === null)
                return { _tag: "Invalid" as const, diagnostics: checked.diagnostics };
              const canonical = checked.normalizedSource;
              const reread = Option.getOrNull(yield* repo.read(id));
              if (file?.revision !== reread?.revision) continue;
              const by = author.kind === "user" ? "Owner" : `${author.name} (bot)`;
              const current = yield* status(id);
              if (current.enabled && (!file || (author.kind === "bot" && !author.canManageBots)))
                yield* toggle(id, false, by, `toggled:save-off:${current.toggledSeq}`);
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
    yield* refreshGraph();
    const lastRuns = yield* journal.lastRuns;
    const fired = yield* lastFired;
    const botNames = Option.isNone(bots)
      ? new Map<string, string>()
      : new Map((yield* bots.value.listBots).map((bot) => [bot.id as string, bot.name] as const));
    return yield* Effect.forEach(yield* repo.listIds, (id) =>
      document(id, fired).pipe(
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
          triggers: d.triggers,
          headCommit: d.headCommit,
          revision: d.revision,
          updatedAt: d.updatedAt,
          lastRun: lastRuns.get(id) ?? null,
          bot:
            d.definition?.bot === undefined
              ? null
              : { id: d.definition.bot, name: botNames.get(d.definition.bot) ?? null },
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
      // A run starting, stopping at a gate, pausing or ending moves the list's last run.
      const runChanges = yield* journal.subscribeRunChanges;
      const read = Effect.gen(function* () {
        const workflows = yield* list;
        const deleted = yield* Effect.forEach(yield* repo.deleted, (entry) =>
          Effect.gen(function* () {
            const source = Option.getOrNull(yield* repo.show(entry.workflowId, entry.commit));
            const parsed = source === null ? null : compile({ source });
            return {
              ...entry,
              workflowId: workflowId(entry.workflowId),
              title:
                parsed && Result.isSuccess(parsed)
                  ? parsed.success.definition.title
                  : entry.workflowId,
            };
          }),
        );
        const root = nodePath.join(import.meta.dirname, "..", "library");
        const templates: WorkflowsSnapshot["templates"][number][] = [];
        for (const file of (yield* fs.exists(root)) ? yield* fs.readDirectory(root) : []) {
          if (!file.endsWith(".workflow.yaml")) continue;
          const parsed = compile({ source: yield* fs.readFileString(nodePath.join(root, file)) });
          if (Result.isFailure(parsed)) continue;
          const definition = parsed.success.definition;
          templates.push({
            templateId: workflowId(file.replace(/\.workflow\.yaml$/, "")),
            title: definition.title,
            description: definition.description ?? null,
            triggers: triggerSummaries(definition.id, definition.triggers, new Map()),
          });
        }
        const runsRevision = yield* journal.runsRevision;
        const activeRuns = yield* journal.activeRuns;
        return { repoPath: repo.root, workflows, deleted, templates, runsRevision, activeRuns };
      }).pipe(Effect.mapError(internal));
      // A webhook task appears after the save that asked for it, so its URL arrives as a change
      // too. The list's first emission is kept: it covers a task added during the first read.
      const taskChanges = Option.isNone(scheduledTasks)
        ? Stream.empty
        : scheduledTasks.value.subscribeList().pipe(Stream.orElseSucceed(() => undefined));
      return Stream.concat(
        Stream.fromEffect(read),
        Stream.fromSubscription(subscription).pipe(
          Stream.merge(Stream.fromSubscription(runChanges)),
          Stream.merge(taskChanges),
          // A burst of changes reads once: a read covers every change before it.
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.mapEffect(() => read),
        ),
      );
    }),
  );
  const summary = Effect.fn("WorkflowDefinitions.summary")(function* (id: string) {
    yield* document(id);
    const rows = yield* list;
    const row = rows.find((entry) => entry.workflowId === id);
    if (!row)
      return yield* new WorkflowsError({ code: "not-found", message: "Workflow not found." });
    return row;
  });
  const authorName = (author: WorkflowAuthor) =>
    author.kind === "user" ? "Owner" : `${author.name} (bot)`;
  const setEnabled = Effect.fn("WorkflowDefinitions.setEnabled")(function* (
    input: WorkflowSetEnabledInput,
    author: WorkflowAuthor,
  ) {
    if (author.kind === "bot" && !author.canManageBots)
      return yield* new WorkflowsError({ code: "permission", message: "Cannot manage workflows." });
    yield* document(input.workflowId);
    if (input.triggerId !== undefined) {
      const head = Option.getOrNull(yield* repo.head(input.workflowId));
      const source = head
        ? Option.getOrNull(yield* repo.show(input.workflowId, head.commit))
        : null;
      const compiled = source === null ? null : compileFile(input.workflowId, source);
      const triggers =
        compiled && Result.isSuccess(compiled) ? compiled.success.definition.triggers : undefined;
      const trigger =
        triggers && Object.hasOwn(triggers, input.triggerId)
          ? triggers[input.triggerId]
          : undefined;
      if (!trigger)
        return yield* new WorkflowsError({
          code: "not-found",
          message: `This workflow has no trigger ${input.triggerId}.`,
        });
      if (trigger.kind === "manual")
        return yield* new WorkflowsError({
          code: "invalid-request",
          message: "A manual trigger has no switch: Run now always works.",
        });
      yield* journal.append([
        {
          stream: workflowStream(input.workflowId),
          key: `trigger-toggled:${input.triggerId}:${input.clientRequestId}`,
          fact: {
            _tag: "TriggerToggled",
            triggerId: input.triggerId,
            enabled: input.enabled,
            by: authorName(author),
            at: yield* now,
          },
        },
      ]);
    } else
      yield* toggle(
        input.workflowId,
        input.enabled,
        authorName(author),
        `toggled:${input.clientRequestId}`,
      );
    yield* PubSub.publish(bus, input.workflowId);
    return yield* summary(input.workflowId);
  }, Effect.mapError(internal));
  const remove = Effect.fn("WorkflowDefinitions.delete")(
    (input: WorkflowDeleteInput, author: WorkflowAuthor) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* document(input.workflowId);
            const commit = yield* repo.remove({
              workflowId: input.workflowId,
              author: authorName(author),
              message: `Delete ${input.workflowId}`,
            });
            // Keyed by the last commit with the file, which ingestion can find again after a crash.
            yield* toggle(
              input.workflowId,
              false,
              authorName(author),
              `toggled:deleted:${current.headCommit ?? commit}`,
            );
            yield* store(Store.deleteIndex(input.workflowId));
            yield* PubSub.publish(bus, input.workflowId);
            return { workflowId: input.workflowId, commit };
          }),
        )
        .pipe(Effect.mapError(internal)),
  );
  const restore = Effect.fn("WorkflowDefinitions.restore")(
    (input: WorkflowRestoreInput, author: WorkflowAuthor) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (Option.isSome(yield* repo.read(input.workflowId)))
              return yield* new WorkflowsError({
                code: "invalid-request",
                message: "Workflow already exists.",
              });
            const deleted = (yield* repo.deleted).find(
              (entry) => entry.workflowId === input.workflowId,
            );
            const source = deleted
              ? Option.getOrNull(yield* repo.show(input.workflowId, deleted.commit))
              : null;
            if (source === null)
              return yield* new WorkflowsError({
                code: "not-found",
                message: "Workflow not found.",
              });
            yield* repo.writeAtomic(input.workflowId, source);
            yield* repo.commit({
              workflowId: input.workflowId,
              author: authorName(author),
              message: `Restore ${input.workflowId}`,
            });
            yield* index(input.workflowId);
            yield* PubSub.publish(bus, input.workflowId);
            return yield* summary(input.workflowId);
          }),
        )
        .pipe(Effect.mapError(internal)),
  );
  const history = Effect.fn("WorkflowDefinitions.history")(function* (input: WorkflowHistoryInput) {
    const skip = Number(input.cursor ?? 0);
    const limit = input.limit ?? 50;
    const commits = yield* repo.log(input.workflowId, { skip, limit: limit + 1 });
    if (commits.length === 0 && skip === 0)
      return yield* new WorkflowsError({ code: "not-found", message: "Workflow not found." });
    const versions: WorkflowHistoryPage["versions"][number][] = [];
    for (const entry of commits.slice(0, limit)) {
      const stored = yield* store(Store.getVersion(input.workflowId, entry.commit));
      const source =
        stored?.source ?? Option.getOrNull(yield* repo.show(input.workflowId, entry.commit));
      if (source === null) continue;
      const compiled = compile({ source });
      if (Result.isFailure(compiled)) continue;
      versions.push({ ...entry, revision: revision(entry.revision), hash: compiled.success.hash });
    }
    return { versions, nextCursor: commits.length > limit ? String(skip + limit) : null };
  }, Effect.mapError(internal));
  const template = Effect.fn("WorkflowDefinitions.template")(function* (templateId: string) {
    const path = nodePath.join(import.meta.dirname, "..", "library", `${templateId}.workflow.yaml`);
    if (!WORKFLOW_ID.test(templateId) || !(yield* fs.exists(path)))
      return yield* new WorkflowsError({ code: "not-found", message: "Template not found." });
    return yield* fs.readFileString(path);
  }, Effect.mapError(internal));
  const fromTemplate = Effect.fn("WorkflowDefinitions.fromTemplate")(function* (
    input: WorkflowFromTemplateInput,
    author: WorkflowAuthor,
  ) {
    const parsed = compile({ source: yield* template(input.templateId) });
    if (Result.isFailure(parsed)) return yield* internal(parsed.failure);
    return yield* save(
      {
        source: stringify({ ...parsed.success.definition, id: input.workflowId }),
        workflowId: input.workflowId,
        message: `From template ${input.templateId}`,
      },
      author,
    );
  }, Effect.mapError(internal));
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
    template,
    fromTemplate,
    setEnabled,
    botEntries: Effect.fn("WorkflowDefinitions.botEntries")(function* (botId: string) {
      const fired = yield* lastFired;
      const entries: BotEntry[] = [];
      for (const id of [...(yield* repo.listIds)].sort()) {
        const d = yield* document(id, fired);
        // A dirty file is not the version that runs; only a committed, valid HEAD is offered.
        if (!d.valid || d.dirty || d.definition === null) continue;
        for (const [triggerId, trigger] of Object.entries(d.definition.triggers ?? {})) {
          if (
            trigger.kind !== "bot" ||
            (trigger.bots !== undefined && !trigger.bots.includes(botId))
          )
            continue;
          entries.push({
            workflowId: id,
            triggerId,
            description: trigger.description,
            params: d.definition.params ?? {},
            on:
              d.enabled &&
              !d.suspended &&
              d.triggers.some((summary) => summary.id === triggerId && summary.enabled),
          });
        }
      }
      return entries;
    }, Effect.mapError(internal)),
    delete: remove,
    restore,
    history,
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
