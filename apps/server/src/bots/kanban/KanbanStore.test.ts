import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  BotId,
  KanbanTicketId,
  KanbanViewId,
  KANBAN_DEFAULT_VIEW_CONFIG,
  KANBAN_SEED_VIEWS,
  LinearAccountId,
  LOCAL_KANBAN_WORKSPACE_ID,
  ProjectId,
  linearWorkspaceId,
} from "@t3tools/contracts";

import * as BotsDb from "../BotsDb.ts";
import {
  KanbanStore,
  layerFromDb,
  type LinearTicketRow,
  type LocalTicketRow,
  type OrganizationCatalog,
} from "./KanbanStore.ts";

const AT = "2026-10-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-1");
const ACCOUNT = LinearAccountId.make("account-1");
const TICKET = KanbanTicketId.make("ticket-1");
const layer = layerFromDb.pipe(Layer.provideMerge(BotsDb.layerMemory));
const local: LocalTicketRow = {
  id: TICKET,
  projectId: PROJECT,
  localNumber: 1,
  title: "Local",
  state: "todo",
  priority: 2,
  assigneeId: "owner",
  creatorId: "owner",
  labelIds: ["label-1", "label-2"],
  description: "Description",
  sortOrder: 3,
  createdAt: AT,
};
const synced: LinearTicketRow = {
  id: TICKET,
  issueId: "issue-1",
  teamId: "team-1",
  url: "https://linear.app/issue/ONE-1",
  identifier: "ONE-1",
  title: "Synced",
  stateId: "state-1",
  assigneeId: "user-1",
  assigneeName: "One",
  creatorId: "user-2",
  priority: 1,
  estimate: 5,
  dueDate: "2026-11-01",
  labelIds: ["label-1"],
  linearProjectId: "lp-1",
  milestoneId: "m-1",
  cycleId: "c-1",
  parent: { issueId: "parent-1", identifier: "ONE-0", title: "Parent" },
  subIssues: { total: 4, closed: 2 },
  pullRequests: [
    {
      attachmentId: "pr-1",
      url: "https://github.com/a/b/pull/1",
      repository: "a/b",
      number: 1,
      title: "PR",
      state: "merged",
    },
  ],
  sortOrder: 12.5,
  closedAt: AT,
  autoClosed: true,
  createdAt: AT,
  updatedAt: AT,
};
const seedAccount = Effect.gen(function* () {
  const store = yield* KanbanStore;
  yield* store.insertAccount({
    id: ACCOUNT,
    name: "Account",
    keyLast4: "1234",
    userName: "User",
    userId: "user-1",
    userAvatarUrl: "https://example.com/avatar",
    organizationId: "org-1",
    organizationName: "Org",
    organizationUrlKey: "org",
    createdAt: AT,
    updatedAt: AT,
  });
  return store;
});
const catalog = (org: string): OrganizationCatalog => ({
  people: [
    {
      id: `user-${org}`,
      organizationId: org,
      name: org,
      displayName: org,
      avatarUrl: null,
      active: true,
    },
  ],
  labels: [
    {
      id: `label-${org}`,
      workspaceId: linearWorkspaceId(org),
      teamId: null,
      name: org,
      color: "#ffffff",
      parentId: null,
      source: "linear",
    },
  ],
  projects: [
    { id: `project-${org}`, organizationId: org, name: org, color: "#ffffff", icon: null },
  ],
  milestones: [{ id: `milestone-${org}`, projectId: `project-${org}`, name: org, sortOrder: 1 }],
});

