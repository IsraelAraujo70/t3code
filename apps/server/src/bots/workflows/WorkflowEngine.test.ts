import { assert, it } from "@effect/vitest";
import {
  type WorkflowRunDelta,
  WorkflowStepKey,
  WorkflowLedgerId,
  WorkflowId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BotsDb from "../BotsDb.ts";
import { type Intent, type NewFact, runStream, type StoredFact, workflowStream } from "./facts.ts";
import { runIdFor } from "./ids.ts";
import { Journal, layerFromDb, WorkflowJournalError } from "./Journal.ts";
import { layerCountingJournal, type FactReads } from "./testkit/countingJournal.ts";
import { compile, runStarted } from "./testkit/decideHarness.ts";
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

it.effect("promotes behind 200 finished runs reading only the facts that can decide", () =>
  Effect.gen(function* () {
    const { layer } = yield* makeFakeInterpreter({});
    const reads: FactReads = { facts: 0, createdRows: 0 };
    const journalLayer = layerCountingJournal(reads).pipe(Layer.provide(layerFromDb));
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/runs" });
      const fired = (occurrence: string): NewFact => ({
        stream: workflowStream("demo"),
        key: occurrence,
        fact: {
          _tag: "TriggerFired",
          runId: runIdFor("demo", occurrence),
          ...request(occurrence),
          at: "2026-11-02T00:00:00.000Z",
        },
      });
      const outcome = (runId: string, status: string): NewFact => ({
        stream: workflowStream("demo"),
        key: `outcome:${runId}`,
        fact: { _tag: "RunOutcome", runId, status },
      });
      yield* journal.append(
        Array.from({ length: 200 }, (_, i): NewFact[] => {
          const occurrence = `manual:old-${i}`;
          const runId = runIdFor("demo", occurrence);
          return [
            fired(occurrence),
            {
              stream: workflowStream("demo"),
              key: `created:${occurrence}`,
              fact: { _tag: "RunCreated", runId, occurrence },
            },
            outcome(runId, "succeeded"),
            { stream: runStream(runId), key: "started", fact: runStarted() },
            {
              stream: runStream(runId),
              key: "ended",
              fact: { _tag: "RunEnded", status: "succeeded", at: "2026-11-02T00:00:00.000Z" },
            },
          ];
        }).flat(),
      );
      // The old runs settled days ago: none of them can charge in today's workflow day.
      yield* TestClock.adjust("3 days");
      const subscription = yield* journal.subscribe;
      const runId = runIdFor("demo", "manual:new");
      yield* journal.append([fired("manual:new")]);
      reads.facts = 0;
      yield* engine.tick;
      const ended = yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.fact._tag === "RunEnded",
        }),
      );
      assert.equal(ended.fact._tag === "RunEnded" && ended.fact.status, "succeeded");
      assert.isBelow(reads.facts, 100);

      // The fatigue limit still trips on the latest outcomes, behind 201 successes.
      yield* journal.append([outcome("failed-1", "failed"), outcome("failed-2", "failed")]);
      yield* journal.append([fired("manual:after")]);
      reads.facts = 0;
      yield* engine.tick;
      assert.isBelow(reads.facts, 20);
      const stream = yield* journal.read(workflowStream("demo"));
      const skipped = stream.find((f) => f.key === "skipped:manual:after")?.fact;
      assert.equal(skipped?._tag === "TriggerSkipped" && skipped.reason, "suspended");
      assert.isTrue(stream.some((f) => f.key === "suspended:failed-2"));
      assert.equal(stream.filter((f) => f.key === "created:manual:new").length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(journalLayer, layer, layerCatalog([twoSteps]))),
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
    // A workflow with a bot: a protected action is still Israel's alone.
    const protectedWorkflow = compile({
      bot: BOT,
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
      const gated = yield* engine.runState(runId);
      assert.isFalse(gated.intents.has("unit:test@1"));
      assert.isUndefined(gated.gates.get("protect:test@1")?.intent.bot);
      assert.isFalse(gated.intents.has("ask:protect:test@1"));
      assert.isTrue(gated.intents.has("notify:gate:protect:test@1"));
      const input = { runId, gateKey: "protect:test@1", option: "approve", note: null };
      const byBot = yield* engine.decideGate({ ...input, bot: BOT }).pipe(Effect.flip);
      assert.include(byBot.message, "not routed to this bot");
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

it.effect(
  "folds every committed fact for a subscriber even when publishes arrive out of order",
  () =>
    Effect.gen(function* () {
      const { layer: interpreter } = yield* makeFakeInterpreter({});
      // Publishes the test controls: two appends can publish in either order after they commit.
      const published = yield* PubSub.unbounded<StoredFact>();
      const journalLayer = Layer.effect(
        Journal,
        Effect.gen(function* () {
          const real = yield* Journal;
          return Journal.of({ ...real, subscribe: PubSub.subscribe(published) });
        }),
      ).pipe(Layer.provide(layerFromDb), Layer.provide(BotsDb.layerMemory));
      yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const engine = yield* make({ runsDir: "/runs" });
        const runId = runIdFor("demo", "manual:1");
        yield* journal.append([
          {
            stream: runStream(runId),
            key: "started",
            fact: runStarted({ hash: `sha256:${"0".repeat(64)}` }),
          },
        ]);
        const deltas = yield* Queue.unbounded<WorkflowRunDelta>();
        yield* engine.subscribeRun({ runId, afterSeq: 0 }).pipe(
          Stream.runForEach((delta) => Queue.offer(deltas, delta)),
          Effect.forkScoped,
        );
        // The first delta proves the subscription exists before anything is published.
        assert.deepEqual((yield* Queue.take(deltas)).seq, 1);
        const intent: Intent = {
          _tag: "StartUnit",
          key: "unit:test@1",
          step: "test",
          attempt: 1,
          argv: ["node", "check.ts"],
          cwd: { name: "integ", path: "/runs/integ" },
          heavy: false,
          replay: "safe",
          timeoutMs: 60_000,
          env: {},
        };
        const stored = yield* journal.append([
          { stream: runStream(runId), key: intent.key, fact: { _tag: "IntentRecorded", intent } },
          {
            stream: runStream(runId),
            key: `result:${intent.key}`,
            fact: { _tag: "UnitSpawned", unit: "wf-x", at: "2026-11-02T10:00:00.000Z" },
          },
        ]);
        // Only the later fact is published: the intent's publish has not happened yet.
        yield* PubSub.publish(published, stored[1]!.fact);
        const last = yield* Queue.take(deltas);
        assert.deepEqual(last.seq, 3);
        assert.deepEqual(
          last.steps.map((step) => [step.key, step.status]),
          [["test", "running"]],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(journalLayer, interpreter, layerCatalog([twoSteps]))),
      );
    }),
);

it.effect("retries an append that keeps failing only after the retry pause", () =>
  Effect.gen(function* () {
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    let failures = 0;
    const journalLayer = Layer.effect(
      Journal,
      Effect.gen(function* () {
        const real = yield* Journal;
        return Journal.of({
          ...real,
          append: (facts) => {
            if (!facts.some((fact) => fact.key === "result:turn:plan@1")) return real.append(facts);
            failures += 1;
            return Effect.fail(new WorkflowJournalError({ message: "disk full" }));
          },
        });
      }),
    ).pipe(Layer.provide(layerFromDb), Layer.provide(BotsDb.layerMemory));
    yield* Effect.gen(function* () {
      const engine = yield* make({ runsDir: "/runs", retryEvery: "1 minute" });
      yield* engine.start(request("manual:1"));
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      assert.deepEqual(failures, 1);
      yield* TestClock.adjust("1 minute");
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      assert.deepEqual(failures, 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(journalLayer, interpreter, layerCatalog([twoSteps]))),
    );
  }),
);

it.effect("lists the runs that load and refuses controls for a run that does not exist", () =>
  Effect.gen(function* () {
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    const journalLayer = layerFromDb.pipe(Layer.provide(BotsDb.layerMemory));
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/runs" });
      // A run whose workflow the catalog no longer has: its pinned version cannot load.
      const broken = runIdFor("gone", "manual:1");
      yield* journal.append([
        {
          stream: workflowStream("gone"),
          key: "created:manual:1",
          fact: { _tag: "RunCreated", runId: broken, occurrence: "manual:1" },
        },
        {
          stream: runStream(broken),
          key: "started",
          fact: runStarted({ workflowId: "gone", hash: `sha256:${"0".repeat(64)}` }),
        },
      ]);
      const { runId } = yield* engine.start(request("manual:1"));
      const page = yield* engine.listRuns({});
      assert.deepEqual(
        page.runs.map((run) => run.runId),
        [runId],
      );
      const missing = runIdFor("demo", "manual:never");
      const refused = yield* engine
        .controlRun(
          {
            runId: missing,
            control: { _tag: "cancel" },
            clientRequestId: "c1",
          },
          "user",
        )
        .pipe(Effect.flip);
      assert.deepEqual(refused._tag, "WorkflowJournalError");
      assert.deepEqual((yield* journal.read(runStream(missing))).length, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(journalLayer, interpreter, layerCatalog([twoSteps]))),
    );
  }),
);

it.effect("stores a retryable failure as final after the last try", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter({});
    fake.failRetryable.add("unit:test@1");
    yield* Effect.gen(function* () {
      const engine = yield* make({ runsDir: "/runs", retryEvery: "1 minute" });
      const { runId } = yield* engine.start(request("manual:give-up"));
      for (let minute = 0; minute < 12; minute++) {
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
      }
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
      assert.equal(fake.executions.get("unit:test@1"), 10);
      const resolved = (yield* engine.runState(runId)).attempts.get("test")?.[0]?.resolved;
      assert.deepEqual([resolved?.status, resolved?.error], ["failed", "try again"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layerFromDb, layer, layerCatalog([twoSteps]))),
    );
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect(
  "reopens a failed run when Israel retries its failed step, and lists it from the projection",
  () =>
    Effect.gen(function* () {
      const units: Record<string, { readonly exit: number }> = { test: { exit: 1 } };
      const { layer } = yield* makeFakeInterpreter({ units });
      yield* Effect.gen(function* () {
        const journal = yield* Journal;
        const subscription = yield* journal.subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        const { runId } = yield* engine.start(request("manual:retry"));
        const reach = (key: string) =>
          PubSub.take(subscription).pipe(
            Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === key }),
          );
        yield* reach("ended");
        units.test = { exit: 0 };
        yield* engine.controlRun(
          {
            runId,
            control: { _tag: "retry", step: WorkflowStepKey.make("test") },
            clientRequestId: "r1",
          },
          "user",
        );
        yield* reach("ended:1");
        yield* engine.rebuildProjection;
        const page = yield* engine.listRuns({});
        assert.deepEqual(
          page.runs.map((run) => [run.runId, run.status]),
          [[runId, "succeeded"]],
        );
        const refused = yield* engine
          .controlRun(
            {
              runId,
              control: { _tag: "retry", step: WorkflowStepKey.make("test") },
              clientRequestId: "r2",
            },
            "user",
          )
          .pipe(Effect.flip);
        assert.match(refused.message, /Cannot retry: test succeeded/);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(layerFromDb, layer, layerCatalog([twoSteps]))),
      );
    }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect("reads persisted ledgers with filters, pagination and metric conversion", () =>
  Effect.gen(function* () {
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/runs" });
      const at = "2026-11-02T10:00:00.000Z";
      for (const key of ["one", "two"]) {
        yield* journal.append([
          {
            stream: "ledger:experiments",
            key: `register:${key}`,
            fact: {
              _tag: "EntryRegistered",
              key,
              runId: "wfr_0123456789abcdef0123",
              workflowId: "demo",
              step: "plan",
              hypothesis: key,
              barHash: "bar",
              at,
            },
          },
          {
            stream: "ledger:experiments",
            key: `resolve:${key}`,
            fact: {
              _tag: "EntryResolved",
              key,
              verdict: "kept",
              before: { objective: 1, values: { score: 1 } },
              after: { score: 2 },
              sha: "abc",
              note: null,
              at,
            },
          },
        ]);
      }
      const page = yield* engine.ledger({ limit: 1 });
      assert.deepEqual(page.entries.length, 1);
      assert.deepEqual(page.entries[0]?.before, { objective: 1, values: { score: 1 } });
      assert.deepEqual(page.entries[0]?.after, null);
      assert.deepEqual(page.nextCursor, "1");
      const next = yield* engine.ledger({
        ledger: WorkflowLedgerId.make("experiments"),
        workflowId: WorkflowId.make("demo"),
        verdict: "kept",
        cursor: "1",
        limit: 1,
      });
      assert.equal(next.entries[0]?.key, "two");
      assert.equal(next.nextCursor, null);
      assert.deepEqual((yield* engine.ledger({ verdict: "rejected" })).entries, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
          interpreter,
          layerCatalog([twoSteps]),
        ),
      ),
    );
  }),
);

it.effect("delivers a queued occurrence skipped on its workflow stream", () =>
  Effect.gen(function* () {
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/runs" });
      const occurrence = "manual:queued";
      const runId = runIdFor("demo", occurrence);
      yield* journal.append([
        {
          stream: workflowStream("demo"),
          key: occurrence,
          fact: {
            _tag: "TriggerFired",
            runId,
            ...request(occurrence),
            at: "2026-11-02T00:00:00.000Z",
          },
        },
      ]);
      const deltas = yield* Queue.unbounded<WorkflowRunDelta>();
      yield* engine.subscribeRun({ runId, afterSeq: 0 }).pipe(
        Stream.runForEach((delta) => Queue.offer(deltas, delta)),
        Effect.forkScoped,
      );
      yield* journal.append([
        {
          stream: workflowStream("demo"),
          key: `skipped:${occurrence}`,
          fact: {
            _tag: "TriggerSkipped",
            occurrence,
            reason: "busy",
          },
        },
      ]);
      const chunk = yield* Queue.take(deltas).pipe(
        Effect.repeat({ until: (delta) => delta.summary.status === "skipped" }),
      );
      assert.equal(chunk.summary.status, "skipped");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
          interpreter,
          layerCatalog([twoSteps]),
        ),
      ),
    );
  }),
);
it.effect("ignores unrelated workflow facts for a queued subscriber", () =>
  Effect.gen(function* () {
    const reads: FactReads = { facts: 0, createdRows: 0 };
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/runs" });
      const occurrence = "manual:queued";
      const runId = runIdFor("demo", occurrence);
      yield* journal.append([
        {
          stream: workflowStream("demo"),
          key: occurrence,
          fact: {
            _tag: "TriggerFired",
            runId,
            ...request(occurrence),
            at: "2026-11-02T00:00:00.000Z",
          },
        },
      ]);
      const deltas = yield* Queue.unbounded<WorkflowRunDelta>();
      const subscriber = yield* engine.subscribeRun({ runId, afterSeq: 0 }).pipe(
        Stream.runForEach((delta) => Queue.offer(deltas, delta)),
        Effect.forkScoped,
      );
      yield* Queue.take(deltas);
      reads.facts = 0;
      for (let i = 0; i < 50; i++) {
        const other = `manual:other-${i}`;
        yield* journal.append([
          {
            stream: workflowStream("demo"),
            key: other,
            fact: {
              _tag: "TriggerFired",
              runId: runIdFor("demo", other),
              ...request(other),
              at: "2026-11-02T00:00:00.000Z",
            },
          },
        ]);
      }
      yield* journal.append([
        {
          stream: workflowStream("demo"),
          key: `skipped:${occurrence}`,
          fact: {
            _tag: "TriggerSkipped",
            occurrence,
            reason: "busy",
          },
        },
      ]);
      // The very next delta is the skip: the 50 unrelated facts sent nothing.
      const chunk = yield* Queue.take(deltas);
      yield* Fiber.join(subscriber);
      assert.equal(chunk.summary.status, "skipped");
      assert.equal(reads.facts, 1);
      assert.equal(yield* Queue.size(deltas), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerCountingJournal(reads).pipe(
            Layer.provide(layerFromDb),
            Layer.provide(BotsDb.layerMemory),
          ),
          interpreter,
          layerCatalog([twoSteps]),
        ),
      ),
    );
  }),
);

