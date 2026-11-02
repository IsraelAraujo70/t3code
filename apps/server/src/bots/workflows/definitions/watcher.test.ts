import { WorkflowsError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { WorkflowDefinitions } from "./WorkflowDefinitions.ts";
import * as Watcher from "./watcher.ts";

it.effect("rescans periodically after an ingestion failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repoPath = yield* fs.makeTempDirectoryScoped();
      const calls = yield* Ref.make<Array<string | undefined>>([]);
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const unavailable = () =>
        Effect.fail(new WorkflowsError({ code: "unavailable", message: "Unavailable." }));
      const definitions = WorkflowDefinitions.of({
        repoPath,
        snapshot: Stream.empty,
        changes: Stream.empty,
        list: Effect.succeed([]),
        document: unavailable,
        documentChanges: () => Stream.empty,
        validate: unavailable,
        save: unavailable,
        template: unavailable,
        fromTemplate: unavailable,
        setEnabled: unavailable,
        botEntries: unavailable,
        delete: unavailable,
        restore: unavailable,
        history: unavailable,
        ingest: (id) =>
          Effect.gen(function* () {
            const next = yield* Ref.updateAndGet(calls, (values) => [...values, id]);
            yield* Deferred.succeed(next.length === 1 ? first : second, undefined);
            if (next.length === 1)
              return yield* new WorkflowsError({ code: "internal", message: "Failed." });
          }),
      });
      yield* Layer.build(
        Watcher.layer.pipe(Layer.provide(Layer.succeed(WorkflowDefinitions, definitions))),
      );
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(first);
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(second);
      expect(yield* Ref.get(calls)).toEqual([undefined, undefined]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
