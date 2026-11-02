// @effect-diagnostics schemaSyncInEffect:off - Test fixtures use fixed valid identifiers.
import { workflowStream } from "../facts.ts";
import * as Context from "effect/Context";
import { WorkflowSetEnabledInput, WorkflowId } from "@t3tools/contracts";
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
import { ServerConfig } from "../../../config.ts";
import * as BotsDb from "../../BotsDb.ts";
import * as Journal from "../Journal.ts";
import { layer, WorkflowDefinitions } from "./WorkflowDefinitions.ts";

const decodeId = Schema.decodeSync(WorkflowId);
const decodeToggle = Schema.decodeSync(WorkflowSetEnabledInput);

const withDefinitions = <E>(
  run: (
    definitions: Context.Service.Shape<typeof WorkflowDefinitions>,
  ) => Effect.Effect<void, E, Journal.Journal | FileSystem.FileSystem | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const db = BotsDb.layerMemory;
      const services = Layer.merge(db, Journal.layerFromDb.pipe(Layer.provide(db)));
      yield* Effect.gen(function* () {
        yield* run(yield* WorkflowDefinitions);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(services),
            Layer.provide(ServerConfig.layerTest(root, root)),
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
          },
          workflowId: id,
          baseRevision: active.revision,
          message: "Bot edit",
        },
        { kind: "bot", name: "Bot", canManageBots: false },
      );
      expect(botSaved).toMatchObject({ _tag: "Saved", enabled: false });
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
      expect(first.enabled).toBe(true);
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
      expect(first.enabled).toBe(true);
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
      expect(first.enabled).toBe(true);
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
      expect(first.enabled).toBe(true);
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
      expect(first.enabled).toBe(true);
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
      expect(first.enabled).toBe(true);
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
