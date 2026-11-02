import { handlers } from "./handlers.ts";
import { WORKFLOWS_WS_METHODS as M } from "@t3tools/contracts";
// @effect-diagnostics schemaSyncInEffect:off - Test fixtures use fixed valid identifiers.
import * as Context from "effect/Context";
import { WorkflowId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../../config.ts";
import * as BotsDb from "../../BotsDb.ts";
import * as Journal from "../Journal.ts";
import { layer, WorkflowDefinitions } from "../definitions/WorkflowDefinitions.ts";

const decodeId = Schema.decodeSync(WorkflowId);

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

it.live("saves owner definitions and streams their committed document", () =>
  withDefinitions((definitions) =>
    Effect.gen(function* () {
      const rpc = yield* handlers.pipe(Effect.provideService(WorkflowDefinitions, definitions));
      const id = decodeId("rpc-copy");
      yield* definitions.fromTemplate(
        { templateId: decodeId("mcp-token-cut"), workflowId: id },
        { kind: "user" },
      );
      const original = yield* definitions.document(id);
      const saved = yield* rpc[M.workflowsSave]({
        workflowId: id,
        source: original.source,
        baseRevision: original.revision,
        message: "RPC save",
      });
      expect(saved).toMatchObject({ _tag: "Saved", enabled: true });
      expect((yield* definitions.history({ workflowId: id })).versions[0]?.author).toBe("Owner");
      expect(
        (yield* rpc[M.workflowsSubscribe]().pipe(Stream.take(1), Stream.runCollect))[0]?.workflows,
      ).toHaveLength(1);
      expect(
        (yield* rpc[M.workflowsDocumentSubscribe]({ workflowId: id }).pipe(
          Stream.take(1),
          Stream.runCollect,
        ))[0]?.workflowId,
      ).toBe(id);
      expect(yield* rpc[M.workflowsRunStart]().pipe(Effect.flip)).toMatchObject({
        code: "unavailable",
      });
    }),
  ),
);
