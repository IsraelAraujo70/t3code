import { WorkflowId, WorkflowRunId, type WorkflowRunSummary } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import * as BotsDb from "../BotsDb.ts";
import { Journal, layerFromDb, layerMemory } from "./Journal.ts";
import { type NewFact, runStream, workflowStream } from "./facts.ts";
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
  trigger: { id: "manual", kind: "manual", label: "Manual" },
  startedAt,
  endedAt: null,
  outputStatus: null,
  stepsUsed: 0,
  cost: { billable: 0, input: 0, output: 0, cacheRead: 0, usage: "complete", usdEstimate: null },
  reservedTokens: 0,
  openGates: 0,
  pullRequest: null,
  activeMs: null,
  activeSince: null,
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
      const changes = yield* journal.subscribeRunChanges;
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
      // Lists hear of a new row and of a status, gate or end change, not of progress inside one.
      yield* journal.putRun(row({ ...older, stepsUsed: 1 }, 3));
      yield* journal.putRun(row({ ...older, stepsUsed: 1, openGates: 1 }, 4));
      assert.deepEqual(Array.from(yield* PubSub.takeAll(changes)), [
        "example",
        "example",
        "example",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerMemory)),
);

it.effect("stores the summary's active time in the run row", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const sql = yield* SqlClient.SqlClient;
    const runId = "wfr_00000000000000000003";
    yield* journal.putRun(row(summary(runId, "2026-11-02T00:00:00.000Z", { activeMs: 1234 }), 1));
    const rows = yield* sql<{ readonly active_ms: number }>`
      SELECT active_ms FROM workflow_runs WHERE run_id = ${runId}`;
    assert.deepEqual(rows, [{ active_ms: 1234 }]);
  }).pipe(Effect.provide(layerFromDb.pipe(Layer.provideMerge(BotsDb.layerMemory)))),
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

it.effect("reads a workflow's switch, backlog and live runs by kind, not its whole stream", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const stream = workflowStream("w");
    const at = "2026-11-02T00:00:00.000Z";
    const fired = (occurrence: string): NewFact => ({
      stream,
      key: occurrence,
      fact: {
        _tag: "TriggerFired",
        runId: `run-${occurrence}`,
        triggerId: "manual",
        kind: "manual",
        occurrence,
        label: "Manual",
        params: {},
        payload: null,
        causalDepth: 0,
        parent: null,
        at,
      },
    });
    const outcome = (runId: string, status: string): NewFact => ({
      stream,
      key: `outcome:${runId}`,
      fact: { _tag: "RunOutcome", runId, status },
    });
    const toggled = (key: string, enabled: boolean): NewFact => ({
      stream,
      key,
      fact: { _tag: "Toggled", enabled, by: "test", at },
    });
    assert.deepInclude(yield* journal.workflowStatus("w"), { enabled: false, suspended: false });
    yield* journal.append([
      toggled("toggled:1", true),
      fired("a"),
      { stream, key: "created:a", fact: { _tag: "RunCreated", runId: "r1", occurrence: "a" } },
      fired("b"),
      {
        stream,
        key: "skipped:b",
        fact: { _tag: "TriggerSkipped", occurrence: "b", reason: "busy" },
      },
      outcome("r1", "failed"),
      outcome("r2", "failed"),
      { stream, key: "suspended:r2", fact: { _tag: "Suspended", reason: "fatigue", at } },
      toggled("toggled:2", false),
    ]);
    assert.deepInclude(yield* journal.workflowStatus("w"), { enabled: false, suspended: true });
    yield* journal.append([
      { stream, key: "unsuspended:1", fact: { _tag: "Unsuspended", by: "test", at } },
      toggled("toggled:3", true),
      outcome("r3", "failed"),
      fired("c"),
      outcome("r4", "succeeded"),
      outcome("r5", "failed"),
    ]);
    assert.deepInclude(yield* journal.workflowStatus("w"), { enabled: true, suspended: false });
    const backlog = yield* journal.workflowBacklog("w", 2);
    assert.deepEqual(
      backlog.map((f) => f.key),
      ["c", "outcome:r4", "outcome:r5"],
    );
    assert.deepEqual(
      (yield* journal.workflowBacklog("w", 9)).map((f) => f.key),
      ["outcome:r3", "c", "outcome:r4", "outcome:r5"],
    );

    yield* journal.append([
      { stream: runStream("mine"), key: "started", fact: runStarted({ workflowId: "w" }) },
      { stream: runStream("done"), key: "started", fact: runStarted({ workflowId: "w" }) },
      { stream: runStream("done"), key: "ended", fact: { _tag: "RunEnded", status: "failed", at } },
      { stream: runStream("other"), key: "started", fact: runStarted({ workflowId: "x" }) },
    ]);
    assert.deepEqual(yield* journal.liveRunsOf("w"), ["mine"]);
    assert.deepEqual(yield* journal.liveRunsOf("none"), []);

    yield* TestClock.adjust("1 hour");
    yield* journal.append([
      { stream: runStream("done"), key: "late", fact: { _tag: "RunEnded", status: "failed", at } },
    ]);
    assert.deepEqual(yield* journal.runsTouchedSince("1970-01-01T00:30:00.000Z"), ["done"]);
    assert.deepEqual(yield* journal.runsTouchedSince("1970-01-01T00:00:00.000Z"), [
      "done",
      "mine",
      "other",
    ]);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("captures test deliveries once and lists trigger samples", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const input = { workflowId: "w", triggerId: "a", deliveryId: "d", payload: { value: 1 } };
    assert.equal(yield* journal.captureTestDelivery(input), "captured");
    assert.equal(yield* journal.captureTestDelivery({ ...input, payload: null }), "replayed");
    assert.isTrue(yield* journal.isTestDelivery("d"));
    assert.deepEqual(Option.getOrThrow(yield* journal.triggerSample("w", "a")).payload, {
      value: 1,
    });
    yield* journal.captureTestDelivery({ ...input, triggerId: "b", deliveryId: "e" });
    assert.equal((yield* journal.triggerLastFired).length, 2);
  }).pipe(Effect.provide(layerMemory)),
);

it.effect("projects only inserted trigger events and folds the latest switches", () =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const fired = (key: string, triggerId: string): NewFact => ({
      stream: workflowStream("w"),
      key,
      fact: {
        _tag: "TriggerFired",
        triggerId,
        runId: key,
        kind: "manual",
        occurrence: key,
        label: key,
        params: {},
        payload: { key },
        causalDepth: 0,
        parent: null,
        at: key,
      },
    });
    yield* journal.append([fired("one", "a"), fired("two", "a"), fired("three", "b")]);
    yield* journal.append([fired("one", "a")]);
    assert.equal(Option.getOrThrow(yield* journal.triggerSample("w", "a")).occurrence, "two");
    assert.equal((yield* journal.triggerLastFired).length, 2);
    yield* journal.append([
      {
        stream: workflowStream("w"),
        key: "off",
        fact: { _tag: "TriggerToggled", triggerId: "a", enabled: false, by: "test", at: "t" },
      },
      {
        stream: workflowStream("w"),
        key: "off-b",
        fact: { _tag: "TriggerToggled", triggerId: "b", enabled: false, by: "test", at: "t" },
      },
      {
        stream: workflowStream("w"),
        key: "on",
        fact: { _tag: "TriggerToggled", triggerId: "a", enabled: true, by: "test", at: "t" },
      },
    ]);
    assert.deepEqual((yield* journal.workflowStatus("w")).off, new Set(["b"]));
  }).pipe(Effect.provide(layerMemory)),
);
