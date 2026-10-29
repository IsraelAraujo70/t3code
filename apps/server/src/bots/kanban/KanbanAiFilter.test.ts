import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";

import { KanbanSnapshot, ProjectId } from "@t3tools/contracts";

import { BotsStore } from "../BotsStore.ts";
import { OPENROUTER_KEY_ENV } from "../openRouter.ts";
import {
  buildAiFilterPrompt,
  KanbanAiFilter,
  layerLive,
  parseAiFilterAnswer,
} from "./KanbanAiFilter.ts";
import { KanbanService } from "./KanbanService.ts";

describe("parseAiFilterAnswer", () => {
  it.effect("keeps the valid clauses and drops the invalid ones", () =>
    Effect.gen(function* () {
      const result = yield* parseAiFilterAnswer(
        '{"filters":[{"kind":"set","field":"priority","op":"in","values":["1"]},{"kind":"set","field":"mood","op":"in","values":[]},{"kind":"flag","field":"hasThreads","value":true}]}',
      );
      assert.deepStrictEqual(result, {
        filters: [
          { kind: "set", field: "priority", op: "in", values: ["1"] },
          { kind: "flag", field: "hasThreads", value: true },
        ],
      });
    }),
  );

  it.effect("reads a JSON fence, even after prose", () =>
    Effect.gen(function* () {
      const result = yield* parseAiFilterAnswer(
        'Here you go:\n```json\n{"filters":[{"kind":"text","field":"content","value":"bug"}]}\n```',
      );
      assert.deepStrictEqual(result, {
        filters: [{ kind: "text", field: "content", value: "bug" }],
      });
    }),
  );

  it.effect("fails when nothing usable is left", () =>
    Effect.gen(function* () {
      for (const text of [
        "garbage",
        '{"filters":[]}',
        '{"filters":[{"kind":"nope"}]}',
        '{"other":true}',
      ]) {
        const error = yield* Effect.flip(parseAiFilterAnswer(text));
        assert.strictEqual(error.message, "Could not turn that into filters.");
      }
    }),
  );
});

const snapshot = Schema.decodeUnknownSync(KanbanSnapshot)({
  accounts: ["one", "two"].map((id) => ({
    id: `account-${id}`,
    name: `Account ${id}`,
    keyLast4: "1234",
    userName: id,
    userId: null,
    userAvatarUrl: null,
    organizationId: `org-${id}`,
    organizationName: id,
    organizationUrlKey: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  })),
  links: ["one", "two"].map((id) => ({
    projectId: `project-${id}`,
    accountId: `account-${id}`,
    teamId: `team-${id}`,
    teamKey: id,
    teamName: id,
    linearProjectId: null,
    linearProjectName: null,
    lastSyncedAt: null,
    syncError: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  })),
  states: ["one", "two"].map((id) => ({
    id: `state-${id}`,
    teamId: `team-${id}`,
    name: `State ${id}`,
    type: "started",
    position: 0,
    color: "#ffffff",
  })),
  people: ["one", "two"].map((id) => ({
    id: `person-${id}`,
    organizationId: `org-${id}`,
    name: `Person ${id}`,
    displayName: id,
    avatarUrl: null,
    active: true,
  })),
  labels: [
    ...["one", "two"].map((id) => ({
      id: `label-${id}`,
      workspaceId: `linear:org-${id}`,
      teamId: `team-${id}`,
      name: `Label ${id}`,
      color: "#ffffff",
      parentId: null,
      source: "linear",
    })),
    {
      id: "label-local",
      workspaceId: "local",
      teamId: null,
      name: "Label local",
      color: "#ffffff",
      parentId: null,
      source: "local",
    },
  ],
  workspaces: [
    { id: "linear:org-one", name: "Org one", botIds: ["bot-one"] },
    { id: "linear:org-two", name: "Org two", botIds: ["bot-two"] },
  ],
  tickets: [],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
  allWorkspacesBotIds: [],
});
const bots = new Map([
  ["bot-one", "Bot one"],
  ["bot-two", "Bot two"],
]);

describe("buildAiFilterPrompt", () => {
  it("lists only the project's states, people, labels and bots, and today's date", () => {
    const prompt = buildAiFilterPrompt(snapshot, ProjectId.make("project-one"), "2026-10-27", bots);
    for (const text of [
      "State one",
      "Person one",
      "Label one",
      "Label local",
      "Bot one",
      "2026-10-27",
    ]) {
      assert.include(prompt, text);
    }
    for (const text of ["State two", "Person two", "Label two", "Bot two"]) {
      assert.notInclude(prompt, text);
    }
  });

  it("lists every scope on the all-projects board", () => {
    const prompt = buildAiFilterPrompt(snapshot, null, "2026-10-27", bots);
    for (const text of ["State one", "State two", "Person two", "Label two", "Bot two"]) {
      assert.include(prompt, text);
    }
  });
});

const decodeSnapshot = Schema.decodeUnknownSync(KanbanSnapshot);
const encodeSnapshot = Schema.encodeSync(KanbanSnapshot);

/** The service over a fake OpenRouter whose answer body never ends. */
const layerService = (board: KanbanSnapshot, requests: Array<string>) =>
  layerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(KanbanService)({ readSnapshot: Effect.succeed(board) }),
        Layer.mock(BotsStore)({ listBots: Effect.succeed([]) }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request.url);
              return HttpClientResponse.fromWeb(
                request,
                new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
              );
            }),
          ),
        ),
      ),
    ),
    // provideMerge: the key is read per call, in the test's context, not only while building.
    Layer.provideMerge(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [OPENROUTER_KEY_ENV]: "sk-test" } })),
    ),
  );

describe("KanbanAiFilter", () => {
  it.effect("gives up when the answer's body stalls after its headers", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const filter = yield* KanbanAiFilter;
      const fiber = yield* filter
        .filter({ text: "urgent", projectId: null })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.message, "Could not reach the AI filter service.");
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layerService(snapshot, requests)));
  });

  it.effect("refuses a catalog over the prompt budget without calling the model", () => {
    const requests: Array<string> = [];
    const huge = decodeSnapshot({
      ...encodeSnapshot(snapshot),
      labels: Array.from({ length: 3_000 }, (_, index) => ({
        id: `label-big-${index}`,
        workspaceId: "local",
        teamId: null,
        name: `A rather long label name number ${index}`,
        color: "#ffffff",
        parentId: null,
        source: "local",
      })),
    });
    return Effect.gen(function* () {
      const filter = yield* KanbanAiFilter;
      const error = yield* Effect.flip(filter.filter({ text: "urgent", projectId: null }));
      assert.match(error.message, /too large/);
      assert.strictEqual(requests.length, 0);
    }).pipe(Effect.provide(layerService(huge, requests)));
  });
});
