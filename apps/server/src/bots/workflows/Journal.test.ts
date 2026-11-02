import { WorkflowId, WorkflowRunId, type WorkflowRunSummary } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { Journal, layerMemory } from "./Journal.ts";
import { type NewFact, runStream } from "./facts.ts";
import { runStarted } from "./testkit/decideHarness.ts";

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
      runId: "wfr_00000000000000000001",
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

const summary = (
  runId: string,
  startedAt: string,
  patch: Partial<WorkflowRunSummary> = {},
): WorkflowRunSummary => ({
  runId: WorkflowRunId.make(runId),
  workflowId: WorkflowId.make("example"),
  title: "Example",
  hash: null,
  commit: null,
  status: "running",
  pausedFor: null,
  skipReason: null,
  trigger: { kind: "manual", label: "Manual" },
  startedAt,
  endedAt: null,
  outputStatus: null,
  stepsUsed: 0,
  cost: { billable: 0, input: 0, output: 0, cacheRead: 0, usage: "complete", usdEstimate: null },
  reservedTokens: 0,
  openGates: 0,
  pullRequest: null,
  ...patch,
});
const row = (s: WorkflowRunSummary, lastSeq: number) => ({
  summary: s,
  lastSeq,
  pendingIntents: 0,
  parentRunId: null,
});

it.effect(
  "projects run summaries: upserts forward only, pages newest first, picks the last run",
  () =>
    Effect.gen(function* () {
      const journal = yield* Journal;
      const older = summary("wfr_00000000000000000001", "2026-11-02T00:00:00.000Z");
      const newer = summary("wfr_00000000000000000002", "2026-11-02T01:00:00.000Z", {
        status: "failed",
      });
      yield* journal.putRun(row(older, 2));
      yield* journal.putRun(row({ ...older, title: "Stale" }, 1));
      yield* journal.putRun(row(newer, 5));
      assert.deepEqual(
        yield* journal.runs({ workflowId: "example", status: null, offset: 0, limit: 1 }),
        { runs: [newer], more: true },
      );
      assert.deepEqual(
        yield* journal.runs({ workflowId: "example", status: null, offset: 1, limit: 1 }),
        { runs: [older], more: false },
      );
      assert.deepEqual(
        yield* journal.runs({ workflowId: null, status: "running", offset: 0, limit: 10 }),
        { runs: [older], more: false },
      );
      assert.deepEqual(
        yield* journal.runs({ workflowId: "other", status: null, offset: 0, limit: 10 }),
        { runs: [], more: false },
      );
      assert.deepEqual((yield* journal.lastRuns).get("example"), newer);
    }).pipe(Effect.provide(layerMemory)),
);

it.effect("reports runs whose row is missing or behind, and counts a reopened run as live", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const started = (runId: string) => ({
      stream: runStream(runId),
      key: "started",
      fact: runStarted(),
    });
    const stale = "wfr_00000000000000000003";
    const missing = "wfr_00000000000000000004";
    yield* journal.append([started(stale), started(missing)]);
    yield* journal.append([
      {
        stream: runStream(stale),
        key: "ended",
        fact: { _tag: "RunEnded", status: "failed", at: "2026-11-02T00:00:00.000Z" },
      },
    ]);
    yield* journal.putRun(row(summary(stale, "2026-11-02T00:00:00.000Z"), 1));
    assert.deepEqual(yield* journal.projectionLag, [
      { runId: stale, projected: 1, stream: 2 },
      { runId: missing, projected: null, stream: 1 },
    ]);
    assert.deepEqual(yield* journal.liveRuns, [missing]);
    yield* journal.append([
      {
        stream: runStream(stale),
        key: "reopen:control:r1",
        fact: { _tag: "RunReopened", step: "a", by: "user", at: "2026-11-02T00:00:00.000Z" },
      },
    ]);
    assert.deepEqual(yield* journal.liveRuns, [stale, missing]);
    yield* journal.append([
      {
        stream: runStream(stale),
        key: "ended:1",
        fact: { _tag: "RunEnded", status: "succeeded", at: "2026-11-02T00:00:00.000Z" },
      },
    ]);
    assert.deepEqual(yield* journal.liveRuns, [missing]);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("writes a guarded fact only if none of the named kinds landed after its seq", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const stream = runStream("wfr_00000000000000000005");
    yield* journal.append([{ stream, key: "started", fact: runStarted() }]);
    yield* journal.append([
      {
        stream,
        key: "reopen:x",
        fact: { _tag: "RunReopened", step: "a", by: "user", at: "2026-11-02T00:00:00.000Z" },
      },
    ]);
    const released = (after: number): NewFact => ({
      stream,
      key: "released:wf/demo",
      fact: { _tag: "BranchReleased", branch: "wf/demo", to: "wfr_9" },
      guard: { absent: ["RunReopened"], after },
    });
    assert.deepEqual(yield* journal.append([released(1)]), []);
    const [stored] = yield* journal.append([released(2)]);
    assert.deepEqual([stored?.inserted, stored?.fact.seq], [true, 3]);
    // Already stored: returned as usual, whatever its guard says now.
    const [again] = yield* journal.append([released(1)]);
    assert.deepEqual([again?.inserted, again?.fact.seq], [false, 3]);
  }).pipe(Effect.provide(layerMemory)),
);
