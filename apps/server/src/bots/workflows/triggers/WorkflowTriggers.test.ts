// @effect-diagnostics globalDateInEffect:off preferSchemaOverJson:off - Fixtures supply explicit times and stored definition JSON.
import { assert, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { WorkflowRunId, type WorkflowTrigger } from "@t3tools/contracts";
import * as BotsDb from "../../BotsDb.ts";
import { Journal, layerFromDb, WorkflowJournalError } from "../Journal.ts";
import { upsertIndex, insertVersion } from "../definitions/definitionsStore.ts";
import { workflowStream } from "../facts.ts";
import type { TriggerRequest } from "../WorkflowEngine.ts";
import * as Stream from "effect/Stream";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { layerCountingJournal, type FactReads } from "../testkit/countingJournal.ts";
import { makeTriggerTargets } from "./targets.ts";
import { make } from "./WorkflowTriggers.ts";
import { getCursor } from "./cursors.ts";

const runId = Schema.decodeSync(WorkflowRunId)("wfr_00000000000000000000");
const seed = Effect.fn("test.seed")(function* (trigger: WorkflowTrigger) {
  yield* insertVersion({
    workflow_id: "daily",
    commit_sha: "head",
    revision: "rev",
    semantic_hash: "hash",
    source: "",
    author: "test",
    created_at: "now",
    definition_json: JSON.stringify({
      schema: "t3.workflow/v1",
      id: "daily",
      title: "Daily",
      home: { project: "project" },
      triggers: [trigger],
      budget: { steps: 10, wall: "1h", tokens: 100 },
      fatigue: { consecutiveFailures: 3 },
      nodes: {},
      edges: [],
    }),
  });
  yield* upsertIndex({
    workflow_id: "daily",
    path: "invalid.yaml",
    head_commit: "head",
    revision: "rev",
    title: "Daily",
    valid: 0,
    dirty: 1,
    diagnostics_json: "[]",
    triggers_json: "[]",
    scanned_at: "now",
  });
});
const toggle = Effect.fn("test.toggle")(function* (enabled: boolean, key: string) {
  const journal = yield* Journal;
  yield* journal.append([
    {
      stream: workflowStream("daily"),
      key,
      fact: { _tag: "Toggled", enabled, by: "test", at: "now" },
    },
  ]);
});
const services = layerFromDb.pipe(Layer.provideMerge(BotsDb.layerMemory));

it.effect(
  "initializes cron, retries failed starts, deduplicates and resets on disable using the HEAD triggers",
  () =>
    Effect.gen(function* () {
      yield* seed({
        id: "clock",
        kind: "cron",
        expr: "0 3 * * *",
        tz: "UTC",
        params: { day: "{{ trigger.at }}" },
      });
      yield* toggle(true, "on");
      const requests: TriggerRequest[] = [];
      let fail = true;
      const service = yield* make({
        engine: {
          start: (request) =>
            Effect.suspend(() => {
              requests.push(request);
              return fail
                ? Effect.fail(new WorkflowJournalError({ message: "retry" }))
                : Effect.succeed({ runId });
            }),
        },
      });
      yield* service.poll(new Date("2026-01-01T02:59:00Z"));
      expect(requests).toHaveLength(0);
      const before = yield* getCursor("cron:daily:clock");
      yield* service.poll(new Date("2026-01-01T03:00:30Z"));
      expect(yield* getCursor("cron:daily:clock")).toEqual(before);
      fail = false;
      yield* service.poll(new Date("2026-01-01T03:00:30Z"));
      yield* service.poll(new Date("2026-01-01T03:00:30Z"));
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        occurrence: "cron:clock:2026-01-01T03:00:00.000Z",
        params: { day: "2026-01-01T03:00:00.000Z" },
      });
      yield* toggle(false, "off");
      yield* service.poll(new Date("2026-01-02T03:00:30Z"));
      expect(Option.isNone(yield* getCursor("cron:daily:clock"))).toBe(true);
      yield* toggle(true, "again");
      yield* service.poll(new Date("2026-01-03T03:00:30Z"));
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(Layer.merge(services, NodeServices.layer))),
);

