import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import * as BotsDb from "../BotsDb.ts";
import { runStream, workflowStream } from "./facts.ts";
import { runIdFor } from "./ids.ts";
import { Journal, layerFromDb } from "./Journal.ts";
import { compile } from "./testkit/decideHarness.ts";
import { layerCatalog, makeFakeInterpreter } from "./testkit/fakeEngine.ts";
import { make } from "./WorkflowEngine.ts";

const twoSteps = compile({
  nodes: {
    plan: { kind: "agent", model: "$lead", prompt: "Plan", workspace: "integ", access: "write" },
    test: { kind: "command", argv: ["node", "check.ts"], cwd: "integ" },
    done: { kind: "output", status: "ready_for_review", value: {} },
  },
  edges: ["plan -> test", "test -> done"],
});

it.effect("runs a manual trigger to the end with one thread and one unit per key", () =>
  Effect.gen(function* () {
    const { fake, layer: interpreter } = yield* makeFakeInterpreter({});
    const journalLayer = layerFromDb.pipe(Layer.provide(BotsDb.layerMemory));
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const subscription = yield* journal.subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start({
        workflowId: "demo",
        triggerId: "manual",
        kind: "manual",
        occurrence: "manual:1",
        label: "Run now",
        params: {},
        payload: null,
        causalDepth: 0,
        parent: null,
      });
      const ended = yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (fact) => fact.stream === runStream(runId) && fact.fact._tag === "RunEnded",
        }),
      );
      assert.deepEqual(ended.fact._tag === "RunEnded" && ended.fact.status, "succeeded");
      const state = yield* engine.runState(runId);
      assert.deepEqual(state.output?.status, "ready_for_review");
      assert.deepEqual([...fake.threads.keys()], ["turn:plan@1"]);
      assert.deepEqual([...fake.units.keys()], ["unit:test@1"]);
      assert.isTrue([...fake.executions.values()].every((count) => count === 1));
      const again = yield* engine.start({
        workflowId: "demo",
        triggerId: "manual",
        kind: "manual",
        occurrence: "manual:1",
        label: "Run now",
        params: {},
        payload: null,
        causalDepth: 0,
        parent: null,
      });
      assert.deepEqual(again.runId, runId);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(journalLayer, interpreter, layerCatalog([twoSteps]))),
    );
  }),
);

const request = (occurrence: string) => ({
  workflowId: "demo",
  triggerId: "manual",
  kind: "manual",
  occurrence,
  label: "Run now",
  params: {},
  payload: null,
  causalDepth: 0,
  parent: null,
});

