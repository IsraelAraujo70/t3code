// @effect-diagnostics schemaSyncInEffect:off - Test fixtures use fixed valid identifiers.
import { workflowStream } from "../facts.ts";
import * as Context from "effect/Context";
import {
  WorkflowSetEnabledInput,
  WorkflowId,
  WorkflowRunId,
  type WorkflowRunSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { workflowStatus } from "../workflowStatus.ts";
import type { ScheduledTask } from "@t3tools/contracts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { ServerConfig } from "../../../config.ts";
import * as BotsDb from "../../BotsDb.ts";
import * as Journal from "../Journal.ts";
import { layer, WorkflowDefinitions } from "./WorkflowDefinitions.ts";

const decodeId = Schema.decodeSync(WorkflowId);
const decodeToggle = Schema.decodeSync(WorkflowSetEnabledInput);

type Definitions = Context.Service.Shape<typeof WorkflowDefinitions>;

interface Harness {
  /** A second service over the same repository and database, as after a server restart. */
  readonly restart: Effect.Effect<Definitions>;
  /** git in the definitions repository, outside the service (a hand commit, a pull). */
  readonly git: (...args: ReadonlyArray<string>) => Effect.Effect<string>;
}

const withDefinitions = <E>(
  run: (
    definitions: Definitions,
    harness: Harness,
  ) => Effect.Effect<void, E, Journal.Journal | FileSystem.FileSystem | SqlClient.SqlClient>,
  /** Services the definitions read when present, such as the scheduled-task service. */
  extra: Layer.Layer<never> = Layer.empty,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const db = BotsDb.layerMemory;
      const services = Layer.merge(db, Journal.layerFromDb.pipe(Layer.provide(db)));
      const instance = layer.pipe(
        Layer.provide(ServerConfig.layerTest(root, root)),
        Layer.provide(extra),
      );
      yield* Effect.gen(function* () {
        const definitions = yield* WorkflowDefinitions;
        const context = yield* Effect.context<
          | Journal.Journal
          | SqlClient.SqlClient
          | FileSystem.FileSystem
          | Path.Path
          | ChildProcessSpawner.ChildProcessSpawner
        >();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* run(definitions, {
          restart: WorkflowDefinitions.pipe(
            Effect.provide(Layer.fresh(instance)),
            Effect.provideContext(context),
            Effect.orDie,
          ),
          git: (...args) =>
            spawner
              .string(
                ChildProcess.make(
                  "git",
                  ["-c", "user.name=Hand", "-c", "user.email=hand@example.com", ...args],
                  { cwd: definitions.repoPath },
                ),
              )
              .pipe(Effect.orDie),
        });
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(services),
            Layer.provide(ServerConfig.layerTest(root, root)),
            Layer.provide(extra),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.live("copies templates and restores deleted workflows disabled", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const id = decodeId("my-cut");
      expect(
        (yield* definitions.fromTemplate(
          { templateId: decodeId("mcp-token-cut"), workflowId: id },
          { kind: "user" },
        ))._tag,
      ).toBe("Saved");
      expect((yield* definitions.document(id)).definition?.id).toBe(id);
      yield* definitions.delete({ workflowId: id }, { kind: "user" });
      expect(yield* definitions.list).toHaveLength(0);
      const snapshot = yield* definitions.snapshot.pipe(Stream.take(1), Stream.runCollect);
      expect(snapshot[0]?.deleted).toHaveLength(1);
      expect(snapshot[0]?.templates).toHaveLength(4);
      expect(yield* definitions.restore({ workflowId: id }, { kind: "user" })).toMatchObject({
        enabled: false,
      });
      expect(
        yield* definitions.restore({ workflowId: id }, { kind: "user" }).pipe(Effect.flip),
      ).toMatchObject({ code: "invalid-request" });
    }),
  ),
);

it.live("checks toggle permission and paginates committed history", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const id = decodeId("history-copy");
      yield* definitions.fromTemplate(
        { templateId: decodeId("mcp-token-cut"), workflowId: id },
        { kind: "user" },
      );
      const input = decodeToggle({ workflowId: id, enabled: true, clientRequestId: "toggle-test" });
      expect(
        yield* definitions
          .setEnabled(input, { kind: "bot", name: "Bot", canManageBots: false })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "permission" });
      expect(yield* definitions.setEnabled(input, { kind: "user" })).toMatchObject({
        enabled: true,
      });
      const journal = yield* Journal.Journal;
      const count = (yield* journal.read(workflowStream(id))).length;
      yield* definitions.setEnabled(input, { kind: "user" });
      expect((yield* journal.read(workflowStream(id))).length).toBe(count);
      const active = yield* definitions.document(id);
      if (!active.definition) throw new Error("Expected definition");
      const botSaved = yield* definitions.save(
        {
          definition: {
            ...active.definition,
            title: "Bot edit",
            triggers: {},
          },
          workflowId: id,
          baseRevision: active.revision,
          message: "Bot edit",
        },
        { kind: "bot", name: "Bot", canManageBots: false },
      );
      expect(botSaved).toMatchObject({ _tag: "Saved", enabled: false });
      // Turned back on, the same content saved again by the bot (same commit) turns it off again.
      yield* definitions.setEnabled(
        decodeToggle({ workflowId: id, enabled: true, clientRequestId: "toggle-again" }),
        { kind: "user" },
      );
      const unchanged = yield* definitions.document(id);
      if (!unchanged.definition) throw new Error("Expected definition");
      expect(
        yield* definitions.save(
          {
            definition: unchanged.definition,
            workflowId: id,
            baseRevision: unchanged.revision,
            message: "Bot edit again",
          },
          { kind: "bot", name: "Bot", canManageBots: false },
        ),
      ).toMatchObject({ _tag: "Saved", enabled: false });
      for (const title of ["Second", "Third"]) {
        const doc = yield* definitions.document(id);
        if (!doc.definition) throw new Error("Expected definition");
        yield* definitions.save(
          {
            definition: { ...doc.definition, title },
            workflowId: id,
            baseRevision: doc.revision,
            message: title,
          },
          { kind: "user" },
        );
      }
      const page = yield* definitions.history({ workflowId: id, limit: 2 });
      expect(page.versions).toHaveLength(2);
      expect(page.versions[0]?.message).toBe("Third");
      expect(page.versions.every((version) => version.hash.length > 0)).toBe(true);
      expect(page.nextCursor).toBe("2");
      expect(
        (yield* definitions.history({ workflowId: id, cursor: page.nextCursor ?? undefined }))
          .versions,
      ).toHaveLength(2);
    }),
  ),
);

