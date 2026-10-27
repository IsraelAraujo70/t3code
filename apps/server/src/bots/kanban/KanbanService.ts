/**
 * Owns the kanban: Linear accounts and their keys, project links, tickets, thread links and the
 * bots responsible for each workspace, plus the sync that pulls Linear changes into tickets.
 *
 * Invariants:
 * - An account's API key is written to the server secret store under `accountSecretName` before
 *   its row, and is read only to call Linear. No answer carries it; clients get its last 4.
 * - A Linear ticket changes only from Linear's own answer: a move updates the issue in Linear
 *   first and stores what Linear returns, so a refused move changes nothing here.
 * - Syncs run one at a time (the poller and "Sync now" share one permit), so two syncs of a link
 *   never interleave their writes or cursors.
 * - `snapshot` publishes only after a write commits.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  KanbanError,
  KanbanTicketId,
  LinearAccountId,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  type KanbanProjectLink,
  type KanbanProjectLinkInput,
  type KanbanProjectRef,
  type KanbanSnapshot,
  type KanbanSyncInput,
  type KanbanTicket,
  type KanbanTicketCreateInput,
  type KanbanTicketMoveInput,
  type KanbanTicketRef,
  type KanbanTicketThreadInput,
  type KanbanWorkspace,
  type KanbanWorkspaceBotsInput,
  type KanbanWorkspaceId,
  type LinearAccount,
  type LinearAccountAddInput,
  type LinearAccountRef,
  type LinearAccountRenameInput,
  type LinearTeamsResult,
  type ProjectId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { BotsStore } from "../BotsStore.ts";
import * as KanbanStoreModule from "./KanbanStore.ts";
import { KanbanStore, type LinearTicketRow, type StoredProjectLink } from "./KanbanStore.ts";
import * as LinearClientModule from "./LinearClient.ts";
import { LinearClient, type LinearIssue } from "./LinearClient.ts";
import { planFullSync, planIncrementalSync, ticketsToRefresh } from "./syncPlan.ts";

/** A full sync re-reads the board's window this often; polls in between are incremental. */
const FULL_SYNC_EVERY_MS = 30 * 60_000;
/** Done and canceled issues stay on the board this long after their last update. */
const RECENT_WINDOW_DAYS = 30;
const FULL_SYNC_MAX_PAGES = 20;
const INCREMENTAL_MAX_PAGES = 10;

/** Where an account's API key lives in the server secret store. */
export const accountSecretName = (accountId: LinearAccountId) => `friend-linear-${accountId}`;

/** The workspace a ticket belongs to: its Linear organization, or the local workspace. */
export function workspaceOfTicket(
  ticket: Pick<KanbanTicket, "linear">,
  accountsById: ReadonlyMap<string, Pick<LinearAccount, "organizationId">>,
): KanbanWorkspaceId | null {
  if (ticket.linear === null) return LOCAL_KANBAN_WORKSPACE_ID;
  const account = accountsById.get(ticket.linear.accountId);
  return account === undefined ? null : linearWorkspaceId(account.organizationId);
}

export class KanbanService extends Context.Service<
  KanbanService,
  {
    /** The current snapshot on subscribe, then a fresh one after every committed change. */
    readonly snapshot: Stream.Stream<KanbanSnapshot, KanbanError>;
    readonly readSnapshot: Effect.Effect<KanbanSnapshot, KanbanError>;
    readonly addAccount: (
      input: LinearAccountAddInput,
    ) => Effect.Effect<LinearAccount, KanbanError>;
    readonly renameAccount: (
      input: LinearAccountRenameInput,
    ) => Effect.Effect<LinearAccount, KanbanError>;
    readonly deleteAccount: (
      input: LinearAccountRef,
    ) => Effect.Effect<LinearAccountRef, KanbanError>;
    readonly linearTeams: (
      input: LinearAccountRef,
    ) => Effect.Effect<LinearTeamsResult, KanbanError>;
    readonly linkProject: (
      input: KanbanProjectLinkInput,
    ) => Effect.Effect<KanbanProjectLink, KanbanError>;
    readonly unlinkProject: (
      input: KanbanProjectRef,
    ) => Effect.Effect<KanbanProjectRef, KanbanError>;
    readonly setWorkspaceBots: (
      input: KanbanWorkspaceBotsInput,
    ) => Effect.Effect<KanbanWorkspaceBotsInput, KanbanError>;
    readonly createTicket: (
      input: KanbanTicketCreateInput,
    ) => Effect.Effect<KanbanTicket, KanbanError>;
    readonly moveTicket: (input: KanbanTicketMoveInput) => Effect.Effect<KanbanTicket, KanbanError>;
    readonly deleteTicket: (input: KanbanTicketRef) => Effect.Effect<KanbanTicketRef, KanbanError>;
    readonly linkThread: (
      input: KanbanTicketThreadInput,
    ) => Effect.Effect<KanbanTicket, KanbanError>;
    readonly unlinkThread: (
      input: KanbanTicketThreadInput,
    ) => Effect.Effect<KanbanTicket, KanbanError>;
    /** Syncs now; a link's failure is recorded on the link, not raised. */
    readonly sync: (input: KanbanSyncInput) => Effect.Effect<KanbanSyncInput, KanbanError>;
    /** One poll: syncs every link, fully when its last full sync is old. */
    readonly poll: Effect.Effect<void, KanbanError>;
  }
