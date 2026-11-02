import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { Journal, layerMemory } from "./Journal.ts";
import type { NewFact } from "./facts.ts";

it.effect("stores independent sequences, deduplicates, reads, and publishes committed facts", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const subscription = yield* journal.subscribe;
    const first: NewFact = {
      stream: "run:a",
      key: "one",
      fact: { _tag: "RunResumed", at: "original" },
    };
    const results = yield* journal.append([
      first,
      { ...first, fact: { _tag: "RunResumed", at: "changed" } },
      { ...first, key: "two" },
      { ...first, key: "three" },
      { ...first, stream: "run:b" },
    ]);
    assert.deepEqual(
      results.map((result) => [result.fact.seq, result.inserted]),
      [
        [1, true],
        [1, false],
        [2, true],
        [3, true],
        [1, true],
      ],
    );
    assert.deepEqual(results[1]?.fact.fact, first.fact);
    assert.deepEqual(
      (yield* journal.read("run:a", 1)).map((fact) => fact.seq),
      [2, 3],
    );
    assert.deepEqual(Option.getOrThrow(yield* journal.get("run:a", "one")).fact, first.fact);
    assert.isTrue(Option.isNone(yield* journal.get("run:a", "missing")));
    assert.deepEqual(yield* PubSub.take(subscription), results[0]?.fact);
  }).pipe(Effect.scoped, Effect.provide(layerMemory)),
);

it.effect("finds orphan triggers and unresolved intents on ended runs", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const trigger = {
      _tag: "TriggerFired",
      triggerId: "manual",
      kind: "manual",
      occurrence: "occ",
      label: "Manual",
      params: {},
      payload: null,
      causalDepth: 0,
      parent: null,
      at: "now",
    } as const;
    yield* journal.append([
      { stream: "workflow:a", key: "occ", fact: trigger },
      { stream: "workflow:b", key: "occ", fact: trigger },
      {
        stream: "workflow:b",
        key: "created:occ",
        fact: { _tag: "RunCreated", runId: "b", occurrence: "occ" },
      },
      { stream: "workflow:c", key: "occ", fact: trigger },
      {
        stream: "workflow:c",
        key: "skipped:occ",
        fact: { _tag: "TriggerSkipped", occurrence: "occ", reason: "busy" },
      },
      { stream: "run:a", key: "ended", fact: { _tag: "RunEnded", status: "succeeded", at: "now" } },
      {
        stream: "run:a",
        key: "unit",
        fact: {
          _tag: "IntentRecorded",
          intent: {
            _tag: "StartUnit",
            key: "unit",
            step: "check",
            attempt: 1,
            argv: ["true"],
            cwd: { name: "main", path: "/workspace" },
            heavy: false,
            replay: "safe",
            timeoutMs: 1000,
            env: {},
          },
        },
      },
    ]);
    assert.deepEqual(yield* journal.pendingTriggers, ["a"]);
    assert.deepEqual(yield* journal.liveRuns, ["a"]);
    yield* journal.append([
      {
        stream: "run:a",
        key: "result:unit",
        fact: { _tag: "UnitSpawned", unit: "test.service", at: "now" },
      },
    ]);
    assert.deepEqual(yield* journal.liveRuns, []);
    yield* journal.append([
      {
        stream: "run:z",
        key: "started",
        fact: {
          _tag: "RunStarted",
          workflowId: "demo",
          commit: "c1",
          hash: "h",
          title: "Demo",
          params: {},
          trigger: { kind: "manual", occurrence: "manual:1", label: "manual", payload: null },
          budget: { steps: 1, wallMs: 1000, tokens: 1, usd: null },
          parent: null,
          causalDepth: 0,
          at: "now",
        },
      },
    ]);
    assert.deepEqual(yield* journal.liveRuns, ["z"]);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("publishes only newly inserted facts", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const subscription = yield* journal.subscribe;
    const fact: NewFact = {
      stream: "run:new",
      key: "resume",
      fact: { _tag: "RunResumed", at: "original" },
    };
    const results = yield* journal.append([
      fact,
      { ...fact, fact: { _tag: "RunResumed", at: "changed" } },
    ]);
    assert.deepEqual(yield* PubSub.take(subscription), results[0]?.fact);
    assert.strictEqual(Option.getOrThrow(PubSub.remainingUnsafe(subscription)), 0);
    const duplicate = yield* journal.append([fact]);
    assert.isFalse(duplicate[0]!.inserted);
    assert.deepEqual(duplicate[0]?.fact, results[0]?.fact);
  }).pipe(Effect.scoped, Effect.provide(layerMemory)),
);