it.effect("pins a run view to its cursor snapshot", () =>
  Effect.gen(function* () {
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/runs" });
      const runId = runIdFor("demo", "pin");
      yield* journal.append([
        {
          stream: runStream(runId),
          key: "started",
          fact: runStarted({ hash: `sha256:${"0".repeat(64)}` }),
        },
      ]);
      const before = yield* engine.runView({ runId });
      yield* journal.append([
        {
          stream: runStream(runId),
          key: "ended",
          fact: { _tag: "RunEnded", status: "succeeded", at: "2026-11-02T00:00:00.000Z" },
        },
      ]);
      const pinned = yield* engine.runView({ runId, stepsCursor: `${before.seq}:0` });
      assert.equal(pinned.seq, before.seq);
      assert.equal(pinned.summary.status, before.summary.status);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
          interpreter,
          layerCatalog([twoSteps]),
        ),
      ),
    );
  }),
);

it.effect("owner runs validate params and expose their trigger payload", () =>
  Effect.gen(function* () {
    const { layer: interpreter } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const engine = yield* make({ runsDir: "/runs" });
      const run = yield* engine.startRun(
        { workflowId: WorkflowId.make("demo"), clientRequestId: "owner" },
        "Owner",
      );
      const state = yield* engine.runState(run.runId);
      assert.strictEqual(state.started?.trigger.id, "run");
      assert.deepEqual(yield* engine.runTrigger({ runId: run.runId }), {
        payload: { by: "Owner" },
        truncated: false,
      });
      assert.deepEqual(yield* engine.runTrigger({ runId: run.runId, maxBytes: 1 }), {
        payload: null,
        truncated: true,
      });
      const error = yield* engine
        .startRun(
          { workflowId: WorkflowId.make("demo"), clientRequestId: "bad", params: { n: "wrong" } },
          "Owner",
        )
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkflowsError");
      assert.include(error.message, "n");
      const tooMany = yield* engine
        .startRun(
          {
            workflowId: WorkflowId.make("demo"),
            clientRequestId: "too-many",
            params: { tickets: ["A-1", "A-2", "A-3"] },
          },
          "Owner",
        )
        .pipe(Effect.flip);
      assert.include(tooMany.message, "tickets has 3 items; at most 2");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
          interpreter,
          layerCatalog(
            [
              compile({
                params: {
                  n: { type: "number", default: 1 },
                  tickets: { type: "string[]", default: [], maxItems: 2 },
                },
              }),
            ],
            false,
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "owner runs require a manual trigger and test runs require a captured webhook event",
  () =>
    Effect.gen(function* () {
      const { layer: interpreter } = yield* makeFakeInterpreter({});
      yield* Effect.gen(function* () {
        const engine = yield* make({ runsDir: "/runs" });
        const journal = yield* Journal;
        const input = { workflowId: WorkflowId.make("demo"), clientRequestId: "manual" };
        const missing = yield* engine.startRun(input, "Owner").pipe(Effect.flip);
        assert.strictEqual(missing._tag, "WorkflowsError");
        assert.include(missing.message, "no manual trigger");
        const test = { ...input, clientRequestId: "test", testTrigger: "hook" };
        const noSample = yield* engine.startRun(test, "Owner").pipe(Effect.flip);
        assert.include(noSample.message, "no captured event");
        yield* journal.captureTestDelivery({
          workflowId: "demo",
          triggerId: "hook",
          deliveryId: "delivery",
          payload: { body: { n: 7 } },
        });
        const run = yield* engine.startRun(test, "Owner");
        const state = yield* engine.runState(run.runId);
        assert.deepEqual(state.started?.params, { n: 7 });
        const facts = yield* journal.read(workflowStream("demo"));
        assert.isTrue(
          facts.some(
            ({ fact }) => fact._tag === "TriggerFired" && fact.occurrence.startsWith("test:"),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
            interpreter,
            layerCatalog([
              compile({
                triggers: { hook: { kind: "webhook", params: { n: "{{ trigger.body.n }}" } } },
                params: { n: { type: "number" } },
              }),
            ]),
          ),
        ),
      );
    }),
);

const BOT = `b_${"a".repeat(32)}`;
const botRoutine = (status: "no_change" | "ready_for_review") =>
  compile({
    bot: BOT,
    params: { news: { type: "string", default: "" } },
    nodes: {
      look: { kind: "agent", model: "$lead", prompt: "Look", workspace: "integ" },
      done: { kind: "output", status, value: {}, report: "{{ params.news }}", postToBot: true },
    },
    edges: ["look -> done"],
  });

it.effect("posts a bot routine's report once, also when a restart replays the post", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter({});
    fake.stall.add("post:done");
    const services = Layer.mergeAll(
      layerFromDb,
      layer,
      layerCatalog([botRoutine("ready_for_review")]),
    );
    const runId = yield* Effect.gen(function* () {
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start({
        ...request("manual:post"),
        params: { news: "BTC -8%" },
      });
      yield* fake.stalled("post:done");
      return runId;
    }).pipe(Effect.scoped, Effect.provide(services));
    fake.stall.delete("post:done");
    for (const restart of [1, 2]) {
      yield* Effect.gen(function* () {
        const subscription = yield* (yield* Journal).subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        yield* engine.tick;
        if (restart === 1)
          yield* PubSub.take(subscription).pipe(
            Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "ended" }),
          );
        const state = yield* engine.runState(runId);
        assert.equal(state.ended?.status, "succeeded");
        const look = state.intents.get("turn:look@1")?.intent;
        assert.equal(look?._tag === "StartTurn" ? look.bot : undefined, BOT);
        // The post replaced the finished push: the bot's reply is what notifies.
        assert.isFalse(state.intents.has("notify:end"));
      }).pipe(Effect.scoped, Effect.provide(services));
    }
    assert.equal(fake.executions.get("post:done"), 2);
    assert.deepEqual([...fake.posts.values()], [{ botId: BOT, report: "BTC -8%" }]);
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect("posts nothing for an empty report and keeps the finished push", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter({});
    yield* Effect.gen(function* () {
      const subscription = yield* (yield* Journal).subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start(request("manual:quiet"));
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "ended" }),
      );
      const state = yield* engine.runState(runId);
      assert.isFalse(state.intents.has("post:done"));
      assert.isTrue(state.intents.has("notify:end"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(layerFromDb, layer, layerCatalog([botRoutine("ready_for_review")])),
      ),
    );
    assert.equal(fake.posts.size, 0);
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);

// ── ticket fleet: one visible, card-linked thread and worktree per item ─────────────────────────

const TICKETS = [
  { id: "ticket-a", identifier: "BACK-1", title: "Fails its gate" },
  { id: "ticket-b", identifier: "BACK-2", title: "Passes" },
];
const fleet = compile({
  bot: BOT,
  params: { tickets: { type: "string[]", maxItems: 10, pattern: "[A-Z]+-\\d+" } },
  workspaces: {
    item: { project: "t3code", base: "friend/main", perItem: true, branchPolicy: "agent" },
  },
  nodes: {
    fleet: {
      kind: "map",
      items: "params.tickets",
      maxItems: 10,
      concurrency: 2,
      body: {
        nodes: {
          implement: {
            kind: "agent",
            model: "$lead",
            prompt: "Implement {{ item }}.",
            workspace: "item",
            access: "write",
            thread: { visible: true, kanbanCard: "{{ item }}" },
            accept: { argv: ["node", "gate.ts"], check: "exit == 0" },
            retry: { max: 1, on: ["failed"] },
          },
          publish: {
            kind: "agent",
            model: "$lead",
            prompt: "Open the pull request.",
            workspace: "item",
            access: "write",
            thread: "continue:implement",
            output: { pr: { type: "string" } },
          },
          done: {
            kind: "output",
            status: "ready_for_review",
            value: { ticket: "{{ item }}", status: "done", pr: "{{ nodes.publish.output.pr }}" },
            report: "{{ item }}: {{ nodes.publish.output.pr }}",
            postToBot: true,
          },
          blocked: {
            kind: "output",
            status: "blocked",
            value: {
              ticket: "{{ item }}",
              status: "blocked",
              reason: "{{ nodes.implement.error }}",
            },
            report: "{{ item }} blocked",
            postToBot: true,
          },
        },
        edges: ["implement -> publish", "implement:fail -> blocked", "publish -> done"],
      },
    },
    report: {
      kind: "output",
      status: "ready_for_review",
      value: {},
      report: "{{ table(nodes.fleet.output, 'ticket', 'status', 'pr', 'reason') }}",
      postToBot: true,
    },
  },
  edges: ["fleet -> report"],
});
const fleetScripts = {
  tickets: TICKETS,
  units: {
    "fleet[0]/implement/accept": { exit: 1, tail: "lint: 2 errors in src/a.ts" },
    "fleet[1]/implement/accept": { exit: 0 },
  },
  turns: { "fleet[1]/publish": { output: { pr: "https://github.com/o/r/pull/7" } } },
};
const fleetStart = { ...request("manual:fleet"), params: { tickets: ["BACK-1", "BACK-2"] } };

it.effect("runs each ticket in its own visible, card-linked thread and worktree", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter(fleetScripts);
    yield* Effect.gen(function* () {
      const subscription = yield* (yield* Journal).subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start(fleetStart);
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "ended" }),
      );
      const state = yield* engine.runState(runId);
      assert.equal(state.ended?.status, "succeeded");
      const turn = (key: string) => {
        const intent = state.intents.get(key)?.intent;
        assert.equal(intent?._tag, "StartTurn");
        return intent as Extract<Intent, { _tag: "StartTurn" }>;
      };
      // One listed `wfi:` thread per item; the continuation and the retry stay in it.
      const first = turn("turn:fleet[0]/implement@1");
      const second = turn("turn:fleet[1]/implement@1");
      assert.match(first.threadId, /^wfi:wfr_[0-9a-f]{20}:[0-9a-f]{32}$/);
      assert.notEqual(first.threadId, second.threadId);
      assert.equal(first.mode, "new");
      assert.equal(first.title, "BACK-1 Fails its gate");
      assert.include(first.prompt, "Kanban ticket BACK-1");
      assert.include(first.prompt, "Implement BACK-1.");
      assert.equal(turn("turn:fleet[1]/publish@1").threadId, second.threadId);
      // Each item works in its own worktree, on a branch the agent names, behind the push guard.
      assert.equal(first.workspace.name, "item#fleet[0]");
      assert.equal(second.workspace.name, "item#fleet[1]");
      assert.deepEqual([...fake.workspaces.keys()].sort(), ["item#fleet[0]", "item#fleet[1]"]);
      for (const ws of fake.workspaces.values()) {
        assert.isNull(ws.branch);
        assert.deepEqual(ws.agentBranch?.protect, ["main", "master", "friend/main"]);
      }
      assert.deepEqual(
        [...fake.links].sort(),
        [`ticket-a ${first.threadId}`, `ticket-b ${second.threadId}`].sort(),
      );
      // The failed acceptance goes back to the same thread with its reason, up to retry.max.
      const retried = turn("turn:fleet[0]/implement@2");
      assert.equal(retried.threadId, first.threadId);
      assert.equal(retried.mode, "continue");
      assert.include(retried.prompt, "did not pass: `node gate.ts` exited 1");
      assert.include(retried.prompt, "lint: 2 errors in src/a.ts");
      assert.isFalse(state.intents.has("turn:fleet[0]/implement@3"));
      // The blocked item does not stop the other: both are in the map's result and the report.
      const items = state.attempts.get("fleet")?.at(-1)?.resolved?.output;
      assert.deepEqual(items, [
        {
          ticket: "BACK-1",
          status: "blocked",
          reason: "`node gate.ts` exited 1:\nlint: 2 errors in src/a.ts",
        },
        { ticket: "BACK-2", status: "done", pr: "https://github.com/o/r/pull/7" },
      ]);
      assert.deepEqual([...fake.posts.values()].map((p) => p.report).sort(), [
        "BACK-1 blocked",
        "BACK-2: https://github.com/o/r/pull/7",
        [
          "| ticket | status | pr | reason |",
          "| --- | --- | --- | --- |",
          "| BACK-1 | blocked |  | `node gate.ts` exited 1: lint: 2 errors in src/a.ts |",
          "| BACK-2 | done | https://github.com/o/r/pull/7 |  |",
        ].join("\n"),
      ]);
      assert.isTrue(state.intents.has("post:blocked:fleet[0]"));
      assert.isTrue(state.intents.has("post:done:fleet[1]"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
          layer,
          layerCatalog([fleet]),
        ),
      ),
    );
  }),
);

