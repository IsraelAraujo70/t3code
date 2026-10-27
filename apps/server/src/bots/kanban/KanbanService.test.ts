import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import {
  BotId,
  KANBAN_DEFAULT_VIEW_CONFIG,
  KanbanError,
  kanbanBotPersonId,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type KanbanCycle,
  type KanbanSnapshot,
  type LinearWorkflowState,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BotsDb from "../BotsDb.ts";
import { BotsStore, layerFromDb as botsStoreFromDb } from "../BotsStore.ts";
import * as KanbanStore from "./KanbanStore.ts";
import { accountSecretName, KanbanService, layerService } from "./KanbanService.ts";
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
} from "./LinearClient.ts";
import type { LinearHistoryEntry } from "./linearMapping.ts";

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
    deleteComment: () => Effect.void,
    people: () => catalog("people", () => PEOPLE),
    labels: () => catalog("labels", () => LABELS),
    linearProjects: () => catalog("projects", () => world.projects),
    milestones: () => catalog("milestones", () => world.milestones),
    cycles: (_key, teamId) =>
      catalog(`cycles:${teamId}`, () => world.cycles.filter((cycle) => cycle.teamId === teamId)),
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

const insertBot = (id: string, name: string) =>
  Effect.gen(function* () {
    const botId = BotId.make(id);
    yield* (yield* BotsStore).insertBot({
      id: botId,
      name,
      role: "",
      model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      homeGeneration: 1,
      sectionId: null,
      position: 0,
      canManageBots: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    return botId;
  });

const user = (id: string, name: string) => ({
  id,
  name,
  displayName: name.toLowerCase(),
  avatarUrl: null,
});

const historyEntry = (
  id: string,
  createdAt: string,
  overrides: Partial<LinearHistoryEntry>,
): LinearHistoryEntry => ({
  id,
  createdAt,
  actor: null,
  botActor: null,
  fromState: null,
  toState: null,
  fromAssignee: null,
  toAssignee: null,
  fromPriority: null,
  toPriority: null,
  addedLabels: null,
  removedLabels: null,
  fromParent: null,
  toParent: null,
  fromTitle: null,
  toTitle: null,
  fromDueDate: null,
  toDueDate: null,
  fromProject: null,
  toProject: null,
  fromCycle: null,
  toCycle: null,
  fromEstimate: null,
  toEstimate: null,
  archived: null,
  trashed: null,
  autoClosed: null,
  autoArchived: null,
  ...overrides,
});

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
  it.effect("a full sync fills every card field and reads each catalog once per pass", () => {
    const { linear, layer } = setup();
    const pullRequest = {
      attachmentId: "a-1",
      url: "https://github.com/moneria/api/pull/7",
      repository: "moneria/api",
      number: 7,
      title: "Fix",
      state: "open" as const,
    };
    linear.window = [
      issue("1", {
        assigneeId: "u-bia",
        assigneeName: "Bia",
        creatorId: "u-israel",
        labelIds: ["l-bug"],
        pullRequests: [pullRequest],
        parent: { issueId: "p", identifier: "BACK-p", title: "Parent" },
        subIssues: { total: 2, closed: 1 },
        projectId: "lp-1",
        milestoneId: "m-1",
        cycleId: "cy-1",
        estimate: 3,
        dueDate: "2026-11-01",
        sortOrder: -4.5,
      }),
      issue("f1", { teamId: OTHER_TEAM, stateId: "f-todo" }),
    ];
    return Effect.gen(function* () {
      const { kanban, account } = yield* linkedBoard;
      yield* kanban.linkProject({
        projectId: OTHER_PROJECT,
        accountId: account.id,
        teamId: OTHER_TEAM,
        linearProjectId: null,
      });
      linear.catalogReads.length = 0;
      yield* kanban.sync({});
      // Two links of one organization: its catalog once, each team's cycles once.
      assert.deepStrictEqual(linear.catalogReads, [
        "people",
        "labels",
        "projects",
        "milestones",
        `cycles:${TEAM}`,
        `cycles:${OTHER_TEAM}`,
      ]);

      const snapshot = yield* kanban.readSnapshot;
      const ticket = ticketByIssue(snapshot, "1")!;
      assert.deepStrictEqual(
        {
          assigneeId: ticket.assigneeId,
          creatorId: ticket.creatorId,
          labelIds: ticket.labelIds,
          pullRequests: ticket.pullRequests,
          parent: ticket.parent,
          subIssues: ticket.subIssues,
          linearProjectId: ticket.linearProjectId,
          milestoneId: ticket.milestoneId,
          cycleId: ticket.cycleId,
          estimate: ticket.estimate,
          dueDate: ticket.dueDate,
          sortOrder: ticket.sortOrder,
        },
        {
          assigneeId: "u-bia",
          creatorId: "u-israel",
          labelIds: ["l-bug"],
          pullRequests: [pullRequest],
          parent: { issueId: "p", identifier: "BACK-p", title: "Parent" },
          subIssues: { total: 2, closed: 1 },
          linearProjectId: "lp-1",
          milestoneId: "m-1",
          cycleId: "cy-1",
          estimate: 3,
          dueDate: "2026-11-01",
          sortOrder: -4.5,
        },
      );
      assert.equal(snapshot.accounts[0]?.userId, "u-israel");
      assert.deepStrictEqual(
        snapshot.people.map((person) => [person.id, person.organizationId]),
        [
          ["u-bia", "org-moneria"],
          ["u-israel", "org-moneria"],
        ],
      );
      assert.deepStrictEqual(
        snapshot.labels.map((label) => [label.id, label.workspaceId, label.source]),
        [
          ["l-bug", linearWorkspaceId("org-moneria"), "linear"],
          ["l-front", linearWorkspaceId("org-moneria"), "linear"],
        ],
      );
      assert.deepStrictEqual(
        snapshot.linearProjects.map((project) => project.id),
        ["lp-1"],
      );
      assert.deepStrictEqual(
        snapshot.milestones.map((milestone) => milestone.id),
        ["m-1"],
      );
      assert.deepStrictEqual(
        snapshot.cycles.map((cycle) => cycle.id),
        ["cy-1"],
      );

      linear.catalogReads.length = 0;
      yield* kanban.poll;
      assert.isTrue(linear.queries.some((query) => query.kind === "since"));
      assert.deepStrictEqual(linear.catalogReads, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an issue's detail with board links, own comments and its creation", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1", { creatorId: "u-bia" }), issue("p"), issue("c1")];
    linear.detail = {
      description: "",
      parent: { issueId: "p", identifier: "BACK-p", title: "Issue p", stateId: "s-doing" },
      children: [
        {
          id: "c1",
          identifier: "BACK-c1",
          title: "Issue c1",
          priority: 2,
          url: "https://linear.app/c1",
          stateId: "s-done",
          assigneeId: "u-israel",
        },
        {
          id: "c2",
          identifier: "BACK-c2",
          title: "Elsewhere",
          priority: 0,
          url: "https://linear.app/c2",
          stateId: "s-todo",
          assigneeId: null,
        },
      ],
      comments: [
        {
          id: "lc-2",
          body: "later",
          createdAt: "2026-10-03T00:00:00.000Z",
          editedAt: null,
          user: user("u-bia", "Bia"),
          botActor: null,
          parentId: "lc-1",
        },
        {
          id: "lc-1",
          body: "mine",
          createdAt: "2026-10-02T00:00:00.000Z",
          editedAt: null,
          user: user("u-israel", "Israel"),
          botActor: null,
          parentId: null,
        },
        {
          id: "lc-3",
          body: "linked a PR",
          createdAt: "2026-10-04T00:00:00.000Z",
          editedAt: null,
          user: null,
          botActor: { name: "GitHub", avatarUrl: null },
          parentId: null,
        },
      ],
      history: [
        historyEntry("h-2", "2026-10-03T00:00:00.000Z", {
          actor: user("u-israel", "Israel"),
          fromState: { name: "A Fazer" },
          toState: { name: "Em Progresso" },
        }),
        historyEntry("h-noop", "2026-10-02T12:00:00.000Z", {}),
        historyEntry("h-1", "2026-10-02T00:00:00.000Z", {
          botActor: { name: "GitHub", avatarUrl: null },
          addedLabels: [{ name: "Bug" }],
        }),
      ],
    };
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const snapshot = yield* kanban.readSnapshot;
      const ticket = ticketByIssue(snapshot, "1")!;
      const detail = yield* kanban.ticketDetail({ ticketId: ticket.id });

      assert.isNull(detail.description);
      assert.deepStrictEqual(detail.parent, {
        issueId: "p",
        ticketId: ticketByIssue(snapshot, "p")!.id,
        identifier: "BACK-p",
        title: "Issue p",
        status: { kind: "linear", stateId: "s-doing" },
      });
      assert.deepStrictEqual(
        detail.children.map((child) => [child.identifier, child.ticketId, child.status]),
        [
          ["BACK-c1", ticketByIssue(snapshot, "c1")!.id, { kind: "linear", stateId: "s-done" }],
          ["BACK-c2", null, { kind: "linear", stateId: "s-todo" }],
        ],
      );
      assert.deepStrictEqual(
        detail.comments.map((comment) => [comment.id, comment.authorId, comment.deletable]),
        [
          ["lc-1", "u-israel", true],
          ["lc-2", "u-bia", false],
          ["lc-3", null, false],
        ],
      );
      assert.equal(detail.comments[2]?.authorName, "GitHub");
      assert.deepStrictEqual(
        detail.activity.map((entry) => [entry.actorName, entry.text, entry.createdAt]),
        [
          ["Bia", "created the issue", "2026-10-01T00:00:00.000Z"],
          ["GitHub", "added label Bug", "2026-10-02T00:00:00.000Z"],
          ["Israel", "changed status from A Fazer to Em Progresso", "2026-10-03T00:00:00.000Z"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends only the changed keys to Linear and keeps Linear's answer", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1", { projectId: "lp-1" })];
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const ticket = ticketByIssue(yield* kanban.readSnapshot, "1")!;

      const updated = yield* kanban.updateTicket({
        ticketId: ticket.id,
        patch: { priority: 1, assigneeId: "u-bia", milestoneId: "m-1", dueDate: null },
      });
      assert.deepStrictEqual(linear.updates, [
        {
          issueId: "1",
          input: { priority: 1, assigneeId: "u-bia", projectMilestoneId: "m-1", dueDate: null },
        },
      ]);
      // Only Linear's answer names the assignee.
      assert.equal(updated.assigneeName, "Bia");
      assert.deepStrictEqual([updated.priority, updated.milestoneId], [1, "m-1"]);

      const refusals = [
        [{ assigneeId: "u-stranger" }, "not in the workspace"],
        [{ labelIds: ["l-front"] }, "cannot be used"],
        [{ cycleId: "cy-other" }, "not in the team"],
        [{ linearProjectId: null, milestoneId: "m-1" }, "not in the project"],
      ] as const;
      for (const [patch, message] of refusals) {
        const refused = yield* kanban
          .updateTicket({ ticketId: ticket.id, patch })
          .pipe(Effect.flip);
        assert.include(refused.message, message);
      }
      linear.refuseUpdates = true;
      const refused = yield* kanban
        .updateTicket({ ticketId: ticket.id, patch: { title: "Renamed" } })
        .pipe(Effect.flip);
      assert.equal(refused.message, "Linear: forbidden");

      assert.equal(linear.updates.length, 1);
      assert.deepStrictEqual(ticketByIssue(yield* kanban.readSnapshot, "1"), updated);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sets a Linear ticket's own bot without calling Linear", () => {
    const { linear, layer } = setup();
    linear.window = [issue("1")];
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const botId = yield* insertBot("b_1", "Ops");
      const ticket = ticketByIssue(yield* kanban.readSnapshot, "1")!;

      const owned = yield* kanban.updateTicket({ ticketId: ticket.id, patch: { botId } });
      assert.equal(owned.botId, botId);
      assert.equal(owned.updatedAt, ticket.updatedAt);
      const unknown = yield* kanban
        .updateTicket({ ticketId: ticket.id, patch: { botId: BotId.make("b_missing") } })
        .pipe(Effect.flip);
      assert.include(unknown.message, "does not exist");
      assert.deepStrictEqual(linear.updates, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes a new Linear ticket's priority, assignee and labels to Linear", () => {
    const { linear, layer } = setup();
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      yield* kanban.createTicket({
        projectId: PROJECT,
        title: "[t3code-test] y",
        priority: 2,
        assigneeId: "u-bia",
        labelIds: ["l-bug"],
      });
      assert.deepStrictEqual(linear.created, [
        {
          teamId: TEAM,
          projectId: null,
          title: "[t3code-test] y",
          description: null,
          priority: 2,
          assigneeId: "u-bia",
          labelIds: ["l-bug"],
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("edits a local ticket, refuses Linear-only fields, and keeps its history", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService;
      yield* kanban.addAccount({ name: "Moneria", apiKey: KEY });
      const botId = yield* insertBot("b_1", "Ops");
      const chore = yield* kanban.createLabel({ name: "Chore", color: "#123456" });
      const first = yield* kanban.createTicket({ projectId: OTHER_PROJECT, title: "Write docs" });
      yield* TestClock.adjust("1 second");
      const ticket = yield* kanban.createTicket({
        projectId: OTHER_PROJECT,
        title: "Ship",
        priority: 3,
        assigneeId: kanbanBotPersonId(botId),
        labelIds: [chore.id],
      });
      assert.isBelow(ticket.sortOrder, first.sortOrder);
      assert.deepStrictEqual(
        [ticket.priority, ticket.assigneeId, ticket.labelIds, ticket.creatorId],
        [3, "bot:b_1", [chore.id], "owner"],
      );

      const refusals = [
        [{ estimate: 2 }, "local ticket"],
        [{ cycleId: null }, "local ticket"],
        [{ labelIds: ["l-bug"] }, "not a local label"],
        [{ assigneeId: "u-bia" }, "assigned to you or to an existing bot"],
        [{ assigneeId: "bot:b_missing" }, "assigned to you or to an existing bot"],
      ] as const;
      for (const [patch, message] of refusals) {
        const refused = yield* kanban
          .updateTicket({ ticketId: ticket.id, patch })
          .pipe(Effect.flip);
        assert.include(refused.message, message);
      }

      yield* TestClock.adjust("1 second");
      const updated = yield* kanban.updateTicket({
        ticketId: ticket.id,
        patch: {
          title: "Ship it",
          description: "Steps",
          priority: 2,
          assigneeId: "owner",
          labelIds: [],
          dueDate: "2026-11-01",
        },
      });
      assert.deepStrictEqual(
        [updated.title, updated.priority, updated.assigneeId, updated.labelIds, updated.dueDate],
        ["Ship it", 2, "owner", [], "2026-11-01"],
      );
      yield* TestClock.adjust("1 second");
      yield* kanban.moveTicket({
        ticketId: ticket.id,
        to: { kind: "local", state: "in_progress" },
      });
      yield* TestClock.adjust("1 second");
      const note = yield* kanban.comment({ ticketId: ticket.id, body: "Soon" });
      assert.deepStrictEqual(
        [note.authorId, note.authorName, note.deletable],
        ["owner", "Israel", true],
      );

      const detail = yield* kanban.ticketDetail({ ticketId: ticket.id });
      assert.equal(detail.description, "Steps");
      assert.deepStrictEqual(
        detail.activity.map((entry) => entry.text),
        [
          "created the ticket",
          "changed the title from Ship to Ship it",
          "updated the description",
          "set priority to High",
          "assigned to Israel",
          "removed label Chore",
          "set due date to Nov 1",
          "moved from Todo to In progress",
        ],
      );
      assert.isTrue(detail.activity.every((entry) => entry.actorName === "Israel"));
      assert.deepStrictEqual(
        detail.comments.map((comment) => comment.body),
        ["Soon"],
      );

      const missing = yield* kanban
        .deleteComment({ ticketId: ticket.id, commentId: "c_missing" })
        .pipe(Effect.flip);
      assert.include(missing.message, "does not exist");
      yield* kanban.deleteComment({ ticketId: ticket.id, commentId: note.id });
      assert.deepStrictEqual((yield* kanban.ticketDetail({ ticketId: ticket.id })).comments, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("saves, renames, reorders and deletes views", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const kanban = yield* KanbanService;
      const viewIds = Effect.map(kanban.readSnapshot, (snapshot) =>
        snapshot.views.map((view) => view.id),
      );
      const seeded = yield* viewIds;

      const saved = yield* kanban.saveView({
        projectId: null,
        name: "Mine",
        icon: null,
        config: KANBAN_DEFAULT_VIEW_CONFIG,
      });
      assert.deepStrictEqual(yield* viewIds, [...seeded, saved.id]);

      yield* TestClock.adjust("1 second");
      const renamed = yield* kanban.saveView({
        id: saved.id,
        projectId: PROJECT,
        name: "Renamed",
        icon: "Zap",
        config: { ...KANBAN_DEFAULT_VIEW_CONFIG, layout: "list" },
      });
      assert.equal(renamed.createdAt, saved.createdAt);
      assert.notEqual(renamed.updatedAt, saved.updatedAt);

      yield* kanban.reorderViews({ viewIds: [saved.id] });
      const first = (yield* kanban.readSnapshot).views[0];
      assert.deepStrictEqual(
        [first?.id, first?.name, first?.projectId, first?.config.layout],
        [saved.id, "Renamed", PROJECT, "list"],
      );
      assert.deepStrictEqual(yield* viewIds, [saved.id, ...seeded]);

      yield* kanban.deleteView({ viewId: saved.id });
      assert.deepStrictEqual(yield* viewIds, seeded);
      const gone = yield* kanban.deleteView({ viewId: saved.id }).pipe(Effect.flip);
      assert.include(gone.message, "does not exist");
    }).pipe(Effect.provide(layer));
  });

  it.effect("imports the Linear views T3 can express, once", () => {
    const { linear, layer } = setup();
    const view = (id: string, name: string, teamId: string | null, filterData: unknown) => ({
      id,
      name,
      icon: null,
      color: null,
      shared: true,
      teamId,
      filterData,
    });
    linear.customViews = [
      view("cv-mine", "My bugs", TEAM, {
        assignee: { isMe: { eq: true } },
        labels: { name: { eq: "bug" } },
      }),
      view("cv-title", "Titles", null, { title: { containsIgnoreCase: "x" } }),
      view("cv-all", "Everything", null, {}),
    ];
    return Effect.gen(function* () {
      const { kanban, account } = yield* linkedBoard;
      const first = yield* kanban.importLinearViews({ accountId: account.id });
      assert.deepStrictEqual(
        first.imported.map((imported) => [
          imported.name,
          imported.projectId,
          imported.linearViewId,
        ]),
        [
          ["My bugs", PROJECT, "cv-mine"],
          ["Everything", null, "cv-all"],
        ],
      );
      assert.deepStrictEqual(first.imported[0]?.config.filters, [
        { kind: "set", field: "assignee", op: "in", values: ["me"] },
        { kind: "set", field: "label", op: "in", values: ["l-bug"] },
      ]);
      assert.deepStrictEqual(
        first.skipped.map((skipped) => skipped.name),
        ["Titles"],
      );
      assert.include(first.skipped[0]?.reason ?? "", "not supported");

      const second = yield* kanban.importLinearViews({ accountId: account.id });
      assert.deepStrictEqual(second.imported, []);
      assert.deepStrictEqual(
        second.skipped.map((skipped) => [skipped.name, skipped.reason === "already imported"]),
        [
          ["My bugs", true],
          ["Titles", false],
          ["Everything", true],
        ],
      );
      const linearViews = (yield* kanban.readSnapshot).views.filter(
        (saved) => saved.linearViewId !== null,
      );
      assert.equal(linearViews.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates and deletes local labels, never Linear ones", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kanban } = yield* linkedBoard;
      const chore = yield* kanban.createLabel({ name: "Chore", color: "#123456" });
      assert.deepStrictEqual(
        (yield* kanban.readSnapshot).labels.map((label) => [label.id, label.source]),
        [
          ["l-bug", "linear"],
          ["l-front", "linear"],
          [chore.id, "local"],
        ],
      );
      assert.equal(chore.workspaceId, LOCAL_KANBAN_WORKSPACE_ID);

      const refused = yield* kanban.deleteLabel({ labelId: "l-bug" }).pipe(Effect.flip);
      assert.include(refused.message, "Linear label");
      yield* kanban.deleteLabel({ labelId: chore.id });
      assert.deepStrictEqual(
        (yield* kanban.readSnapshot).labels.map((label) => label.id),
        ["l-bug", "l-front"],
      );
      const unknown = yield* kanban.deleteLabel({ labelId: chore.id }).pipe(Effect.flip);
      assert.include(unknown.message, "does not exist");
    }).pipe(Effect.provide(layer));
  });
});