it.live("disables bot edits before a failed version index", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const id = decodeId("failed-bot-index");
      yield* definitions.fromTemplate(
        { templateId: decodeId("mcp-token-cut"), workflowId: id },
        { kind: "user" },
      );
      yield* definitions.setEnabled(
        decodeToggle({ workflowId: id, enabled: true, clientRequestId: "enable-failure-test" }),
        { kind: "user" },
      );
      const doc = yield* definitions.document(id);
      if (!doc.definition) throw new Error("Expected definition");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_bot_version BEFORE INSERT ON workflow_versions
        WHEN NEW.author LIKE '%(bot)'
        BEGIN SELECT RAISE(ABORT, 'injected'); END`;
      yield* definitions
        .save(
          {
            workflowId: id,
            definition: { ...doc.definition, title: "Bot version" },
            baseRevision: doc.revision,
            message: "Bot version",
          },
          { kind: "bot", name: "Bot", canManageBots: false },
        )
        .pipe(Effect.flip);
      const journal = yield* Journal.Journal;
      expect(workflowStatus(yield* journal.read(workflowStream(id))).enabled).toBe(false);
    }),
  ),
);

it.live("saves canonical source without duplicate commits", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const first = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      expect(first._tag).toBe("Saved");
      if (first._tag !== "Saved") return;
      expect(first.enabled).toBe(false);
      const doc = yield* definitions.document(first.workflowId);
      expect(
        yield* fs.readFileString(`${definitions.repoPath}/${first.workflowId}.workflow.yaml`),
      ).toBe(doc.source);
      const same = yield* definitions.save(
        { source: doc.source, baseRevision: doc.revision, message: "Same" },
        { kind: "user" },
      );
      expect(same).toMatchObject({ commit: first.commit });
      expect(
        (yield* sql`SELECT * FROM workflow_versions WHERE workflow_id=${first.workflowId}`).length,
      ).toBeGreaterThan(0);
    }),
  ),
);

it.live("preserves and repairs invalid hand edits", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const first = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      expect(first._tag).toBe("Saved");
      if (first._tag !== "Saved") return;
      expect(first.enabled).toBe(false);
      const doc = yield* definitions.document(first.workflowId);
      expect(
        yield* fs.readFileString(`${definitions.repoPath}/${first.workflowId}.workflow.yaml`),
      ).toBe(doc.source);
      yield* fs.writeFileString(
        `${definitions.repoPath}/${first.workflowId}.workflow.yaml`,
        "nodes: [",
      );
      const conflict = yield* definitions.save(
        {
          source: doc.source,
          workflowId: first.workflowId,
          baseRevision: doc.revision,
          message: "Conflict",
        },
        { kind: "user" },
      );
      expect(conflict).toMatchObject({
        _tag: "Conflict",
        current: { source: "nodes: [", valid: false },
      });
      if (conflict._tag !== "Conflict") return;
      expect(
        (yield* definitions.save(
          { source: doc.source, baseRevision: conflict.current.revision, message: "Repair" },
          { kind: "user" },
        ))._tag,
      ).toBe("Saved");
    }),
  ),
);

it.live("returns validation diagnostics", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const first = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      expect(first._tag).toBe("Saved");
      if (first._tag !== "Saved") return;
      expect(first.enabled).toBe(false);
      const doc = yield* definitions.document(first.workflowId);
      expect(
        yield* fs.readFileString(`${definitions.repoPath}/${first.workflowId}.workflow.yaml`),
      ).toBe(doc.source);
      expect(yield* definitions.validate({ source: "nodes: [" })).toMatchObject({
        normalizedSource: null,
        semanticHash: null,
      });
    }),
  ),
);

it.live("ingests hand edits and emits documents", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const first = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      expect(first._tag).toBe("Saved");
      if (first._tag !== "Saved") return;
      expect(first.enabled).toBe(false);
      const doc = yield* definitions.document(first.workflowId);
      expect(
        yield* fs.readFileString(`${definitions.repoPath}/${first.workflowId}.workflow.yaml`),
      ).toBe(doc.source);
      const ready = yield* Deferred.make<void>();
      const stream = yield* definitions.documentChanges(first.workflowId).pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* fs.writeFileString(
        `${definitions.repoPath}/${first.workflowId}.workflow.yaml`,
        doc.source.replace("title:", "description: hand edit\ntitle:"),
      );
      yield* definitions.ingest(first.workflowId);
      const documents = yield* Fiber.join(stream);
      expect(documents[1]).toMatchObject({ dirty: false, updatedBy: "Owner (hand edit)" });
    }),
  ),
);

it.live("rejects stale canvas edits", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const first = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      expect(first._tag).toBe("Saved");
      if (first._tag !== "Saved") return;
      expect(first.enabled).toBe(false);
      const doc = yield* definitions.document(first.workflowId);
      expect(
        yield* fs.readFileString(`${definitions.repoPath}/${first.workflowId}.workflow.yaml`),
      ).toBe(doc.source);
      const current = yield* definitions.document(first.workflowId);
      if (!current.definition) throw new Error("Expected valid definition");
      const layout = { positions: {}, annotations: [] };
      expect(
        (yield* definitions.save(
          {
            definition: current.definition,
            canvas: layout,
            baseRevision: current.revision,
            message: "Layout",
          },
          { kind: "user" },
        ))._tag,
      ).toBe("Saved");
      expect(
        (yield* definitions.save(
          {
            definition: current.definition,
            canvas: { ...layout, positions: { entry: { x: 1, y: 2 } } },
            baseRevision: current.revision,
            message: "Stale layout",
          },
          { kind: "user" },
        ))._tag,
      ).toBe("Conflict");
    }),
  ),
);

it.live("creates bot workflows disabled", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const first = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      expect(first._tag).toBe("Saved");
      if (first._tag !== "Saved") return;
      expect(first.enabled).toBe(false);
      const doc = yield* definitions.document(first.workflowId);
      expect(
        yield* fs.readFileString(`${definitions.repoPath}/${first.workflowId}.workflow.yaml`),
      ).toBe(doc.source);
      const bot = yield* definitions.save(
        { source: source.replaceAll("mcp-token-cut", "bot-copy"), message: "Bot" },
        { kind: "bot", name: "Ralph", canManageBots: false },
      );
      expect(bot).toMatchObject({ _tag: "Saved", enabled: false });
    }),
  ),
);

it.live("reads a library template by id and refuses anything else", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      expect(yield* definitions.template("mcp-token-cut")).toContain("id: mcp-token-cut");
      for (const id of ["missing-one", "../definitions/x", "MCP-TOKEN-CUT"]) {
        expect((yield* Effect.flip(definitions.template(id))).code).toBe("not-found");
      }
    }),
  ),
);

const librarySource = (id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(
      `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
    );
    return source.replaceAll("mcp-token-cut", id);
  });

