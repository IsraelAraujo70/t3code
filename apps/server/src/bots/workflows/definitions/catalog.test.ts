import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../../config.ts";
import * as BotsDb from "../../BotsDb.ts";
import * as Journal from "../Journal.ts";
import { layer, WorkflowDefinitions } from "./WorkflowDefinitions.ts";

import * as Catalog from "./catalog.ts";
import { WorkflowCatalog } from "../Catalog.ts";

it.live("rejects invalid disk state while preserving pinned versions", () =>
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
        const catalog = yield* WorkflowCatalog;
        expect(yield* catalog.current("absent")).toEqual({ _tag: "Missing" });
        for (const id of ["a", "b"]) {
          const subscriberSource = source
            .replaceAll("mcp-token-cut", id)
            .replace(
              /^triggers:.*$/m,
              `triggers: [{ id: failed, kind: workflowFailed${id === "b" ? ", workflow: c" : ""} }]`,
            );
          expect(
            (yield* definitions.save(
              { source: subscriberSource, message: "Subscriber" },
              { kind: "user" },
            ))._tag,
          ).toBe("Saved");
        }
        expect(yield* catalog.failureSubscribers("c")).toEqual([
          { workflowId: "a", triggerId: "failed", params: {} },
          { workflowId: "b", triggerId: "failed", params: {} },
        ]);
        expect(yield* catalog.failureSubscribers("a")).toEqual([]);
        const saved = yield* definitions.save({ source, message: "First" }, { kind: "user" });
        if (saved._tag !== "Saved") throw new Error("Save failed");
        const ready = yield* catalog.current(saved.workflowId);
        expect(ready).toMatchObject({
          _tag: "Ready",
          enabled: false,
          suspended: false,
          version: { commit: saved.commit },
        });
        const pinned = yield* catalog.pinned(saved.workflowId, saved.commit);
        yield* fs.writeFileString(
          `${definitions.repoPath}/${saved.workflowId}.workflow.yaml`,
          "nodes: [",
        );
        expect(yield* catalog.current(saved.workflowId)).toEqual({ _tag: "Invalid" });
        expect((yield* catalog.pinned(saved.workflowId, saved.commit)).compiled.hash).toBe(
          pinned.compiled.hash,
        );
      }).pipe(
        Effect.provide(
          Catalog.layer.pipe(
            Layer.provideMerge(
              layer.pipe(
                Layer.provideMerge(services),
                Layer.provide(ServerConfig.layerTest(root, root)),
              ),
            ),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