it.effect("a restart mid-fleet adds no thread, link or item post", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter(fleetScripts);
    fake.stall.add("post:done:fleet[1]");
    const services = Layer.mergeAll(layerFromDb, layer, layerCatalog([fleet]));
    const runId = yield* Effect.gen(function* () {
      const subscription = yield* (yield* Journal).subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start(fleetStart);
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.key === "post:done:fleet[1]",
        }),
      );
      return runId;
    }).pipe(Effect.scoped, Effect.provide(services));
    fake.stall.delete("post:done:fleet[1]");
    for (const restart of [1, 2]) {
      yield* Effect.gen(function* () {
        const subscription = yield* (yield* Journal).subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        yield* engine.tick;
        if (restart === 1)
          yield* PubSub.take(subscription).pipe(
            Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "ended" }),
          );
        const state = yield* engine.runState(runId);
        assert.equal(state.ended?.status, "succeeded");
        const intents = [...state.intents.values()].map((e) => e.intent);
        assert.equal(intents.filter((i) => i._tag === "LinkThread").length, 2);
        assert.equal(intents.filter((i) => i._tag === "StartTurn" && i.mode === "new").length, 2);
      }).pipe(Effect.scoped, Effect.provide(services));
    }
    assert.equal(fake.links.size, 2);
    assert.equal(new Set(fake.threads.values()).size, 2);
    assert.equal(
      [...fake.posts.values()].filter((p) => p.report === "BACK-2: https://github.com/o/r/pull/7")
        .length,
      1,
    );
  }).pipe(Effect.provide(BotsDb.layerMemory)),
);