it.live("a workflow that calls a saved one stays valid after a restart", () =>
  withDefinitions((definitions, harness) =>
    Effect.gen(function* () {
      yield* definitions.save(
        {
          source: (yield* librarySource("b")).replace(
            /^triggers:.*$/m,
            "triggers: { callable: { kind: call } }",
          ),
          message: "b",
        },
        { kind: "user" },
      );
      const callee = (yield* definitions.document("b")).definition!;
      const caller = {
        ...callee,
        id: "a",
        nodes: { ...callee.nodes, again: { kind: "call" as const, workflow: "b", params: {} } },
        edges: [
          ...callee.edges.filter((edge) => edge !== "review:stuck -> stuck"),
          "review:stuck -> again",
          "again -> stuck",
        ],
      };
      const saved = yield* definitions.save({ definition: caller, message: "a" }, { kind: "user" });
      expect(saved).toMatchObject({ _tag: "Saved" });
      const restarted = yield* harness.restart;
      expect(yield* restarted.document("a")).toMatchObject({ valid: true, diagnostics: [] });
    }),
  ),
);

it.live("a commit made outside the service reaches document subscribers", () =>
  withDefinitions((definitions, harness) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const saved = yield* definitions.save(
        { source: yield* librarySource("pulled"), message: "first" },
        { kind: "user" },
      );
      expect(saved._tag).toBe("Saved");
      const ready = yield* Deferred.make<void>();
      const stream = yield* definitions.documentChanges("pulled").pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      const file = `${definitions.repoPath}/pulled.workflow.yaml`;
      const edited = (yield* fs.readFileString(file)).replace(
        "title:",
        "description: pulled\ntitle:",
      );
      yield* fs.writeFileString(file, edited);
      yield* harness.git("add", "pulled.workflow.yaml");
      yield* harness.git("commit", "-m", "pulled from elsewhere");
      yield* definitions.ingest("pulled");
      const documents = yield* Fiber.join(stream);
      expect(documents[1]).toMatchObject({ source: edited, dirty: false, valid: true });
    }),
  ),
);