it.effect("reads each head commit's triggers once and the switch on every listing", () =>
  Effect.gen(function* () {
    const reads: FactReads = { facts: 0, createdRows: 0 };
    yield* Effect.gen(function* () {
      const clock = { id: "clock", kind: "cron", expr: "0 3 * * *", tz: "UTC" } as const;
      yield* seed(clock);
      yield* toggle(true, "on");
      const journal = yield* Journal;
      yield* journal.append(
        Array.from({ length: 200 }, (_, i) => [
          {
            stream: workflowStream("daily"),
            key: `cron:${i}`,
            fact: {
              _tag: "TriggerFired" as const,
              runId: `run-${i}`,
              triggerId: "clock",
              kind: "cron",
              occurrence: `cron:${i}`,
              label: "cron",
              params: {},
              payload: null,
              causalDepth: 0,
              parent: null,
              at: "now",
            },
          },
          {
            stream: workflowStream("daily"),
            key: `created:cron:${i}`,
            fact: { _tag: "RunCreated" as const, runId: `run-${i}`, occurrence: `cron:${i}` },
          },
        ]).flat(),
      );
      const list = yield* makeTriggerTargets;
      const ids = Effect.map(list, (targets) =>
        targets.map((t) => [t.trigger.id, t.enabled] as const),
      );
      assert.deepEqual(yield* ids, [["clock", true]]);
      reads.facts = 0;
      assert.deepEqual(yield* ids, [["clock", true]]);
      assert.isAtMost(reads.facts, 2);

      // A stored version never changes under its commit, so the listing keeps what it decoded.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE workflow_versions SET definition_json = '{}' WHERE commit_sha = 'head'`;
      yield* toggle(false, "off");
      assert.deepEqual(yield* ids, [["clock", false]]);

      yield* insertVersion({
        workflow_id: "daily",
        commit_sha: "next",
        revision: "rev2",
        semantic_hash: "hash2",
        source: "",
        author: "test",
        created_at: "now",
        definition_json: JSON.stringify({
          schema: "t3.workflow/v1",
          id: "daily",
          title: "Daily",
          home: { project: "project" },
          triggers: [{ ...clock, id: "later" }],
          budget: { steps: 10, wall: "1h", tokens: 100 },
          fatigue: { consecutiveFailures: 3 },
          nodes: {},
          edges: [],
        }),
      });
      yield* upsertIndex({
        workflow_id: "daily",
        path: "daily.yaml",
        head_commit: "next",
        revision: "rev2",
        title: "Daily",
        valid: 1,
        dirty: 0,
        diagnostics_json: "[]",
        triggers_json: "[]",
        scanned_at: "now",
      });
      assert.deepEqual(yield* ids, [["later", false]]);
    }).pipe(
      Effect.provide(
        layerCountingJournal(reads).pipe(
          Layer.provide(layerFromDb),
          Layer.provideMerge(BotsDb.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("baselines tags, respects pollMinutes and fires only new tags", () =>
  Effect.gen(function* () {
    yield* seed({
      id: "tags",
      kind: "upstreamTag",
      remote: "https://example.com/repo.git",
      pattern: "^v",
      pollMinutes: 5,
    });
    yield* toggle(true, "on");
    let tag = "v1";
    let queries = 0;
    const requests: TriggerRequest[] = [];
    const service = yield* make({
      listTags: () =>
        Effect.sync(() => {
          queries++;
          return `abcdef\trefs/tags/${tag}`;
        }),
      engine: {
        start: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return { runId };
          }),
      },
    });
    yield* service.poll(new Date("2026-01-01T00:00:00Z"));
    expect(requests).toHaveLength(0);
    tag = "v2";
    yield* service.poll(new Date("2026-01-01T00:01:00Z"));
    expect(queries).toBe(1);
    yield* service.poll(new Date("2026-01-01T00:05:00Z"));
    yield* service.poll(new Date("2026-01-01T00:10:00Z"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.occurrence).toBe("tag:https://example.com/repo.git:v2:abcdef");
  }).pipe(Effect.provide(Layer.merge(services, NodeServices.layer))),
);

it.effect("baselines repository merges and limits queries to ten minutes", () =>
  Effect.gen(function* () {
    yield* seed({ id: "pr", kind: "prMerged", scope: "repo", repo: "owner/repo" });
    yield* toggle(true, "on");
    let queries = 0;
    let merged = "2026-01-01T00:00:00Z";
    const requests: TriggerRequest[] = [];
    const service = yield* make({
      listPulls: () =>
        Effect.sync(() => {
          queries++;
          return JSON.stringify([
            {
              number: 1,
              title: "Change",
              html_url: "https://example.com/1",
              merged_at: merged,
              merge_commit_sha: "abc",
              base: { ref: "main" },
            },
          ]);
        }),
      engine: {
        start: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return { runId };
          }),
      },
    });
    yield* service.poll(new Date("2026-01-01T00:01:00Z"));
    expect(requests).toHaveLength(0);
    merged = "2026-01-01T00:05:00Z";
    yield* service.poll(new Date("2026-01-01T00:02:00Z"));
    expect(queries).toBe(1);
    yield* service.poll(new Date("2026-01-01T00:11:00Z"));
    yield* service.poll(new Date("2026-01-01T00:21:00Z"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.occurrence).toBe("pr:owner/repo#1:abc");
  }).pipe(Effect.provide(Layer.merge(services, NodeServices.layer))),
);

/**
 * Stored events by type; only the fields the triggers read are filled in. The real stream keeps
 * going live after the replay; this one ends, so each `followEvents` call is one catch-up.
 */
const orchestratorWith = (events: Array<{ sequence: number; event: unknown }>) =>
  Layer.merge(
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
      latestAgentSequence: () =>
        Effect.sync(() => Math.max(0, ...events.map((stored) => stored.sequence))),
    }),
    Layer.mock(OrchestratorV2)({
      streamStoredEventsFrom: (input) =>
        Stream.fromIterable(
          events.filter(
            (stored) =>
              stored.sequence > (input?.afterSequence ?? 0) &&
              (stored.event as { type: string }).type === input?.eventType,
          ) as unknown as ReadonlyArray<OrchestrationV2StoredEvent>,
        ),
    }),
  );

const settled = (sequence: number, id: string, title: string) => ({
  sequence,
  event: {
    type: "thread.settled",
    payload: {
      id,
      projectId: "project-app",
      title,
      lineage: { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
    },
  },
});

it.effect("fires on threads that settle after it is on, never on step threads, and retries", () =>
  Effect.gen(function* () {
    yield* seed({ id: "done", kind: "threadSettled", titlePrefix: "Review" });
    yield* toggle(true, "on");
    const events = [settled(1, "old", "Review old")];
    const requests: TriggerRequest[] = [];
    let fail = false;
    const service = yield* make({
      engine: {
        start: (request) =>
          Effect.suspend(() => {
            if (fail) return Effect.fail(new WorkflowJournalError({ message: "busy" }));
            requests.push(request);
            return Effect.succeed({ runId });
          }),
      },
    }).pipe(Effect.provide(orchestratorWith(events)));
    // The first catch-up only records where the event log is.
    yield* service.followEvents("thread.settled");
    expect(requests).toEqual([]);
    events.push(
      settled(2, "wf:wfr_00000000000000000000:0123456789abcdef", "Review step"),
      settled(3, "t-other", "Chat"),
      settled(4, "t-review", "Review PR 12"),
    );
    fail = true;
    yield* service.followEvents("thread.settled").pipe(Effect.exit);
    expect(requests).toEqual([]);
    fail = false;
    yield* service.followEvents("thread.settled");
    yield* service.followEvents("thread.settled");
    expect(requests.map((request) => request.occurrence)).toEqual(["settled:t-review:4"]);
    expect(requests[0]?.payload).toMatchObject({ threadId: "t-review", title: "Review PR 12" });
    expect(yield* getCursor("events:thread.settled")).toEqual(Option.some("4"));
  }).pipe(Effect.provide(Layer.merge(services, NodeServices.layer))),
);

const linkUpdated = (sequence: number, number: number, state: string, headSha?: string) => ({
  sequence,
  event: {
    type: "thread.pull-request-link-updated",
    payload: {
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      snapshot: { state, title: `PR ${number}`, baseBranch: "main" },
      ...(headSha === undefined ? {} : { watch: { headSha } }),
    },
  },
});

it.effect("fires once per merged linked PR, with or without a watched head", () =>
  Effect.gen(function* () {
    yield* seed({ id: "merged", kind: "prMerged", scope: "linked", repo: "acme/app" });
    yield* toggle(true, "on");
    const events: Array<{ sequence: number; event: unknown }> = [];
    const requests: TriggerRequest[] = [];
    const service = yield* make({
      engine: {
        start: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return { runId };
          }),
      },
    }).pipe(Effect.provide(orchestratorWith(events)));
    yield* service.followEvents("thread.pull-request-link-updated");
    events.push(
      linkUpdated(1, 7, "open", "aaa"),
      linkUpdated(2, 7, "merged", "bbb"),
      linkUpdated(3, 8, "merged"),
    );
    yield* service.followEvents("thread.pull-request-link-updated");
    yield* service.followEvents("thread.pull-request-link-updated");
    expect(requests.map((request) => request.occurrence)).toEqual([
      "pr:acme/app#7:bbb",
      "pr:acme/app#8:merged",
    ]);
    expect(requests[1]?.payload).toMatchObject({ number: 8, mergeSha: null });
  }).pipe(Effect.provide(Layer.merge(services, NodeServices.layer))),
);

it.effect("without a way to find the newest event, no follower starts and nothing old fires", () =>
  Effect.gen(function* () {
    yield* seed({ id: "done", kind: "threadSettled" });
    yield* toggle(true, "on");
    const requests: TriggerRequest[] = [];
    const service = yield* make({
      engine: {
        start: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return { runId };
          }),
      },
    }).pipe(
      Effect.provide(
        Layer.mock(OrchestratorV2)({
          streamStoredEventsFrom: () =>
            Stream.fromIterable([
              settled(1, "old", "Review old"),
            ]) as unknown as Stream.Stream<OrchestrationV2StoredEvent>,
        }),
      ),
    );
    yield* service.followEvents("thread.settled");
    expect(requests).toEqual([]);
    expect(yield* getCursor("events:thread.settled")).toEqual(Option.none());
  }).pipe(Effect.provide(Layer.merge(services, NodeServices.layer))),
);