it.effect("promotes an orphan trigger only once across repeated ticks", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const subscription = yield* journal.subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      yield* journal.append([
        {
          stream: workflowStream("demo"),
          key: "manual:orphan",
          fact: {
            _tag: "TriggerFired",
            runId: runIdFor("demo", "manual:orphan"),
            ...request("manual:orphan"),
            at: "2026-11-02T00:00:00.000Z",
          },
        },
      ]);
      yield* engine.tick;
      yield* engine.tick;
      const ended = yield* PubSub.take(subscription).pipe(
        Effect.repeat({ until: (f) => f.fact._tag === "RunEnded" }),
      );
      assert.equal(ended.fact._tag === "RunEnded" && ended.fact.status, "succeeded");
      const workflow = yield* journal.read(workflowStream("demo"));
      assert.equal(workflow.filter((f) => f.key === "created:manual:orphan").length, 1);
      assert.equal(
        (yield* journal.read(ended.stream)).filter((f) => f.key === "started").length,
        1,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerFromDb, layer, layerCatalog([twoSteps]))),
    );
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect.each(["pending unit", "live turn"] as const)(
  "recovers a %s after restarting on the same database",
  (scenario) =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeFakeInterpreter({});
      if (scenario === "pending unit") fake.stall.add("unit:test@1");
      else yield* fake.hold("plan");
      const services = Layer.mergeAll(layerFromDb, layer, layerCatalog([twoSteps]));
      const runId = yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const subscription = yield* journal.subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        const { runId } = yield* engine.start(request("manual:restart"));
        const key = scenario === "pending unit" ? "unit:test@1" : "result:turn:plan@1";
        yield* PubSub.take(subscription).pipe(
          Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === key }),
        );
        return runId;
      }).pipe(Effect.scoped, Effect.provide(services));
      fake.stall.delete("unit:test@1");
      yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const subscription = yield* journal.subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        yield* engine.tick;
        if (scenario === "live turn") yield* fake.release("plan");
        const ended = yield* PubSub.take(subscription).pipe(
          Effect.repeat({
            until: (f) => f.stream === runStream(runId) && f.fact._tag === "RunEnded",
          }),
        );
        assert.equal(ended.fact._tag === "RunEnded" && ended.fact.status, "succeeded");
        if (scenario === "pending unit") {
          assert.equal(fake.executions.get("unit:test@1"), 2);
          assert.equal(fake.units.size, 1);
        } else {
          assert.equal(fake.threads.size, 1);
          assert.equal(fake.executions.get("turn:plan@1"), 1);
        }
      }).pipe(Effect.scoped, Effect.provide(services));
    }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect(
  "abandons a start that never ran when the run was cancelled while the server was down",
  () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeFakeInterpreter({});
      fake.stall.add("unit:test@1");
      const services = Layer.mergeAll(layerFromDb, layer, layerCatalog([twoSteps]));
      const runId = yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const subscription = yield* journal.subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        const { runId } = yield* engine.start(request("manual:abandon"));
        yield* PubSub.take(subscription).pipe(
          Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "unit:test@1" }),
        );
        return runId;
      }).pipe(Effect.scoped, Effect.provide(services));
      yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const subscription = yield* journal.subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        yield* engine.control({
          runId,
          control: "cancel",
          step: null,
          clientRequestId: "c1",
          by: "test",
        });
        yield* engine.tick;
        yield* PubSub.take(subscription).pipe(
          Effect.repeat({
            until: (f) => f.stream === runStream(runId) && f.key === "result:unit:test@1",
          }),
        );
        const state = yield* engine.runState(runId);
        assert.equal(state.ended?.status, "cancelled");
        assert.isTrue(fake.abandoned.has("unit:test@1"));
        assert.equal(fake.executions.get("unit:test@1"), 1);
        assert.equal(fake.units.size, 0);
      }).pipe(Effect.scoped, Effect.provide(services));
    }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect("stops a start that keeps retrying once the run is cancelled", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter({});
    fake.failRetryable.add("unit:test@1");
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const subscription = yield* journal.subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start(request("manual:retrying"));
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "unit:test@1" }),
      );
      yield* engine.control({
        runId,
        control: "cancel",
        step: null,
        clientRequestId: "c1",
        by: "test",
      });
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.key === "result:unit:test@1",
        }),
      );
      yield* TestClock.adjust("2 minutes");
      assert.isTrue(fake.abandoned.has("unit:test@1"));
      assert.equal(fake.executions.get("unit:test@1"), 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerFromDb, layer, layerCatalog([twoSteps]))),
    );
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect("requires approval for a protected command and preserves the first decision", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter({});
    const protectedWorkflow = compile({
      nodes: {
        ...twoSteps.definition.nodes,
        test: {
          kind: "command",
          argv: ["git", "push", "origin", "HEAD:friend/main"],
          cwd: "integ",
        },
      },
      edges: ["plan -> test", "test -> done"],
    });
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const subscription = yield* journal.subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start(request("manual:protected"));
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.key === "result:open:protect:test@1",
        }),
      );
      assert.isFalse((yield* engine.runState(runId)).intents.has("unit:test@1"));
      const input = { runId, gateKey: "protect:test@1", option: "approve", note: null };
      yield* engine.decideGate(input);
      const ended = yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.fact._tag === "RunEnded",
        }),
      );
      assert.equal(ended.fact._tag === "RunEnded" && ended.fact.status, "succeeded");
      assert.isTrue(fake.units.has("unit:test@1"));
      assert.equal((yield* engine.decideGate({ ...input, option: "reject" })).option, "approve");
      const other = yield* engine.start(request("manual:invalid"));
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) =>
            f.stream === runStream(other.runId) && f.key === "result:open:protect:test@1",
        }),
      );
      const error = yield* engine
        .decideGate({ ...input, runId: other.runId, option: "maybe" })
        .pipe(Effect.flip);
      assert.equal(error._tag, "WorkflowJournalError");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerFromDb, layer, layerCatalog([protectedWorkflow]))),
    );
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);