it.live("a removal committed before a crash still turns the workflow off", () =>
  withDefinitions((definitions, harness) =>
    Effect.gen(function* () {
      yield* definitions.save(
        { source: yield* librarySource("gone"), message: "first" },
        { kind: "user" },
      );
      const journal = yield* Journal.Journal;
      const statusOf = journal
        .read(workflowStream("gone"))
        .pipe(Effect.map((facts) => workflowStatus(facts).enabled));
      yield* definitions.setEnabled(
        decodeToggle({
          workflowId: decodeId("gone"),
          enabled: true,
          clientRequestId: "enable-gone",
        }),
        { kind: "user" },
      );
      expect(yield* statusOf).toBe(true);
      // The removal commit lands; the service never got to record the switch.
      yield* harness.git("rm", "-q", "gone.workflow.yaml");
      yield* harness.git("commit", "-m", "remove");
      yield* definitions.ingest();
      expect(yield* statusOf).toBe(false);
      yield* definitions.restore({ workflowId: decodeId("gone") }, { kind: "user" });
      expect(yield* statusOf).toBe(false);
    }),
  ),
);

it.live("a hand edit whose id differs from its file name is invalid and never committed", () =>
  withDefinitions((definitions, harness) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* definitions.save(
        { source: yield* librarySource("a"), message: "a" },
        { kind: "user" },
      );
      const before = yield* harness.git("rev-parse", "HEAD");
      yield* fs.writeFileString(
        `${definitions.repoPath}/a.workflow.yaml`,
        yield* librarySource("b"),
      );
      yield* definitions.ingest("a");
      expect(yield* harness.git("rev-parse", "HEAD")).toBe(before);
      expect(yield* definitions.document("a")).toMatchObject({
        valid: false,
        diagnostics: [{ path: "id", code: "schema" }],
      });
    }),
  ),
);

