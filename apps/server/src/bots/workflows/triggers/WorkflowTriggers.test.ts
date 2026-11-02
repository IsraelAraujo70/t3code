// @effect-diagnostics globalDateInEffect:off preferSchemaOverJson:off - Fixtures supply explicit times and stored definition JSON.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { WorkflowRunId, type WorkflowTrigger } from "@t3tools/contracts";
import * as BotsDb from "../../BotsDb.ts";
import { Journal, layerFromDb, WorkflowJournalError } from "../Journal.ts";
import { upsertIndex, insertVersion } from "../definitions/definitionsStore.ts";
import { workflowStream } from "../facts.ts";
import type { TriggerRequest } from "../WorkflowEngine.ts";
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