// ── gates the workflow's bot answers ─────────────────────────────────────────────────────────

const OTHER_BOT = `b_${"c".repeat(32)}`;
const askTheBot = compile({
  bot: BOT,
  nodes: {
    work: { kind: "agent", model: "$lead", prompt: "Work", workspace: "integ", access: "write" },
    ask: { kind: "gate", answerBy: "bot", ask: "Postgres or SQLite?", options: ["answer"] },
    resume: {
      kind: "agent",
      model: "$lead",
      prompt: "The answer: {{ nodes.ask.answer }}",
      workspace: "integ",
      access: "write",
      thread: "continue:work",
    },
    done: { kind: "output", status: "no_change", value: {} },
  },
  edges: ["work -> ask", "ask:answer -> resume", "resume -> done"],
});
const turnOf = (state: { intents: ReadonlyMap<string, { intent: Intent }> }, key: string) => {
  const intent = state.intents.get(key)?.intent;
  assert.equal(intent?._tag, "StartTurn");
  return intent as Extract<Intent, { _tag: "StartTurn" }>;
};
const askPosts = (fake: { posts: Map<string, { report: string }> }, gateKey: string) =>
  [...fake.posts.entries()].filter(([commandId]) => commandId.endsWith(`:ask:${gateKey}`));

it.effect(
  "posts a bot's gate once across a restart, and its owner's answer reaches the next step",
  () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeFakeInterpreter({});
      fake.stall.add("ask:ask@1");
      const services = Layer.mergeAll(layerFromDb, layer, layerCatalog([askTheBot]));
      const runId = yield* Effect.gen(function* () {
        const engine = yield* make({ runsDir: "/runs" });
        const { runId } = yield* engine.start(request("manual:ask-bot"));
        yield* fake.stalled("ask:ask@1");
        return runId;
      }).pipe(Effect.scoped, Effect.provide(services));
      fake.stall.delete("ask:ask@1");
      yield* Effect.gen(function* () {
        const subscription = yield* (yield* Journal).subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        yield* engine.tick;
        yield* PubSub.take(subscription).pipe(
          Effect.repeat({
            until: (f) => f.stream === runStream(runId) && f.key === "result:ask:ask@1",
          }),
        );
        const waiting = yield* engine.runState(runId);
        const gate = waiting.gates.get("ask@1")?.intent;
        assert.equal(gate?.bot, BOT);
        assert.deepEqual(gate?.options, ["answer", "escalate"]);
        // The bot gets the ask; Israel gets no push for it.
        assert.isFalse(waiting.intents.has("notify:gate:ask@1"));
        const refused = yield* engine
          .decideGate({ runId, gateKey: "ask@1", option: "answer", note: "x", bot: OTHER_BOT })
          .pipe(Effect.flip);
        assert.include(refused.message, "not routed to this bot");
        const decided = yield* engine.decideGate({
          runId,
          gateKey: "ask@1",
          option: "answer",
          note: "Postgres, the schema needs jsonb",
          bot: BOT,
        });
        assert.equal(decided.by, `bot:${BOT}`);
        yield* PubSub.take(subscription).pipe(
          Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "ended" }),
        );
        const state = yield* engine.runState(runId);
        assert.equal(state.ended?.status, "succeeded");
        const resume = turnOf(state, "turn:resume@1");
        assert.equal(resume.mode, "continue");
        assert.equal(resume.threadId, turnOf(state, "turn:work@1").threadId);
        assert.include(resume.prompt, "The answer: Postgres, the schema needs jsonb");
        const view = yield* engine.runView({ runId: runId as never });
        assert.deepInclude(view.gates[0], { key: "ask@1", bot: BOT });
        assert.equal(view.gates[0]?.decision?.by, `bot:${BOT}`);
      }).pipe(Effect.scoped, Effect.provide(services));
      assert.equal(fake.executions.get("ask:ask@1"), 2);
      const posts = askPosts(fake, "ask@1");
      assert.equal(posts.length, 1);
      assert.include(posts[0]![1].report, "Postgres or SQLite?");
      assert.include(posts[0]![1].report, "Options: answer, escalate");
    }).pipe(Effect.provide(BotsDb.layerMemory)),
);