it.live("a webhook trigger shows the URL of its scheduled task", () =>
  withDefinitions(
    (definitions) =>
      Effect.gen(function* () {
        const source = (yield* librarySource("inbox")).replace(
          /^triggers:.*$/m,
          "triggers: { push: { kind: webhook } }",
        );
        expect((yield* definitions.save({ source, message: "hook" }, { kind: "user" }))._tag).toBe(
          "Saved",
        );
        const [summary] = yield* definitions.list;
        expect(summary?.triggers).toEqual([
          {
            id: "push",
            kind: "webhook",
            title: null,
            label: "webhook",
            webhookUrl: "https://hooks.example.com/api/hooks/wf-hook%3Ainbox%3Apush/token",
            enabled: true,
            lastFiredAt: null,
          },
        ]);
      }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () =>
        Effect.succeed({
          tasks: [
            {
              id: "wf-hook:inbox:push",
              webhook: {
                path: "/api/hooks/wf-hook%3Ainbox%3Apush/token",
                url: "https://hooks.example.com/api/hooks/wf-hook%3Ainbox%3Apush/token",
                hasSecret: false,
              },
            } as unknown as ScheduledTask,
          ],
        }),
      subscribeList: () => Stream.empty,
    }),
  ),
);

it.live("shows each workflow's newest projected run as its last run", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const saved = yield* definitions.save({ source, message: "First" }, { kind: "user" });
      if (saved._tag !== "Saved") throw new Error("fixture");
      const journal = yield* Journal.Journal;
      const run = {
        runId: WorkflowRunId.make("wfr_00000000000000000001"),
        workflowId: saved.workflowId,
        title: "Corte",
        hash: null,
        commit: null,
        status: "failed",
        pausedFor: null,
        skipReason: null,
        trigger: { id: "manual", kind: "manual", label: "Manual" },
        startedAt: "2026-11-02T00:00:00.000Z",
        endedAt: "2026-11-02T00:10:00.000Z",
        outputStatus: null,
        stepsUsed: 1,
        cost: {
          billable: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          usage: "unavailable",
          usdEstimate: null,
        },
        reservedTokens: 0,
        openGates: 0,
        pullRequest: null,
        activeMs: null,
        activeSince: null,
      } satisfies WorkflowRunSummary;
      yield* journal.putRun({ summary: run, lastSeq: 9, pendingIntents: 0, parentRunId: null });
      const listed = (yield* definitions.list).find((d) => d.workflowId === saved.workflowId);
      expect(listed?.lastRun).toEqual(run);
    }),
  ),
);

