import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import {
  BotId,
  KanbanError,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanSnapshot,
  type LinearWorkflowState,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BotsDb from "../BotsDb.ts";
import { BotsStore, layerFromDb as botsStoreFromDb } from "../BotsStore.ts";
import * as KanbanStore from "./KanbanStore.ts";
import { accountSecretName, KanbanService, layerService } from "./KanbanService.ts";
import { LinearClient, type LinearIssue, type LinearIssueScope } from "./LinearClient.ts";

const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
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
  ...overrides,
});

type IssueQuery =
  | { readonly kind: "window"; readonly scope: LinearIssueScope }
  | { readonly kind: "since"; readonly scope: LinearIssueScope; readonly updatedAfter: string }
  | { readonly kind: "ids"; readonly ids: ReadonlyArray<string> };

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
    keys: [] as string[],
    queries: [] as IssueQuery[],
    moves: [] as Array<{ issueId: string; stateId: string }>,
  };
  const seen = (key: Redacted.Redacted) => {
    world.keys.push(Redacted.value(key));
  };
  const service = LinearClient.of({
    viewer: (key) =>
      Effect.sync(() => {
        seen(key);
        return {
          userName: "Israel",
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
        if (window.updatedAfter === undefined) {
          world.queries.push({ kind: "window", scope });
          return world.window;
        }
        world.queries.push({ kind: "since", scope, updatedAfter: window.updatedAfter });
        return world.changes;
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
      Effect.succeed(issue("new", { title: input.title, updatedAt: "2026-10-06T00:00:00.000Z" })),
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

function setup() {
  const linear = makeLinear();
  const secrets = makeSecrets();
  const layer = layerService.pipe(
    Layer.provideMerge(Layer.merge(KanbanStore.layerFromDb, botsStoreFromDb)),
    Layer.provide(BotsDb.layerMemory),
    Layer.provide(linear.layer),
    Layer.provide(secrets.layer),
  );
  return { linear: linear.world, secrets: secrets.stored, layer };
}

const linkedBoard = Effect.gen(function* () {
  const kanban = yield* KanbanService;
  const account = yield* kanban.addAccount({ name: "Moneria", apiKey: KEY });
  yield* kanban.linkProject({
    projectId: PROJECT,
    accountId: account.id,
    teamId: TEAM,
    linearProjectId: null,
  });
  return { kanban, account };
});

const ticketByIssue = (snapshot: KanbanSnapshot, issueId: string) =>
  snapshot.tickets.find((ticket) => ticket.linear?.issueId === issueId);

describe("KanbanService", () => {
  it.effect("keeps the API key in the secret store and shows clients only its last 4", () => {
    const { secrets, layer } = setup();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService;
      const first = yield* kanban.addAccount({ name: "Moneria", apiKey: KEY });
      yield* kanban.addAccount({ name: "Moneria (bots)", apiKey: KEY });
      const snapshot = yield* kanban.readSnapshot;

      assert.equal(first.keyLast4, "1234");
      assert.equal(new TextDecoder().decode(secrets.get(accountSecretName(first.id))), KEY);
      assert.notInclude(JSON.stringify(snapshot), KEY);
      // Two accounts on one organization are one workspace, beside the local one.
      assert.deepStrictEqual(
        snapshot.workspaces.map((workspace) => workspace.id),
        [LOCAL_KANBAN_WORKSPACE_ID, linearWorkspaceId("org-moneria")],
      );
      assert.equal(snapshot.accounts.length, 2);

      yield* kanban.deleteAccount({ accountId: first.id });
      assert.isFalse(secrets.has(accountSecretName(first.id)));
    }).pipe(Effect.provide(layer));
  });

  it.effect("fills a linked board at once, then applies only newer changes on each poll", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1"), issue("2", { updatedAt: "2026-10-02T00:00:00.000Z" })];
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      let snapshot = yield* kanban.readSnapshot;
      assert.deepStrictEqual(snapshot.tickets.map((ticket) => ticket.identifier).sort(), [
        "BACK-1",
        "BACK-2",
      ]);
      assert.deepStrictEqual(
        snapshot.states.map((state) => state.id),
        ["s-todo", "s-doing", "s-done"],
      );
      assert.isNull(snapshot.links[0]?.syncError);

      linear.changes = [
        issue("1", { stateId: "s-doing", updatedAt: "2026-10-03T00:00:00.000Z" }),
        issue("2", {
          archivedAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        }),
      ];
      yield* kanban.poll;
      snapshot = yield* kanban.readSnapshot;

      const since = linear.queries.flatMap((query) =>
        query.kind === "since" ? [query.updatedAfter] : [],
      );
      assert.deepStrictEqual(since, ["2026-10-02T00:00:00.000Z"]);
      assert.deepStrictEqual(ticketByIssue(snapshot, "1")?.status, {
        kind: "linear",
        stateId: "s-doing",
      });
      assert.isUndefined(ticketByIssue(snapshot, "2"));
      assert.isTrue(linear.keys.every((key) => key === KEY));
    }).pipe(Effect.provide(layer));
  });

  it.effect("records a failed sync on the link and clears it on the next success", () => {
    const { linear, secrets, layer } = setup();
    linear.window = [issue("1")];
    return Effect.gen(function* () {
      const { kanban, account } = yield* linkedBoard;
      secrets.delete(accountSecretName(account.id));
      yield* kanban.sync({});
      assert.include((yield* kanban.readSnapshot).links[0]?.syncError ?? "", "no API key");

      secrets.set(accountSecretName(account.id), new TextEncoder().encode(KEY));
      yield* kanban.sync({});
      assert.isNull((yield* kanban.readSnapshot).links[0]?.syncError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a ticket with threads after it leaves the window, until it is archived", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1"), issue("2")];
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const withThread = ticketByIssue(yield* kanban.readSnapshot, "1")!;
      yield* kanban.linkThread({ ticketId: withThread.id, threadId: ThreadId.make("thread-a") });

      linear.window = [];
      linear.byId.set("1", issue("1", { stateId: "s-done" }));
      yield* kanban.sync({ projectId: PROJECT });
      let snapshot = yield* kanban.readSnapshot;
      assert.deepStrictEqual(ticketByIssue(snapshot, "1")?.threadIds, [ThreadId.make("thread-a")]);
      assert.isUndefined(ticketByIssue(snapshot, "2"));

      linear.byId.set("1", issue("1", { archivedAt: "2026-10-04T00:00:00.000Z" }));
      yield* kanban.sync({ projectId: PROJECT });
      snapshot = yield* kanban.readSnapshot;
      assert.isUndefined(ticketByIssue(snapshot, "1"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("moves a Linear ticket only to what Linear answers", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1")];
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const ticket = ticketByIssue(yield* kanban.readSnapshot, "1")!;

      const moved = yield* kanban.moveTicket({
        ticketId: ticket.id,
        to: { kind: "linear", stateId: "s-done" },
      });
      assert.deepStrictEqual(moved.status, { kind: "linear", stateId: "s-done" });
      assert.deepStrictEqual(linear.moves, [{ issueId: "1", stateId: "s-done" }]);

      linear.refuseMoves = true;
      const refused = yield* kanban
        .moveTicket({ ticketId: ticket.id, to: { kind: "linear", stateId: "s-todo" } })
        .pipe(Effect.flip);
      assert.equal(refused.message, "Linear: forbidden");
      const otherTeam = yield* kanban
        .moveTicket({ ticketId: ticket.id, to: { kind: "linear", stateId: "f-todo" } })
        .pipe(Effect.flip);
      assert.include(otherTeam.message, "not in the team");
      const local = yield* kanban
        .moveTicket({ ticketId: ticket.id, to: { kind: "local", state: "done" } })
        .pipe(Effect.flip);
      assert.include(local.message, "Linear issue");

      const after = ticketByIssue(yield* kanban.readSnapshot, "1");
      assert.deepStrictEqual(after?.status, { kind: "linear", stateId: "s-done" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs a local board without Linear", () => {
    const { linear, layer } = setup();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService;
      const first = yield* kanban.createTicket({ projectId: OTHER_PROJECT, title: "Write docs" });
      const second = yield* kanban.createTicket({
        projectId: OTHER_PROJECT,
        title: "Ship it",
        state: "backlog",
      });
      assert.deepStrictEqual([first.identifier, second.identifier], ["T-1", "T-2"]);
      assert.deepStrictEqual(first.status, { kind: "local", state: "todo" });

      const moved = yield* kanban.moveTicket({
        ticketId: first.id,
        to: { kind: "local", state: "in_review" },
      });
      assert.deepStrictEqual(moved.status, { kind: "local", state: "in_review" });

      const threadA = ThreadId.make("thread-a");
      const threadB = ThreadId.make("thread-b");
      yield* kanban.linkThread({ ticketId: first.id, threadId: threadA });
      yield* kanban.linkThread({ ticketId: first.id, threadId: threadB });
      const linked = yield* kanban.linkThread({ ticketId: first.id, threadId: threadA });
      assert.deepStrictEqual(linked.threadIds, [threadA, threadB]);
      const unlinked = yield* kanban.unlinkThread({ ticketId: first.id, threadId: threadA });
      assert.deepStrictEqual(unlinked.threadIds, [threadB]);

      yield* kanban.deleteTicket({ ticketId: second.id });
      const snapshot = yield* kanban.readSnapshot;
      assert.deepStrictEqual(
        snapshot.tickets.map((ticket) => ticket.id),
        [first.id],
      );
      assert.deepStrictEqual(linear.keys, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a linked project's ticket in Linear and refuses to delete it here", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const created = yield* kanban.createTicket({ projectId: PROJECT, title: "[t3code-test] x" });
      assert.equal(created.linear?.issueId, "new");
      assert.equal(created.title, "[t3code-test] x");
      const refused = yield* kanban.deleteTicket({ ticketId: created.id }).pipe(Effect.flip);
      assert.include(refused.message, "close or archive it there");
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops synced tickets when the project is unlinked, keeping local ones", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1")];
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      yield* kanban.unlinkProject({ projectId: PROJECT });
      const local = yield* kanban.createTicket({ projectId: PROJECT, title: "Local" });
      const snapshot = yield* kanban.readSnapshot;
      assert.deepStrictEqual(
        snapshot.tickets.map((ticket) => ticket.id),
        [local.id],
      );
      assert.deepStrictEqual(snapshot.links, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("assigns only existing bots to an existing workspace", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService;
      const botsStore = yield* BotsStore;
      const botId = BotId.make("b_1");
      yield* botsStore.insertBot({
        id: botId,
        name: "Ops",
        role: "",
        model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        homeGeneration: 1,
        sectionId: null,
        position: 0,
        canManageBots: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });

      yield* kanban.setWorkspaceBots({ workspaceId: LOCAL_KANBAN_WORKSPACE_ID, botIds: [botId] });
      const snapshot = yield* kanban.readSnapshot;
      assert.deepStrictEqual(snapshot.workspaces[0]?.botIds, [botId]);

      const unknownBot = yield* kanban
        .setWorkspaceBots({
          workspaceId: LOCAL_KANBAN_WORKSPACE_ID,
          botIds: [BotId.make("b_missing")],
        })
        .pipe(Effect.flip);
      assert.include(unknownBot.message, "does not exist");
      const unknownWorkspace = yield* kanban
        .setWorkspaceBots({ workspaceId: linearWorkspaceId("org-x"), botIds: [botId] })
        .pipe(Effect.flip);
      assert.include(unknownWorkspace.message, "does not exist");
    }).pipe(Effect.provide(layer));
  });
});