it.effect(
  "escalate hands the bot's gate to Israel with a push; Israel may answer a bot's gate",
  () =>
    Effect.gen(function* () {
      const { fake, layer } = yield* makeFakeInterpreter({});
      yield* Effect.gen(function* () {
        const subscription = yield* (yield* Journal).subscribe;
        const engine = yield* make({ runsDir: "/runs" });
        const waitFor = (runId: string, key: string) =>
          PubSub.take(subscription).pipe(
            Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === key }),
          );

        const escalated = yield* engine.start(request("manual:escalate"));
        yield* waitFor(escalated.runId, "result:ask:ask@1");
        yield* engine.decideGate({
          runId: escalated.runId,
          gateKey: "ask@1",
          option: "escalate",
          note: "this is a product call",
          bot: BOT,
        });
        yield* waitFor(escalated.runId, "result:notify:gate:escalated:ask@1");
        const waiting = yield* engine.runState(escalated.runId);
        const israel = waiting.gates.get("escalated:ask@1")?.intent;
        assert.isUndefined(israel?.bot);
        assert.deepEqual(israel?.options, ["answer"]);
        assert.include(israel?.ask, "this is a product call");
        const view = yield* engine.runView({ runId: escalated.runId as never });
        assert.deepEqual(
          view.gates.filter((g) => g.decision === null).map((g) => g.key),
          ["escalated:ask@1"],
        );
        assert.equal(view.summary.openGates, 1);
        // The bot handed it over: only Israel decides the escalated gate.
        const refused = yield* engine
          .decideGate({
            runId: escalated.runId,
            gateKey: "escalated:ask@1",
            option: "answer",
            note: "x",
            bot: BOT,
          })
          .pipe(Effect.flip);
        assert.include(refused.message, "only Israel decides it");
        yield* engine.decideGate({
          runId: escalated.runId,
          gateKey: "escalated:ask@1",
          option: "answer",
          note: "SQLite",
        });
        yield* waitFor(escalated.runId, "ended");
        const after = yield* engine.runState(escalated.runId);
        assert.include(turnOf(after, "turn:resume@1").prompt, "The answer: SQLite");

        const direct = yield* engine.start(request("manual:direct"));
        yield* waitFor(direct.runId, "result:ask:ask@1");
        const routed = yield* engine.runView({ runId: direct.runId as never });
        assert.equal(routed.summary.openGates, 0);
        yield* engine.decideGate({
          runId: direct.runId,
          gateKey: "ask@1",
          option: "answer",
          note: "MySQL",
        });
        yield* waitFor(direct.runId, "ended");
        const state = yield* engine.runState(direct.runId);
        assert.equal(state.gates.get("ask@1")?.decision?.by, "user");
        assert.isFalse(state.gates.has("escalated:ask@1"));
        assert.include(turnOf(state, "turn:resume@1").prompt, "The answer: MySQL");

        // An ask that cannot reach the bot hands the gate to Israel: the original takes no decision.
        fake.missingBots.add(BOT);
        const unreachable = yield* engine.start(request("manual:unreachable"));
        yield* waitFor(unreachable.runId, "result:notify:gate:escalated:ask@1");
        for (const late of [{ bot: BOT }, {}]) {
          const refused = yield* engine
            .decideGate({
              runId: unreachable.runId,
              gateKey: "ask@1",
              option: "answer",
              note: "late",
              ...late,
            })
            .pipe(Effect.flip);
          assert.include(refused.message, "went to Israel as escalated:ask@1");
        }
        yield* engine.decideGate({
          runId: unreachable.runId,
          gateKey: "escalated:ask@1",
          option: "answer",
          note: "Redis",
        });
        yield* waitFor(unreachable.runId, "ended");
        const handed = yield* engine.runState(unreachable.runId);
        assert.isNull(handed.gates.get("ask@1")?.decision);
        assert.include(turnOf(handed, "turn:resume@1").prompt, "The answer: Redis");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
            layer,
            layerCatalog([askTheBot]),
          ),
        ),
      );
    }),
);