it.live("switches individual triggers and exposes bot entries", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const id = decodeId("trigger-switches");
      yield* definitions.fromTemplate(
        { templateId: decodeId("mcp-token-cut"), workflowId: id },
        { kind: "user" },
      );
      const d = yield* definitions.document(id);
      if (!d.definition) throw new Error("Expected definition");
      expect(
        (yield* definitions.save(
          {
            workflowId: id,
            baseRevision: d.revision,
            message: "Triggers",
            definition: {
              ...d.definition,
              triggers: {
                first: { kind: "bot", description: "First" },
                other: { kind: "webhook" },
                manual: { kind: "manual" },
              },
            },
          },
          { kind: "user" },
        ))._tag,
      ).toBe("Saved");
      const input = decodeToggle({
        workflowId: id,
        triggerId: "first",
        enabled: false,
        clientRequestId: "off",
      });
      yield* definitions.setEnabled(input, { kind: "user" });
      const journal = yield* Journal.Journal;
      yield* journal.append([
        {
          stream: workflowStream(id),
          key: "fired:test",
          fact: {
            _tag: "TriggerFired",
            runId: "test",
            triggerId: "first",
            kind: "bot",
            occurrence: "test",
            label: "test",
            params: {},
            payload: null,
            causalDepth: 0,
            parent: null,
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      ]);
      expect(
        (yield* definitions.document(id)).triggers.find((t) => t.id === "first")?.lastFiredAt,
      ).toBe("2026-01-01T00:00:00.000Z");
      expect(
        (yield* definitions.list)[0]?.triggers.find((t) => t.id === "first")?.lastFiredAt,
      ).toBe("2026-01-01T00:00:00.000Z");
      const count = (yield* journal.read(workflowStream(id))).length;
      yield* definitions.setEnabled(input, { kind: "user" });
      expect((yield* journal.read(workflowStream(id))).length).toBe(count);
      for (const triggers of [
        (yield* definitions.document(id)).triggers,
        (yield* definitions.list)[0]!.triggers,
      ]) {
        expect(triggers.find((t) => t.id === "first")?.enabled).toBe(false);
        expect(triggers.find((t) => t.id === "other")?.enabled).toBe(true);
      }
      expect(yield* definitions.botEntries("mine")).toMatchObject([
        { triggerId: "first", on: false },
      ]);
      for (const [triggerId, code] of [
        ["missing", "not-found"],
        ["manual", "invalid-request"],
      ] as const) {
        expect(
          yield* definitions
            .setEnabled(decodeToggle({ ...input, triggerId }), { kind: "user" })
            .pipe(Effect.flip),
        ).toMatchObject({ code });
      }
      yield* definitions.setEnabled(
        decodeToggle({ ...input, enabled: true, clientRequestId: "on" }),
        { kind: "user" },
      );
      expect(
        (yield* definitions.document(id)).triggers.find((t) => t.id === "first")?.enabled,
      ).toBe(true);
      yield* definitions.setEnabled(
        decodeToggle({ workflowId: id, enabled: true, clientRequestId: "workflow-on" }),
        { kind: "user" },
      );
      const on = yield* definitions.document(id);
      expect(yield* definitions.botEntries("mine")).toEqual([
        {
          workflowId: id,
          triggerId: "first",
          description: "First",
          params: on.definition?.params ?? {},
          on: true,
        },
      ]);
      if (!on.definition) throw new Error("Expected definition");
      yield* definitions.save(
        {
          workflowId: id,
          baseRevision: on.revision,
          message: "Only another bot",
          definition: {
            ...on.definition,
            triggers: { first: { kind: "bot", description: "First", bots: ["someone"] } },
          },
        },
        { kind: "user" },
      );
      expect(yield* definitions.botEntries("mine")).toEqual([]);
      expect(yield* definitions.botEntries("someone")).toMatchObject([{ triggerId: "first" }]);
    }),
  ),
);
