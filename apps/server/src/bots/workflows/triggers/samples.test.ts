import { WorkflowDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkflowDefinitions } from "../definitions/WorkflowDefinitions.ts";
import { Journal, layerMemory } from "../Journal.ts";
import { TriggerSamples, layer, LISTEN_WINDOW_MS } from "./samples.ts";

it.effect("acknowledges durable test delivery replays without a listener", () =>
  Effect.gen(function* () {
    const samples = yield* TriggerSamples;
    const journal = yield* Journal;
    const input = {
      workflowId: "inbox",
      triggerId: "push",
      deliveryId: "test",
      payload: { ref: "main" },
    };
    assert.equal(LISTEN_WINDOW_MS, 120_000);
    assert.equal(yield* samples.capture(input), "fire");
    yield* journal.captureTestDelivery(input);
    assert.equal(yield* samples.capture(input), "replayed");
    assert.deepEqual(yield* journal.read("workflow:inbox", 0), []);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(Layer.mock(WorkflowDefinitions)({ repoPath: "/unused" })),
        Layer.provideMerge(layerMemory),
      ),
    ),
  ),
);

const decodeDocument = Schema.decodeSync(WorkflowDocument);

const definitions = Layer.mock(WorkflowDefinitions)({
  repoPath: "/unused",
  document: () =>
    Effect.succeed(
      decodeDocument({
        workflowId: "inbox",
        source: "",
        definition: null,
        revision: "a".repeat(40),
        headCommit: null,
        hash: null,
        valid: true,
        dirty: false,
        diagnostics: [],
        enabled: true,
        suspended: false,
        triggers: [
          {
            id: "push",
            kind: "webhook",
            title: null,
            label: "push",
            webhookUrl: "https://example.com/hook",
            enabled: true,
            lastFiredAt: null,
          },
        ],
        updatedBy: null,
        updatedAt: null,
      }),
    ),
});
const testLayer = layer.pipe(Layer.provide(definitions), Layer.provideMerge(layerMemory));
it.effect("captures for both listeners, expires and removes interrupted listeners", () =>
  Effect.gen(function* () {
    const samples = yield* TriggerSamples;
    const journal = yield* Journal;
    const ready = yield* Deferred.make<void>();
    const ready2 = yield* Deferred.make<void>();
    const listen = (signal: Deferred.Deferred<void>) =>
      samples.listen("inbox", "push").pipe(
        Stream.tap((event) =>
          event._tag === "Listening" ? Deferred.succeed(signal, undefined) : Effect.void,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
    const first = yield* listen(ready);
    const second = yield* listen(ready2);
    yield* Deferred.await(ready);
    yield* Deferred.await(ready2);
    const input = {
      workflowId: "inbox",
      triggerId: "push",
      deliveryId: "captured",
      payload: { ref: "main" },
    };
    assert.equal(yield* samples.capture(input), "captured");
    const events = yield* Fiber.join(first);
    assert.equal(events[0]?._tag, "Listening");
    assert.equal(events[1]?._tag, "Captured");
    if (events[1]?._tag === "Captured") assert.deepEqual(events[1].sample.payload, input.payload);
    assert.deepEqual(yield* Fiber.join(second), events);
    assert.equal(yield* samples.capture(input), "replayed");
    assert.deepEqual(yield* journal.read("workflow:inbox", 0), []);
    const expiryReady = yield* Deferred.make<void>();
    const expiry = yield* listen(expiryReady);
    yield* Deferred.await(expiryReady);
    yield* TestClock.adjust(LISTEN_WINDOW_MS + 1);
    assert.equal((yield* Fiber.join(expiry))[1]?._tag, "Expired");
    const stopReady = yield* Deferred.make<void>();
    const stopped = yield* listen(stopReady);
    yield* Deferred.await(stopReady);
    yield* Fiber.interrupt(stopped);
    assert.equal(yield* samples.capture({ ...input, deliveryId: "normal" }), "fire");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