// A phase that cannot go on ends with `{ status: blocked, kind, detail }`; a branch per kind.
const typedFleet = compile({
  bot: BOT,
  params: { tickets: { type: "string[]", maxItems: 10, pattern: "[A-Z]+-\\d+" } },
  workspaces: {
    item: { project: "t3code", base: "friend/main", perItem: true, branchPolicy: "agent" },
  },
  nodes: {
    fleet: {
      kind: "map",
      items: "params.tickets",
      maxItems: 10,
      concurrency: 2,
      body: {
        nodes: {
          implement: {
            kind: "agent",
            model: "$lead",
            prompt: "Implement {{ item }}.",
            workspace: "item",
            access: "write",
            thread: { visible: true, kanbanCard: "{{ item }}" },
            output: {
              status: { type: "string", pattern: "done|blocked" },
              kind: { type: "string", pattern: "technical|product|secret|access", optional: true },
              detail: { type: "string", optional: true },
            },
          },
          triage: {
            kind: "branch",
            cases: [
              { port: "technical", when: "nodes.implement.output.kind == 'technical'" },
              { port: "access", when: "nodes.implement.output.kind == 'access'" },
              { port: "stop", when: "nodes.implement.output.status == 'blocked'" },
            ],
            else: "go",
          },
          ask_bot: {
            kind: "gate",
            answerBy: "bot",
            ask: "{{ item }}: {{ nodes.implement.output.detail }}",
            options: ["answer"],
          },
          ask_israel: {
            kind: "gate",
            ask: "{{ item }} needs access: {{ nodes.implement.output.detail }}",
            options: ["answer"],
          },
          resume: {
            kind: "agent",
            model: "$lead",
            join: "any",
            prompt: "Go on: {{ nodes.ask_bot.answer }}{{ nodes.ask_israel.answer }}",
            workspace: "item",
            access: "write",
            thread: "continue:implement",
          },
          done: {
            kind: "output",
            status: "ready_for_review",
            join: "any",
            value: { ticket: "{{ item }}", status: "done" },
            report: "{{ item }}: done",
            postToBot: true,
          },
          blocked: {
            kind: "output",
            status: "blocked",
            value: {
              ticket: "{{ item }}",
              status: "blocked:{{ nodes.implement.output.kind }}",
              reason: "{{ nodes.implement.output.detail }}",
            },
            report: "{{ item }} blocked:{{ nodes.implement.output.kind }}",
            postToBot: true,
          },
        },
        edges: [
          "implement -> triage",
          "triage:technical -> ask_bot",
          "triage:access -> ask_israel",
          "triage:stop -> blocked",
          "triage:go -> done",
          "ask_bot:answer -> resume",
          "ask_israel:answer -> resume",
          "resume -> done",
        ],
      },
    },
    report: {
      kind: "output",
      status: "ready_for_review",
      value: {},
      report: "{{ table(nodes.fleet.output, 'ticket', 'status', 'reason') }}",
      postToBot: true,
    },
  },
  edges: ["fleet -> report"],
});

