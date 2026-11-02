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

it.live("saves canonical definitions and preserves conflicts on invalid hand edits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const source = yield* fs.readFileString(
        `${import.meta.dirname}/../library/mcp-token-cut.workflow.yaml`,
      );
      const db = BotsDb.layerMemory;
      const services = Layer.merge(db, Journal.layerFromDb.pipe(Layer.provide(db)));
      yield* Effect.gen(function* () {
        const definitions = yield* WorkflowDefinitions;
        const sql = yield* SqlClient.SqlClient;
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
        expect(yield* definitions.validate({ source: "nodes: [" })).toMatchObject({
          normalizedSource: null,
          semanticHash: null,
        });
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
        expect(
          (yield* sql`SELECT * FROM workflow_versions WHERE workflow_id=${first.workflowId}`)
            .length,
        ).toBeGreaterThan(0);
        const bot = yield* definitions.save(
          { source: source.replaceAll("mcp-token-cut", "bot-copy"), message: "Bot" },
          { kind: "bot", name: "Ralph", canManageBots: false },
        );
        expect(bot).toMatchObject({ _tag: "Saved", enabled: false });
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(services),
            Layer.provide(ServerConfig.layerTest(root, root)),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
