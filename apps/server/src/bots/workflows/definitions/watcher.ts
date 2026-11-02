import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Definitions from "./WorkflowDefinitions.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const definitions = yield* Definitions.WorkflowDefinitions;
    const fs = yield* FileSystem.FileSystem;
    const pending = new Map<string, Fiber.Fiber<void>>();
    const ingest = Effect.fn("WorkflowDefinitionsWatcher.ingest")((id?: string) =>
      definitions
        .ingest(id)
        .pipe(Effect.catch(() => Effect.logWarning("Workflow definitions ingestion failed."))),
    );
    yield* Effect.sleep("60 seconds").pipe(
      Effect.andThen(ingest().pipe(Effect.repeat(Schedule.spaced("60 seconds")))),
      Effect.forkScoped,
    );
    yield* fs.watch(definitions.repoPath).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const relative = event.path.startsWith(`${definitions.repoPath}/`)
            ? event.path.slice(definitions.repoPath.length + 1)
            : event.path;
          if (!/^[^/]+\.workflow\.yaml$/.test(relative)) return;
          const id = relative.slice(0, -".workflow.yaml".length);
          const previous = pending.get(id);
          if (previous) yield* Fiber.interrupt(previous);
          const fiber = yield* ingest(id).pipe(
            Effect.delay("2 seconds"),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id);
              }),
            ),
            Effect.forkScoped,
          );
          pending.set(id, fiber);
        }),
      ),
      Effect.catch(() => Effect.logWarning("Workflow definitions watcher failed.")),
      Effect.forkScoped,
    );
  }),
);