it.effect("a technical block the bot answers ends done; a product block ends blocked:product", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFakeInterpreter({
      tickets: TICKETS,
      turns: {
        "fleet[0]/implement": {
          output: { status: "blocked", kind: "technical", detail: "which queue, sqs or redis?" },
        },
        "fleet[1]/implement": {
          output: { status: "blocked", kind: "product", detail: "the copy needs a PM call" },
        },
      },
    });
    yield* Effect.gen(function* () {
      const subscription = yield* (yield* Journal).subscribe;
      const engine = yield* make({ runsDir: "/runs" });
      const { runId } = yield* engine.start(fleetStart);
      const gateKey = "fleet[0]/ask_bot@1";
      // The bot hears of the technical question while the run goes on, not at the end.
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.key === `result:ask:${gateKey}`,
        }),
      );
      const asked = askPosts(fake, gateKey);
      assert.equal(asked.length, 1);
      assert.include(asked[0]![1].report, "BACK-1: which queue, sqs or redis?");
      const waiting = yield* engine.runState(runId);
      const thread = turnOf(waiting, "turn:fleet[0]/implement@1").threadId;
      assert.include(asked[0]![1].report, `Item thread: ${thread}`);
      yield* engine.decideGate({ runId, gateKey, option: "answer", note: "sqs", bot: BOT });
      yield* PubSub.take(subscription).pipe(
        Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === "ended" }),
      );
      const state = yield* engine.runState(runId);
      assert.equal(state.ended?.status, "succeeded");
      const resume = turnOf(state, "turn:fleet[0]/resume@1");
      assert.equal(resume.threadId, thread);
      assert.include(resume.prompt, "Go on: sqs");
      assert.isFalse(state.gates.has("fleet[1]/ask_bot@1"));
      assert.deepEqual(state.attempts.get("fleet")?.at(-1)?.resolved?.output, [
        { ticket: "BACK-1", status: "done" },
        { ticket: "BACK-2", status: "blocked:product", reason: "the copy needs a PM call" },
      ]);
      assert.deepEqual(
        [...fake.posts.values()].map((p) => p.report).sort(),
        [
          asked[0]![1].report,
          "BACK-1: done",
          "BACK-2 blocked:product",
          [
            "| ticket | status | reason |",
            "| --- | --- | --- |",
            "| BACK-1 | done |  |",
            "| BACK-2 | blocked:product | the copy needs a PM call |",
          ].join("\n"),
        ].sort(),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layerFromDb.pipe(Layer.provide(BotsDb.layerMemory)),
          layer,
          layerCatalog([typedFleet]),
        ),
      ),
    );
  }),
);