describe("KanbanStore v2", () => {
  it.effect(
    "round-trips synced fields and preserves T3 ownership and description on later syncs",
    () =>
      Effect.gen(function* () {
        const store = yield* seedAccount;
        const sql = yield* SqlClient.SqlClient;
        yield* store.upsertLinearTickets(PROJECT, ACCOUNT, [synced]);
        const ticket = Option.getOrThrow(yield* store.getTicket(TICKET));
        const { issueId, teamId, url, stateId, ...fields } = synced;
        assert.deepStrictEqual(ticket, {
          ...fields,
          projectId: PROJECT,
          linear: { accountId: ACCOUNT, issueId, teamId, url },
          status: { kind: "linear", stateId },
          botId: null,
          threadIds: [],
        });
        const bot = BotId.make("bot-1");
        yield* sql`INSERT INTO bots (id, name, role, model_json, home_generation, position, created_at, updated_at) VALUES (${bot}, 'Bot', '', '{}', 1, 0, ${AT}, ${AT})`;
        yield* store.setTicketBot(TICKET, bot, "2026-10-03T00:00:00.000Z");
        assert.equal(Option.getOrThrow(yield* store.getTicket(TICKET)).updatedAt, AT);
        yield* sql`UPDATE kanban_tickets SET description = 'T3 description' WHERE id = ${TICKET}`;
        yield* store.upsertLinearTickets(PROJECT, ACCOUNT, [
          { ...synced, title: "New", updatedAt: "2026-10-02T00:00:00.000Z" },
        ]);
        assert.equal(Option.getOrThrow(yield* store.getTicket(TICKET)).botId, bot);
        assert.deepStrictEqual(
          yield* sql`SELECT description FROM kanban_tickets WHERE id = ${TICKET}`,
          [{ description: "T3 description" }],
        );
        yield* sql`UPDATE kanban_tickets SET pull_requests = 'broken', sub_total = 0, parent_title = NULL WHERE id = ${TICKET}`;
        const repaired = Option.getOrThrow(yield* store.getTicket(TICKET));
        assert.deepStrictEqual(repaired.pullRequests, []);
        assert.isNull(repaired.subIssues);
        assert.isNull(repaired.parent);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "returns seeded views in order, reorders partially, and falls back from invalid configs",
    () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore;
        const sql = yield* SqlClient.SqlClient;
        const initial = yield* store.listViews;
        assert.deepStrictEqual(
          initial.map((view) => view.id),
          KANBAN_SEED_VIEWS.map((view) => view.id),
        );
        const last = initial[4]!;
        yield* store.reorderViews([last.id]);
        assert.deepStrictEqual(
          (yield* store.listViews).map((view) => view.id),
          [last.id, ...initial.slice(0, 4).map((view) => view.id)],
        );
        yield* sql`UPDATE kanban_views SET config = '{"filters":[{"kind":"unknown"}]}' WHERE id = ${last.id}`;
        assert.deepStrictEqual(
          Option.getOrThrow(yield* store.getView(last.id)).config,
          KANBAN_DEFAULT_VIEW_CONFIG,
        );
        assert.deepStrictEqual((yield* store.listViews)[0]?.config.filters, []);
        const added = {
          ...last,
          id: KanbanViewId.make("view-new"),
          linearViewId: "linear-view",
          name: "New",
        };
        yield* store.insertView(added);
        yield* store.updateView({ ...added, name: "Renamed" });
        assert.equal((yield* store.listViews).at(-1)?.name, "Renamed");
        assert.equal(
          Option.getOrThrow(yield* store.findViewByLinearId("linear-view")).id,
          added.id,
        );
        yield* store.deleteView(added.id);
        assert.isTrue(Option.isNone(yield* store.getView(added.id)));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("updates local fields, clears descriptions, and removes deleted label references", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      yield* store.insertLocalTicket(local);
      yield* store.insertLocalLabel(
        {
          id: "label-1",
          workspaceId: LOCAL_KANBAN_WORKSPACE_ID,
          teamId: null,
          name: "Label",
          color: "#ffffff",
          parentId: null,
          source: "local",
        },
        AT,
      );
      assert.equal(Option.getOrThrow(yield* store.getLocalDescription(TICKET)), "Description");
      yield* store.updateLocalTicket(TICKET, {
        description: null,
        assigneeId: null,
        dueDate: "2026-11-01",
        updatedAt: AT,
      });
      assert.isTrue(Option.isNone(yield* store.getLocalDescription(TICKET)));
      yield* store.deleteLocalLabel("label-1");
      const ticket = Option.getOrThrow(yield* store.getTicket(TICKET));
      assert.deepStrictEqual(ticket.labelIds, ["label-2"]);
      assert.equal(ticket.title, local.title);
      assert.equal(ticket.priority, local.priority);
      assert.equal(ticket.creatorId, local.creatorId);
      assert.equal(ticket.sortOrder, local.sortOrder);
      assert.isNull(ticket.assigneeId);
      assert.equal(ticket.dueDate, "2026-11-01");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("cascades ticket deletion to comments and events and scopes comment deletion", () =>
    Effect.gen(function* () {
      const store = yield* KanbanStore;
      yield* store.insertLocalTicket(local);
      const comment = {
        id: "comment-1",
        ticketId: TICKET,
        authorId: "owner",
        body: "Hello",
        createdAt: AT,
        updatedAt: AT,
      };
      const event = {
        id: "event-1",
        ticketId: TICKET,
        actorId: null,
        text: "Created",
        createdAt: AT,
      };
      yield* store.insertLocalComment(comment);
      yield* store.insertTicketEvent(event);
      assert.deepStrictEqual(yield* store.listLocalComments(TICKET), [comment]);
      assert.deepStrictEqual(yield* store.listTicketEvents(TICKET), [event]);
      assert.isFalse(yield* store.deleteLocalComment(KanbanTicketId.make("other"), comment.id));
      assert.isTrue(yield* store.deleteLocalComment(TICKET, comment.id));
      assert.isFalse(yield* store.deleteLocalComment(TICKET, comment.id));
      yield* store.insertLocalComment(comment);
      yield* store.deleteTicket(TICKET);
      assert.deepStrictEqual(yield* store.listLocalComments(TICKET), []);
      assert.deepStrictEqual(yield* store.listTicketEvents(TICKET), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "replaces only one organization's catalogs including removed projects' milestones",
    () =>
      Effect.gen(function* () {
        const store = yield* KanbanStore;
        const localLabel = {
          id: "label-local",
          workspaceId: LOCAL_KANBAN_WORKSPACE_ID,
          teamId: null,
          name: "aaa",
          color: "#000000",
          parentId: null,
          source: "local" as const,
        };
        yield* store.insertLocalLabel(localLabel, AT);
        yield* store.replaceOrganizationCatalog(
          "org-1",
          linearWorkspaceId("org-1"),
          catalog("org-1"),
        );
        yield* store.replaceOrganizationCatalog(
          "org-2",
          linearWorkspaceId("org-2"),
          catalog("org-2"),
        );
        yield* store.replaceOrganizationCatalog("org-1", linearWorkspaceId("org-1"), {
          people: [],
          labels: [],
          projects: [],
          milestones: [],
        });
        assert.deepStrictEqual(yield* store.listPeople, catalog("org-2").people);
        assert.deepStrictEqual(yield* store.listLabels, [...catalog("org-2").labels, localLabel]);
        assert.deepStrictEqual(yield* store.listLinearProjects, catalog("org-2").projects);
        assert.deepStrictEqual(
          yield* store.listMilestones,
          catalog("org-2").milestones.map(({ sortOrder: _sortOrder, ...milestone }) => milestone),
        );
        const cycle = {
          id: "cycle-1",
          teamId: "team-1",
          number: 1,
          name: null,
          startsAt: AT,
          endsAt: AT,
        };
        yield* store.replaceTeamCycles("team-1", [cycle]);
        yield* store.replaceTeamCycles("team-2", [{ ...cycle, id: "cycle-2", teamId: "team-2" }]);
        yield* store.replaceTeamCycles("team-1", []);
        assert.deepStrictEqual(yield* store.listCycles, [
          { ...cycle, id: "cycle-2", teamId: "team-2" },
        ]);
      }).pipe(Effect.provide(layer)),
  );
});
