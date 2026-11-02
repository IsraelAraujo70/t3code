import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import {
  KanbanError,
  ProjectId,
  type KanbanCycle,
  type LinearWorkflowState,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as BotsDb from "../../BotsDb.ts";
import { layerFromDb as botsStoreFromDb } from "../../BotsStore.ts";
import * as KanbanStore from "../../kanban/KanbanStore.ts";
import { KanbanService, layerService } from "../../kanban/KanbanService.ts";
import {
  LinearClient,
  type LinearCustomView,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearIssueScope,
  type LinearIssueUpdate,
  type LinearLabel,
  type LinearMilestone,
  type LinearPerson,
  type LinearProject,
} from "../../kanban/LinearClient.ts";

const PROJECT = ProjectId.make("project-1");
const KEY = "lin_api_secret_value_1234";
const TEAM = "team-back";
const OTHER_TEAM = "team-front";

const states: ReadonlyArray<LinearWorkflowState> = [
  { id: "s-todo", teamId: TEAM, name: "A Fazer", type: "unstarted", position: 1, color: "#ccc" },
  {
    id: "s-doing",
    teamId: TEAM,
    name: "Em Progresso",
    type: "started",
    position: 2,
    color: "#ff0",
  },
  { id: "s-done", teamId: TEAM, name: "Concluído", type: "completed", position: 3, color: "#0f0" },
  { id: "f-todo", teamId: OTHER_TEAM, name: "Todo", type: "unstarted", position: 1, color: "#ccc" },
];

const issue = (id: string, overrides: Partial<LinearIssue> = {}): LinearIssue => ({
  id,
  identifier: `BACK-${id}`,
  title: `Issue ${id}`,
  url: `https://linear.app/moneria/issue/BACK-${id}`,
  priority: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
  stateId: "s-todo",
  teamId: TEAM,
  assigneeName: null,
  assigneeId: null,
  creatorId: null,
  estimate: null,
  dueDate: null,
  labelIds: [],
  projectId: null,
  milestoneId: null,
  cycleId: null,
  parent: null,
  subIssues: null,
  pullRequests: [],
  sortOrder: 0,
  closedAt: null,
  autoClosed: false,
  ...overrides,
});

type IssueQuery =
  | { readonly kind: "window"; readonly scope: LinearIssueScope }
  | { readonly kind: "since"; readonly scope: LinearIssueScope; readonly updatedAfter: string }
  | { readonly kind: "ids"; readonly ids: ReadonlyArray<string> };

const PEOPLE: ReadonlyArray<LinearPerson> = [
  { id: "u-israel", name: "Israel", displayName: "israel", avatarUrl: "https://a/i", active: true },
  { id: "u-bia", name: "Bia", displayName: "bia", avatarUrl: null, active: true },
];
const LABELS: ReadonlyArray<LinearLabel> = [
  { id: "l-bug", name: "Bug", color: "#f00", parentId: null, teamId: null },
  { id: "l-front", name: "Front", color: "#0f0", parentId: null, teamId: OTHER_TEAM },
];

/** Linear's answer to an update: the issue as it was, with the update applied. */
function applyUpdate(current: LinearIssue, input: LinearIssueUpdate): LinearIssue {
  const { projectId, projectMilestoneId, description: _description, ...same } = input;
  return {
    ...current,
    ...same,
    ...(projectId === undefined ? {} : { projectId }),
    ...(projectMilestoneId === undefined ? {} : { milestoneId: projectMilestoneId }),
    ...(input.assigneeId === undefined
      ? {}
      : { assigneeName: PEOPLE.find((person) => person.id === input.assigneeId)?.name ?? null }),
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
}

/**
 * Linear as the tests see it: `window` answers full syncs, `changes` answers incremental ones,
 * and every key it is called with is recorded so a test can tell which secret reached it.
 */
function makeLinear() {
  const world = {
    window: [] as LinearIssue[],
    changes: [] as LinearIssue[],
    byId: new Map<string, LinearIssue>(),
    refuseMoves: false,
    refuseUpdates: false,
    keys: [] as string[],
    queries: [] as IssueQuery[],
    moves: [] as Array<{ issueId: string; stateId: string }>,
    updates: [] as Array<{ issueId: string; input: LinearIssueUpdate }>,
    created: [] as Array<Parameters<LinearClient["Service"]["createIssue"]>[1]>,
    /** Every catalog read (people, labels, projects, milestones, cycles), in order. */
    catalogReads: [] as string[],
    projects: [{ id: "lp-1", name: "API", color: "#00f", icon: "Bug" }] as LinearProject[],
    milestones: [{ id: "m-1", projectId: "lp-1", name: "Beta", sortOrder: 1 }] as LinearMilestone[],
    cycles: [
      {
        id: "cy-1",
        teamId: TEAM,
        number: 7,
        name: null,
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-10-14T00:00:00.000Z",
      },
    ] as KanbanCycle[],
    detail: null as LinearIssueDetail | null,
    customViews: [] as LinearCustomView[],
    /** The issue of each comment Linear knows. */
    commentIssues: new Map<string, string>(),
    deletedComments: [] as string[],
    /** Teams whose cycles Linear refuses to read. */
    failCycles: new Set<string>(),
  };
  const seen = (key: Redacted.Redacted) => {
    world.keys.push(Redacted.value(key));
  };
  const catalog = <A>(name: string, value: () => A) =>
    Effect.sync(() => {
      world.catalogReads.push(name);
      return value();
    });
  const service = LinearClient.of({
    viewer: (key) =>
      Effect.sync(() => {
        seen(key);
        return {
          userName: "Israel",
          userId: "u-israel",
          userAvatarUrl: "https://a/i",
          organizationId: "org-moneria",
          organizationName: "Moneria",
          organizationUrlKey: "moneria",
        };
      }),
    teams: (key) =>
      Effect.sync(() => {
        seen(key);
        return [
          { id: TEAM, key: "BACK", name: "Back-end", projects: [{ id: "lp-1", name: "API" }] },
          { id: OTHER_TEAM, key: "FRONT", name: "Front-end", projects: [] },
        ];
      }),
    teamStates: (key, teamId) =>
      Effect.sync(() => {
        seen(key);
        return states.filter((state) => state.teamId === teamId);
      }),
    issues: (key, scope, window) =>
      Effect.sync(() => {
        seen(key);
        const inTeam = (list: LinearIssue[]) => list.filter((one) => one.teamId === scope.teamId);
        if (window.updatedAfter === undefined) {
          world.queries.push({ kind: "window", scope });
          return inTeam(world.window);
        }
        world.queries.push({ kind: "since", scope, updatedAfter: window.updatedAfter });
        return inTeam(world.changes);
      }),
    issuesById: (key, ids) =>
      Effect.sync(() => {
        seen(key);
        world.queries.push({ kind: "ids", ids });
        return ids.flatMap((id) => {
          const found = world.byId.get(id);
          return found === undefined ? [] : [found];
        });
      }),
    setIssueState: (_key, issueId, stateId) =>
      world.refuseMoves
        ? Effect.fail(new KanbanError({ message: "Linear: forbidden" }))
        : Effect.sync(() => {
            world.moves.push({ issueId, stateId });
            return issue(issueId, { stateId, updatedAt: "2026-10-05T00:00:00.000Z" });
          }),
    createIssue: (_key, input) =>
      Effect.sync(() => {
        world.created.push(input);
        return issue("new", { title: input.title, updatedAt: "2026-10-06T00:00:00.000Z" });
      }),
    updateIssue: (_key, issueId, input) =>
      world.refuseUpdates
        ? Effect.fail(new KanbanError({ message: "Linear: forbidden" }))
        : Effect.sync(() => {
            world.updates.push({ issueId, input });
            const current =
              world.window.find((one) => one.id === issueId) ?? world.byId.get(issueId);
            return applyUpdate(current ?? issue(issueId), input);
          }),
    issueDetail: () =>
      world.detail === null ? Effect.die("no issue detail set") : Effect.succeed(world.detail),
    createComment: (_key, _issueId, body) =>
      Effect.succeed({
        id: "lc-new",
        body,
        createdAt: "2026-10-08T00:00:00.000Z",
        editedAt: null,
        user: { id: "u-israel", name: "Israel", displayName: "israel", avatarUrl: null },
        botActor: null,
        parentId: null,
      }),
    commentIssueId: (_key, commentId) => Effect.succeed(world.commentIssues.get(commentId) ?? null),
    deleteComment: (_key, commentId) =>
      Effect.sync(() => {
        world.deletedComments.push(commentId);
      }),
    people: () => catalog("people", () => PEOPLE),
    labels: () => catalog("labels", () => LABELS),
    linearProjects: () => catalog("projects", () => world.projects),
    milestones: () => catalog("milestones", () => world.milestones),
    cycles: (_key, teamId) =>
      catalog(`cycles:${teamId}`, () =>
        world.cycles.filter((cycle) => cycle.teamId === teamId),
      ).pipe(
        Effect.tap(() =>
          world.failCycles.has(teamId)
            ? Effect.fail(new KanbanError({ message: "Linear: cycles unavailable" }))
            : Effect.void,
        ),
      ),
    customViews: () => Effect.succeed(world.customViews),
  });
  return { world, layer: Layer.succeed(LinearClient, service) };
}

function makeSecrets() {
  const stored = new Map<string, Uint8Array>();
  const layer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
      set: (name, value) => Effect.sync(() => void stored.set(name, value)),
      create: (name, value) => Effect.sync(() => void stored.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => stored.get(name) ?? new Uint8Array(bytes)),
      remove: (name) => Effect.sync(() => void stored.delete(name)),
    }),
  );
  return { stored, layer };
}