>()("t3/bots/kanban/KanbanService") {}

const randomHex = randomUuidV4.pipe(Effect.map((uuid) => uuid.replaceAll("-", "")));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const kanbanError = (message: string) => (cause: unknown) => new KanbanError({ message, cause });

const publicLink = (link: StoredProjectLink): KanbanProjectLink => ({
  projectId: link.projectId,
  accountId: link.accountId,
  teamId: link.teamId,
  teamKey: link.teamKey,
  teamName: link.teamName,
  linearProjectId: link.linearProjectId,
  linearProjectName: link.linearProjectName,
  lastSyncedAt: link.lastSyncedAt,
  syncError: link.syncError,
  createdAt: link.createdAt,
});

const make = Effect.gen(function* () {
  const store = yield* KanbanStore;
  const bots = yield* BotsStore;
  const linear = yield* LinearClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  // Sliding(1): every signal re-reads the whole snapshot, so only the latest one matters.
  const changes = yield* PubSub.sliding<void>(1);
  const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const syncPermit = yield* Semaphore.make(1);

  const readSnapshot = Effect.gen(function* () {
    const [accounts, links, states, tickets, workspaceBots] = yield* Effect.all([
      store.listAccounts,
      store.listLinks,
      store.listStates,
      store.listTickets,
      store.listWorkspaceBots,
    ]);
    const workspaces: KanbanWorkspace[] = [
      {
        id: LOCAL_KANBAN_WORKSPACE_ID,
        name: "Local",
        botIds: workspaceBots.get(LOCAL_KANBAN_WORKSPACE_ID) ?? [],
      },
    ];
    for (const account of accounts) {
      const id = linearWorkspaceId(account.organizationId);
      if (workspaces.some((workspace) => workspace.id === id)) continue;
      workspaces.push({
        id,
        name: account.organizationName,
        botIds: workspaceBots.get(id) ?? [],
      });
    }
    const linkedTeams = new Set(links.map((link) => link.teamId));
    return {
      accounts,
      workspaces,
      links: links.map(publicLink),
      states: states.filter((state) => linkedTeams.has(state.teamId)),
      tickets,
    } satisfies KanbanSnapshot;
  });

  const snapshot = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the first read so a change landing in between is not lost.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(readSnapshot),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => readSnapshot)),
      );
    }),
  );

  const requireAccount = (accountId: LinearAccountId) =>
    store.getAccount(accountId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new KanbanError({ message: `Linear account ${accountId} does not exist.` }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const accountKey = (accountId: LinearAccountId) =>
    secrets.get(accountSecretName(accountId)).pipe(
      Effect.mapError(kanbanError("Could not read the Linear API key.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new KanbanError({
                message: "This Linear account has no API key on the server. Add it again.",
              }),
            ),
          onSome: (bytes) => Effect.succeed(Redacted.make(textDecoder.decode(bytes))),
        }),
      ),
    );

  const requireTicket = (ticketId: KanbanTicketRef["ticketId"]) =>
    store.getTicket(ticketId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new KanbanError({ message: `Ticket ${ticketId} does not exist.` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const toRow = (issue: LinearIssue, id: KanbanTicketId): LinearTicketRow => ({
    id,
    issueId: issue.id,
    teamId: issue.teamId,
    url: issue.url,
    identifier: issue.identifier,
    title: issue.title,
    stateId: issue.stateId,
    assigneeName: issue.assigneeName,
    priority: issue.priority,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  });

  const newTicketId = randomHex.pipe(Effect.map((hex) => KanbanTicketId.make(`t_${hex}`)));

  const upsertIssues = Effect.fn("KanbanService.upsertIssues")(function* (
    projectId: ProjectId,
    accountId: LinearAccountId,
    issues: ReadonlyArray<LinearIssue>,
  ) {
    const rows: LinearTicketRow[] = [];
    // Existing rows keep their id (the store matches on the issue); new ones need one.
    for (const issue of issues) rows.push(toRow(issue, yield* newTicketId));
    yield* store.upsertLinearTickets(projectId, accountId, rows);
  });

  const syncLink = Effect.fn("KanbanService.syncLink")(function* (
    link: StoredProjectLink,
    forceFull: boolean,
  ) {
    const now = yield* DateTime.now;
    const at = DateTime.formatIso(now);
    const nowMs = DateTime.toEpochMillis(now);
    const full =
      forceFull ||
      link.syncCursor === null ||
      link.lastFullSyncAt === null ||
      nowMs - Date.parse(link.lastFullSyncAt) >= FULL_SYNC_EVERY_MS;
    const scope = { teamId: link.teamId, linearProjectId: link.linearProjectId };
    const outcome = yield* Effect.gen(function* () {
      const key = yield* accountKey(link.accountId);
      const knownStates = new Set(
        (yield* store.listStates)
          .filter((state) => state.teamId === link.teamId)
          .map((state) => state.id),
      );
      let plan;
      if (full) {
        const window = yield* linear.issues(
          key,
          scope,
          {
            recentSince: DateTime.formatIso(DateTime.subtract(now, { days: RECENT_WINDOW_DAYS })),
          },
          FULL_SYNC_MAX_PAGES,
        );
        const existing = (yield* store.listTickets).filter(
          (ticket) => ticket.projectId === link.projectId && ticket.linear !== null,
        );
        const refreshed = yield* linear.issuesById(key, ticketsToRefresh(existing, window));
        plan = planFullSync(link.teamId, existing, window, refreshed);
      } else {
        const fetched = yield* linear.issues(
          key,
          scope,
          { updatedAfter: link.syncCursor ?? at },
          INCREMENTAL_MAX_PAGES,
        );
        plan = planIncrementalSync(link.teamId, fetched);
      }
      const statesChanged = full || plan.upserts.some((issue) => !knownStates.has(issue.stateId));
      if (statesChanged) {
        yield* store.replaceTeamStates(link.teamId, yield* linear.teamStates(key, link.teamId));
      }
      yield* upsertIssues(link.projectId, link.accountId, plan.upserts);
      yield* store.deleteLinearTickets(link.projectId, plan.drops);
      yield* store.recordSync(link.projectId, { ok: true, at, cursor: plan.cursor, full });
      return statesChanged || plan.upserts.length > 0 || plan.drops.length > 0;
    }).pipe(
      Effect.catch((error: KanbanError) =>
        store
          .recordSync(link.projectId, { ok: false, at, error: error.message })
          .pipe(Effect.as(true)),
      ),
    );
    // Clear a previous error even when nothing else changed.
    if (outcome || link.syncError !== null) yield* publish;
  });

  const syncLinks = (filter: (link: StoredProjectLink) => boolean, forceFull: boolean) =>
    syncPermit.withPermits(1)(
      Effect.gen(function* () {
        const links = (yield* store.listLinks).filter(filter);
        for (const link of links) yield* syncLink(link, forceFull);
      }),
    );

  const addAccount = Effect.fn("KanbanService.addAccount")(function* (
    input: LinearAccountAddInput,
  ) {
    const key = Redacted.make(input.apiKey);
    const viewer = yield* linear.viewer(key);
    const now = yield* nowIso;
    const account: LinearAccount = {
      id: LinearAccountId.make(`la_${yield* randomHex}`),
      name: input.name,
      keyLast4: input.apiKey.slice(-4),
      userName: viewer.userName,
      organizationId: viewer.organizationId,
      organizationName: viewer.organizationName,
      organizationUrlKey: viewer.organizationUrlKey,
      createdAt: now,
      updatedAt: now,
    };
    yield* secrets
      .set(accountSecretName(account.id), textEncoder.encode(input.apiKey))
      .pipe(Effect.mapError(kanbanError("Could not store the Linear API key.")));
    yield* store
      .insertAccount(account)
      .pipe(
        Effect.tapError(() => secrets.remove(accountSecretName(account.id)).pipe(Effect.ignore)),
      );
    yield* publish;
    return account;
  });

  const renameAccount = Effect.fn("KanbanService.renameAccount")(function* (
    input: LinearAccountRenameInput,
  ) {
    const account = yield* requireAccount(input.accountId);
    const updatedAt = yield* nowIso;
    yield* store.renameAccount(account.id, input.name, updatedAt);
    yield* publish;
    return { ...account, name: input.name, updatedAt };
  });

  const deleteAccount = Effect.fn("KanbanService.deleteAccount")(function* (
    input: LinearAccountRef,
  ) {
    yield* store.deleteAccount(input.accountId);
    yield* secrets
      .remove(accountSecretName(input.accountId))
      .pipe(Effect.mapError(kanbanError("Could not remove the Linear API key.")));
    yield* publish;
    return input;
  });

  const linearTeams = Effect.fn("KanbanService.linearTeams")(function* (input: LinearAccountRef) {
    yield* requireAccount(input.accountId);
    const teams = yield* linear.teams(yield* accountKey(input.accountId));
    return { teams };
  });

  const linkProject = Effect.fn("KanbanService.linkProject")(function* (
    input: KanbanProjectLinkInput,
  ) {
    yield* requireAccount(input.accountId);
    const { teams } = yield* linearTeams({ accountId: input.accountId });
    const team = teams.find((candidate) => candidate.id === input.teamId);
    if (team === undefined) {
      return yield* new KanbanError({ message: "This account cannot see that Linear team." });
    }
    const linearProject =
      input.linearProjectId === null
        ? null
        : team.projects.find((project) => project.id === input.linearProjectId);
    if (linearProject === undefined) {
      return yield* new KanbanError({ message: "That Linear project is not in this team." });
    }
    const previous = yield* store.getLink(input.projectId);
    const now = yield* nowIso;
    const stored: StoredProjectLink = {
      projectId: input.projectId,
      accountId: input.accountId,
      teamId: team.id,
      teamKey: team.key,
      teamName: team.name,
      linearProjectId: linearProject?.id ?? null,
      linearProjectName: linearProject?.name ?? null,
      lastSyncedAt: null,
      syncError: null,
      syncCursor: null,
      lastFullSyncAt: null,
      createdAt: Option.match(previous, { onNone: () => now, onSome: (old) => old.createdAt }),
    };
    yield* store.putLink(stored);
    yield* publish;
    // The board fills right away instead of at the next poll; a failure is recorded on the link.
    yield* syncLinks((candidate) => candidate.projectId === input.projectId, true);
    return yield* store
      .getLink(input.projectId)
      .pipe(Effect.map(Option.match({ onNone: () => publicLink(stored), onSome: publicLink })));
  });

  const unlinkProject = Effect.fn("KanbanService.unlinkProject")(function* (
    input: KanbanProjectRef,
  ) {
    yield* store.deleteLink(input.projectId);
    yield* publish;
    return input;
  });

  const setWorkspaceBots = Effect.fn("KanbanService.setWorkspaceBots")(function* (
    input: KanbanWorkspaceBotsInput,
  ) {
    const { workspaces } = yield* readSnapshot;
    if (!workspaces.some((workspace) => workspace.id === input.workspaceId)) {
      return yield* new KanbanError({ message: `Workspace ${input.workspaceId} does not exist.` });
    }
    const known = new Set(
      (yield* bots.listBots.pipe(Effect.mapError(kanbanError("Could not read bots.")))).map(
        (bot) => bot.id,
      ),
    );
    const botIds = [...new Set(input.botIds)];
    const unknown = botIds.find((botId) => !known.has(botId));
    if (unknown !== undefined) {
      return yield* new KanbanError({ message: `Bot ${unknown} does not exist.` });
    }
    yield* store.setWorkspaceBots(input.workspaceId, botIds);
    yield* publish;
    return { workspaceId: input.workspaceId, botIds };
  });

  const createTicket = Effect.fn("KanbanService.createTicket")(function* (
    input: KanbanTicketCreateInput,
  ) {
    const link = yield* store.getLink(input.projectId);
    if (Option.isSome(link)) {
      const key = yield* accountKey(link.value.accountId);
      const issue = yield* linear.createIssue(key, {
        teamId: link.value.teamId,
        projectId: link.value.linearProjectId,
        title: input.title,
        description: input.description ?? null,
      });
      const known = (yield* store.listStates).some((state) => state.id === issue.stateId);
      if (!known) {
        yield* store.replaceTeamStates(
          link.value.teamId,
          yield* linear.teamStates(key, link.value.teamId),
        );
      }
      yield* upsertIssues(input.projectId, link.value.accountId, [issue]);
      yield* publish;
      const tickets = yield* store.listTickets;
      const ticket = tickets.find(
        (candidate) =>
          candidate.projectId === input.projectId && candidate.linear?.issueId === issue.id,
      );
      if (ticket === undefined) {
        return yield* new KanbanError({ message: "The new issue was not saved." });
      }
      return ticket;
    }
    const id = yield* newTicketId;
    const createdAt = yield* nowIso;
    yield* store.insertLocalTicket({
      id,
      projectId: input.projectId,
      localNumber: yield* store.nextLocalNumber,
      title: input.title,
      state: input.state ?? "todo",
      createdAt,
    });
    yield* publish;
    return yield* requireTicket(id);
  });

  const moveTicket = Effect.fn("KanbanService.moveTicket")(function* (
    input: KanbanTicketMoveInput,
  ) {
    const ticket = yield* requireTicket(input.ticketId);
    const to = input.to;
    if (ticket.linear === null) {
      if (to.kind !== "local") {
        return yield* new KanbanError({ message: "A local ticket takes a local state." });
      }
      yield* store.setLocalState(ticket.id, to.state, yield* nowIso);
    } else {
      if (to.kind !== "linear") {
        return yield* new KanbanError({
          message: `${ticket.identifier} is a Linear issue; move it to one of its team's states.`,
        });
      }
      const state = (yield* store.listStates).find((candidate) => candidate.id === to.stateId);
      if (state === undefined || state.teamId !== ticket.linear.teamId) {
        return yield* new KanbanError({
          message: `That state is not in the team of ${ticket.identifier}.`,
        });
      }
      const issue = yield* linear.setIssueState(
        yield* accountKey(ticket.linear.accountId),
        ticket.linear.issueId,
        to.stateId,
      );
      yield* upsertIssues(ticket.projectId, ticket.linear.accountId, [issue]);
    }
    yield* publish;
    return yield* requireTicket(ticket.id);
  });

  const deleteTicket = Effect.fn("KanbanService.deleteTicket")(function* (input: KanbanTicketRef) {
    const ticket = yield* requireTicket(input.ticketId);
    if (ticket.linear !== null) {
      return yield* new KanbanError({
        message: `${ticket.identifier} comes from Linear; close or archive it there.`,
      });
    }
    yield* store.deleteTicket(ticket.id);
    yield* publish;
    return input;
  });

  const linkThread = Effect.fn("KanbanService.linkThread")(function* (
    input: KanbanTicketThreadInput,
  ) {
    yield* requireTicket(input.ticketId);
    yield* store.linkThread(input.ticketId, input.threadId, yield* nowIso);
    yield* publish;
    return yield* requireTicket(input.ticketId);
  });

  const unlinkThread = Effect.fn("KanbanService.unlinkThread")(function* (
    input: KanbanTicketThreadInput,
  ) {
    yield* requireTicket(input.ticketId);
    yield* store.unlinkThread(input.ticketId, input.threadId);
    yield* publish;
    return yield* requireTicket(input.ticketId);
  });

  const sync = (input: KanbanSyncInput) =>
    syncLinks(
      (link) => input.projectId === undefined || link.projectId === input.projectId,
      true,
    ).pipe(Effect.as(input));

  return KanbanService.of({
    snapshot,
    readSnapshot,
    addAccount,
    renameAccount,
    deleteAccount,
    linearTeams,
    linkProject,
    unlinkProject,
    setWorkspaceBots,
    createTicket,
    moveTicket,
    deleteTicket,
    linkThread,
    unlinkThread,
    sync,
    poll: syncLinks(() => true, false),
  });
});

/** Needs KanbanStore, BotsStore, LinearClient and ServerSecretStore. */
export const layerService = Layer.effect(KanbanService, make);

export const layer = layerService.pipe(
  Layer.provide(LinearClientModule.layer),
  Layer.provide(KanbanStoreModule.layer),
);