type StoreService = KanbanStore.KanbanStore["Service"];

/** `storeOverrides` replaces store methods for the service and the test alike. */
function setup(
  options: { readonly storeOverrides?: (store: StoreService) => Partial<StoreService> } = {},
) {
  const linear = makeLinear();
  const secrets = makeSecrets();
  const storeLayer = Layer.effect(
    KanbanStore.KanbanStore,
    Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      return KanbanStore.KanbanStore.of({ ...store, ...options.storeOverrides?.(store) });
    }),
  ).pipe(Layer.provide(KanbanStore.layerFromDb));
  const layer = layerService.pipe(
    Layer.provideMerge(Layer.merge(storeLayer, botsStoreFromDb)),
    Layer.provide(BotsDb.layerMemory),
    Layer.provide(linear.layer),
    Layer.provide(secrets.layer),
  );
  return { linear: linear.world, secrets: secrets.stored, layer };
}

import { WorkflowCards, layer as cardsLayer } from "./WorkflowCards.ts";

describe("WorkflowCards", () => {
  it.effect("creates once, moves, and never links a thread", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const cards = yield* WorkflowCards;
      const store = yield* KanbanStore.KanbanStore;
      const input = {
        runId: "run",
        projectId: PROJECT,
        title: "Workflow",
        column: "todo" as const,
        link: "/workflows/runs/run",
      };
      const first = yield* cards.upsert(input);
      assert.deepStrictEqual(yield* cards.upsert(input), first);
      assert.deepStrictEqual(yield* cards.upsert({ ...input, column: "in_review" }), first);
      const tickets = yield* store.listTickets;
      assert.equal(tickets.length, 1);
      assert.deepStrictEqual(tickets[0]?.status, { kind: "local", state: "in_review" });
      assert.deepStrictEqual(tickets[0]?.threadIds, []);
      assert.deepStrictEqual(
        yield* store.getLocalDescription(first.ticketId),
        Option.some("wf-run:run\n/workflows/runs/run"),
      );
    }).pipe(Effect.provide(cardsLayer.pipe(Layer.provideMerge(layer))));
  });
  it.effect("refuses a Linear project before creating a ticket", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService;
      const account = yield* kanban.addAccount({ name: "Test", apiKey: KEY });
      yield* kanban.linkProject({
        projectId: PROJECT,
        accountId: account.id,
        teamId: TEAM,
        linearProjectId: null,
      });
      const cards = yield* WorkflowCards;
      const error = yield* cards
        .upsert({ runId: "run", projectId: PROJECT, title: "Run", column: "todo", link: "/run" })
        .pipe(Effect.flip);
      assert.equal(error.message, "the project is linked to Linear");
      assert.isFalse(error.retryable);
      assert.deepStrictEqual(yield* (yield* KanbanStore.KanbanStore).listTickets, []);
    }).pipe(Effect.provide(cardsLayer.pipe(Layer.provideMerge(layer))));
  });
});
