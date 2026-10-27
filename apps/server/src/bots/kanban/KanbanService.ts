/**
 * Owns the kanban and its Linear sync. Invariants: an account's key goes to the secret store before
 * its row and no answer carries it; a Linear ticket changes only from Linear's own answer, so a
 * refused move changes nothing; syncs take one shared permit, so cursors never interleave; and
 * `snapshot` publishes only after a write commits.
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
  KANBAN_DEFAULT_VIEW_CONFIG,
  KANBAN_LIMITS,
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_OWNER_PERSON_ID,
  KanbanError,
  KanbanTicketId,
  KanbanViewId,
  LinearAccountId,
  LOCAL_KANBAN_WORKSPACE_ID,
  kanbanBotPersonId,
  linearWorkspaceId,
  type Bot,
  type BotId,
  type KanbanActivity,
  type KanbanPersonId,
  type KanbanTicketPatch,
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
  type KanbanComment,
  type KanbanLabel,
  type KanbanLabelCreateInput,
  type KanbanLabelRef,
  type KanbanTicketCommentInput,
  type KanbanTicketCommentRef,
  type KanbanTicketDetail,
  type KanbanTicketUpdateInput,
  type KanbanView,
  type KanbanViewImportResult,
  type KanbanViewRef,
  type KanbanViewReorderInput,
  type KanbanViewSaveInput,
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
import {
  KanbanStore,
  type LinearTicketRow,
  type LocalCommentRow,
  type StoredProjectLink,
} from "./KanbanStore.ts";
import * as LinearClientModule from "./LinearClient.ts";
import {
  LinearClient,
  type LinearComment,
  type LinearIssue,
  type LinearIssueUpdate,
} from "./LinearClient.ts";
import { personName, phraseHistory, priorityName } from "./linearMapping.ts";
import { linearFilterToClauses } from "./linearViewImport.ts";
import { planFullSync, planIncrementalSync, ticketsToRefresh } from "./syncPlan.ts";

/** A full sync re-reads the board's window this often; polls in between are incremental. */
const FULL_SYNC_EVERY_MS = 30 * 60_000;
/** Done and canceled issues stay on the board this long after their last update. */
const RECENT_WINDOW_DAYS = 30;
/** Cycles that ended longer ago than this are not cached. */
const CYCLE_WINDOW_DAYS = 90;
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
    /** Description, parent, sub-issues, comments and history, read when the issue opens. */
    readonly ticketDetail: (
      input: KanbanTicketRef,
    ) => Effect.Effect<KanbanTicketDetail, KanbanError>;
    /** Linear first for a synced ticket (except `botId`); a refusal there changes nothing. */
    readonly updateTicket: (
      input: KanbanTicketUpdateInput,
    ) => Effect.Effect<KanbanTicket, KanbanError>;
    readonly comment: (
      input: KanbanTicketCommentInput,
    ) => Effect.Effect<KanbanComment, KanbanError>;
    readonly deleteComment: (
      input: KanbanTicketCommentRef,
    ) => Effect.Effect<KanbanTicketCommentRef, KanbanError>;
    readonly saveView: (input: KanbanViewSaveInput) => Effect.Effect<KanbanView, KanbanError>;
    readonly deleteView: (input: KanbanViewRef) => Effect.Effect<KanbanViewRef, KanbanError>;
    readonly reorderViews: (
      input: KanbanViewReorderInput,
    ) => Effect.Effect<KanbanViewReorderInput, KanbanError>;
    readonly importLinearViews: (
      input: LinearAccountRef,
    ) => Effect.Effect<KanbanViewImportResult, KanbanError>;
    readonly createLabel: (
      input: KanbanLabelCreateInput,
    ) => Effect.Effect<KanbanLabel, KanbanError>;
    readonly deleteLabel: (input: KanbanLabelRef) => Effect.Effect<KanbanLabelRef, KanbanError>;
  }
>()("t3/bots/kanban/KanbanService") {}

const randomHex = randomUuidV4.pipe(Effect.map((uuid) => uuid.replaceAll("-", "")));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `2026-11-01` as "Nov 1". */
const shortDate = (date: string) => {
  const [, month, day] = date.split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}`;
};

const LINEAR_ONLY_KEYS = ["linearProjectId", "milestoneId", "cycleId", "estimate"] as const;

/**
 * What one sync pass already refreshed, so links sharing an account or team ask Linear once. Each
 * entry is the refresh's failure, or null once it succeeded; every link that needs it shares it.
 */
interface SyncPass {
  readonly viewers: Map<LinearAccountId, KanbanError | null>;
  readonly catalogs: Map<string, KanbanError | null>;
  readonly cycleTeams: Map<string, KanbanError | null>;
}

/** Runs `refresh` once per pass for `id`, and fails every caller with its failure. */
const oncePerPass = Effect.fn("KanbanService.oncePerPass")(function* <K>(
  outcomes: Map<K, KanbanError | null>,
  id: K,
  refresh: Effect.Effect<void, KanbanError>,
) {
  let outcome = outcomes.get(id);
  if (outcome === undefined) {
    outcome = yield* refresh.pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
    );
    outcomes.set(id, outcome);
  }
  if (outcome !== null) return yield* outcome;
});

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

interface PersonFace {
  readonly name: string;
  readonly avatarUrl: string | null;
}

function localPersonResolver(
  firstAccount: LinearAccount | undefined,
  botList: ReadonlyArray<Bot>,
): (id: string | null) => PersonFace {
  const botNames = new Map(botList.map((bot) => [kanbanBotPersonId(bot.id), bot.name]));
  return (id) => {
    if (id === KANBAN_OWNER_PERSON_ID) {
      return {
        name: firstAccount?.userName ?? "You",
        avatarUrl: firstAccount?.userAvatarUrl ?? null,
      };
    }
    return {
      name: (id === null ? undefined : botNames.get(id)) ?? id ?? "Someone",
      avatarUrl: null,
    };
  };
}

/** `deletable` when the comment's user is the account's own Linear user. */
const toKanbanComment = (comment: LinearComment, ownUserId: string | null): KanbanComment => ({
  id: comment.id,
  authorId: comment.user?.id ?? null,
  authorName:
    (comment.user === null ? undefined : personName(comment.user)) ??
    comment.botActor?.name ??
    "Linear",
  authorAvatarUrl: comment.user?.avatarUrl ?? comment.botActor?.avatarUrl ?? null,
  body: comment.body,
  parentId: comment.parentId,
  createdAt: comment.createdAt,
  editedAt: comment.editedAt,
  deletable: ownUserId !== null && comment.user?.id === ownUserId,
});

/** Stable, so of two entries at the same instant the first one given stays first. */
const oldestFirst = <A extends { readonly createdAt: string }>(items: ReadonlyArray<A>) =>
  [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const localComment = (
  row: LocalCommentRow,
  person: (id: string | null) => PersonFace,
): KanbanComment => {
  const author = person(row.authorId);
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: author.name,
    authorAvatarUrl: author.avatarUrl,
    body: row.body,
    parentId: null,
    createdAt: row.createdAt,
    editedAt: row.updatedAt === row.createdAt ? null : row.updatedAt,
    deletable: true,
  };
};

const labelsPhrase = (verb: string, names: ReadonlyArray<string>) =>
  names.length === 0
    ? []
    : [`${verb} ${names.length === 1 ? "label" : "labels"} ${names.join(", ")}`];

const make = Effect.gen(function* () {
  const store = yield* KanbanStore;
  const bots = yield* BotsStore;
  const linear = yield* LinearClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  // Sliding(1): every signal re-reads the whole snapshot, so only the latest one matters.
  const changes = yield* PubSub.sliding<void>(1);
  const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const syncPermit = yield* Semaphore.make(1);
  // Imports look a view up before inserting it, so two at once would both insert it.
  const importPermit = yield* Semaphore.make(1);

  const readSnapshot = Effect.gen(function* () {
    const [
      accounts,
      links,
      states,
      tickets,
      workspaceBots,
      people,
      labels,
      linearProjects,
      milestones,
      cycles,
      views,
    ] = yield* Effect.all([
      store.listAccounts,
      store.listLinks,
      store.listStates,
      store.listTickets,
      store.listWorkspaceBots,
      store.listPeople,
      store.listLabels,
      store.listLinearProjects,
      store.listMilestones,
      store.listCycles,
      store.listViews,
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
    const organizations = new Set(accounts.map((account) => account.organizationId));
    const workspaceIds = new Set<string>(workspaces.map((workspace) => workspace.id));
    const reachedProjects = linearProjects.filter((project) =>
      organizations.has(project.organizationId),
    );
    const projectIds = new Set(reachedProjects.map((project) => project.id));
    return {
      accounts,
      workspaces,
      links: links.map(publicLink),
      states: states.filter((state) => linkedTeams.has(state.teamId)),
      tickets,
      people: people.filter((person) => organizations.has(person.organizationId)),
      labels: labels.filter((label) => workspaceIds.has(label.workspaceId)),
      linearProjects: reachedProjects,
      milestones: milestones.filter((milestone) => projectIds.has(milestone.projectId)),
      cycles: cycles.filter((cycle) => linkedTeams.has(cycle.teamId)),
      views,
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
    assigneeId: issue.assigneeId,
    creatorId: issue.creatorId,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
    labelIds: issue.labelIds,
    linearProjectId: issue.projectId,
    milestoneId: issue.milestoneId,
    cycleId: issue.cycleId,
    parent: issue.parent,
    subIssues: issue.subIssues,
    pullRequests: issue.pullRequests,
    sortOrder: issue.sortOrder,
    closedAt: issue.closedAt,
    autoClosed: issue.autoClosed,
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

  const refreshCatalog = Effect.fn("KanbanService.refreshCatalog")(function* (
    key: Redacted.Redacted,
    organizationId: string,
  ) {
    const [people, labels, projects, milestones] = yield* Effect.all([
      linear.people(key),
      linear.labels(key),
      linear.linearProjects(key),
      linear.milestones(key),
    ]);
    const workspaceId = linearWorkspaceId(organizationId);
    yield* store.replaceOrganizationCatalog(organizationId, workspaceId, {
      people: people.map((person) => ({ ...person, organizationId })),
      labels: labels.map((label) => ({ ...label, workspaceId, source: "linear" as const })),
      projects: projects.map((project) => ({ ...project, organizationId })),
      milestones,
    });
  });

  /** The key owner, the organization's catalog and the team's cycles, each once per pass. */
  const refreshLinkContext = Effect.fn("KanbanService.refreshLinkContext")(function* (
    link: StoredProjectLink,
    key: Redacted.Redacted,
    full: boolean,
    pass: SyncPass,
    now: DateTime.Utc,
  ) {
    const account = yield* requireAccount(link.accountId);
    const needsViewer = full || account.userId === null;
    if (needsViewer) {
      yield* oncePerPass(
        pass.viewers,
        account.id,
        linear
          .viewer(key)
          .pipe(
            Effect.flatMap((viewer) =>
              store.setAccountUser(account.id, viewer.userId, viewer.userAvatarUrl),
            ),
          ),
      );
    }
    if (!full) return needsViewer;
    yield* oncePerPass(
      pass.catalogs,
      account.organizationId,
      refreshCatalog(key, account.organizationId),
    );
    const since = DateTime.formatIso(DateTime.subtract(now, { days: CYCLE_WINDOW_DAYS }));
    yield* oncePerPass(
      pass.cycleTeams,
      link.teamId,
      linear
        .cycles(key, link.teamId, since)
        .pipe(Effect.flatMap((cycles) => store.replaceTeamCycles(link.teamId, cycles))),
    );
    return true;
  });

  const syncLink = Effect.fn("KanbanService.syncLink")(function* (
    link: StoredProjectLink,
    forceFull: boolean,
    pass: SyncPass,
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
      const contextChanged = yield* refreshLinkContext(link, key, full, pass, now);
      yield* store.recordSync(link.projectId, { ok: true, at, cursor: plan.cursor, full });
      return contextChanged || statesChanged || plan.upserts.length > 0 || plan.drops.length > 0;
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
        const pass: SyncPass = { viewers: new Map(), catalogs: new Map(), cycleTeams: new Map() };
        for (const link of links) yield* syncLink(link, forceFull, pass);
      }),
    );

  const listBots = bots.listBots.pipe(Effect.mapError(kanbanError("Could not read bots.")));

  const requireBot = Effect.fn("KanbanService.requireBot")(function* (botId: BotId) {
    const bot = yield* bots
      .getBot(botId)
      .pipe(Effect.mapError(kanbanError("Could not read bots.")));
    if (Option.isNone(bot)) {
      return yield* new KanbanError({ message: `Bot ${botId} does not exist.` });
    }
    return bot.value;
  });

  /** Names the people of local tickets: the owner after the first account's user, bots by name. */
  const localPeople = Effect.gen(function* () {
    const [accounts, botList] = yield* Effect.all([store.listAccounts, listBots]);
    return localPersonResolver(accounts[0], botList);
  });

  /** A local ticket is assigned to the owner or a bot, and carries local labels only. */
  const checkLocalFields = Effect.fn("KanbanService.checkLocalFields")(function* (fields: {
    readonly assigneeId?: KanbanPersonId | null;
    readonly labelIds?: ReadonlyArray<string>;
  }) {
    const assigneeId = fields.assigneeId ?? null;
    if (assigneeId !== null && assigneeId !== KANBAN_OWNER_PERSON_ID) {
      const known = (yield* listBots).some((bot) => kanbanBotPersonId(bot.id) === assigneeId);
      if (!known) {
        return yield* new KanbanError({
          message: "A local ticket is assigned to you or to an existing bot.",
        });
      }
    }
    if (fields.labelIds !== undefined) {
      const local = new Set(
        (yield* store.listLabels).flatMap((label) => (label.source === "local" ? [label.id] : [])),
      );
      const unknown = fields.labelIds.find((id) => !local.has(id));
      if (unknown !== undefined) {
        return yield* new KanbanError({ message: `Label ${unknown} is not a local label.` });
      }
    }
  });

  const recordEvents = Effect.fn("KanbanService.recordEvents")(function* (
    ticketId: KanbanTicketId,
    texts: ReadonlyArray<string>,
    at: string,
    actorId: KanbanPersonId,
  ) {
    for (const [index, text] of texts.entries()) {
      // Events of one write share `at`; the index keeps their order in the history.
      const id = `e_${String(index).padStart(2, "0")}${yield* randomHex}`;
      yield* store.insertTicketEvent({ id, ticketId, actorId, text, createdAt: at });
    }
  });

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
      userId: null,
      userAvatarUrl: null,
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
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
        ...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
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
    yield* checkLocalFields(input);
    const id = yield* newTicketId;
    const createdAt = yield* nowIso;
    const sortOrders = (yield* store.listTickets).flatMap((ticket) =>
      ticket.projectId === input.projectId ? [ticket.sortOrder] : [],
    );
    yield* store.insertLocalTicket({
      id,
      projectId: input.projectId,
      localNumber: yield* store.nextLocalNumber,
      title: input.title,
      state: input.state ?? "todo",
      priority: input.priority ?? 0,
      assigneeId: input.assigneeId ?? null,
      creatorId: KANBAN_OWNER_PERSON_ID,
      labelIds: [...new Set(input.labelIds ?? [])],
      description: input.description || null,
      // On top in manual order.
      sortOrder: sortOrders.length === 0 ? 0 : Math.min(...sortOrders) - 1,
      createdAt,
    });
    yield* recordEvents(id, ["created the ticket"], createdAt, KANBAN_OWNER_PERSON_ID);
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
      const at = yield* nowIso;
      yield* store.setLocalState(ticket.id, to.state, at);
      if (ticket.status.kind === "local" && ticket.status.state !== to.state) {
        const from = KANBAN_LOCAL_STATE_LABELS[ticket.status.state];
        const text = `moved from ${from} to ${KANBAN_LOCAL_STATE_LABELS[to.state]}`;
        yield* recordEvents(ticket.id, [text], at, KANBAN_OWNER_PERSON_ID);
      }
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

  const linearDetail = Effect.fn("KanbanService.linearDetail")(function* (
    ticket: KanbanTicket,
    linearRef: NonNullable<KanbanTicket["linear"]>,
    fetchedAt: string,
  ) {
    const account = yield* requireAccount(linearRef.accountId);
    const detail = yield* linear.issueDetail(yield* accountKey(account.id), linearRef.issueId);
    const [tickets, people] = yield* Effect.all([store.listTickets, store.listPeople]);
    const ticketOfIssue = new Map(
      tickets.flatMap((candidate) =>
        candidate.projectId === ticket.projectId && candidate.linear !== null
          ? [[candidate.linear.issueId, candidate.id] as const]
          : [],
      ),
    );
    const creator = people.find((person) => person.id === ticket.creatorId);
    // Linear's history has no entry for the creation itself.
    const created: KanbanActivity = {
      id: `${ticket.id}-created`,
      actorId: ticket.creatorId,
      actorName: creator?.name ?? "Someone",
      actorAvatarUrl: creator?.avatarUrl ?? null,
      text: "created the issue",
      createdAt: ticket.createdAt,
    };
    const history = detail.history.flatMap((entry): ReadonlyArray<KanbanActivity> => {
      const text = phraseHistory(entry);
      if (text === null) return [];
      return [
        {
          id: entry.id,
          actorId: entry.actor?.id ?? null,
          actorName:
            (entry.actor === null ? undefined : personName(entry.actor)) ??
            entry.botActor?.name ??
            "Linear",
          actorAvatarUrl: entry.actor?.avatarUrl ?? entry.botActor?.avatarUrl ?? null,
          text,
          createdAt: entry.createdAt,
        },
      ];
    });
    return {
      ticketId: ticket.id,
      description: detail.description || null,
      parent:
        detail.parent === null
          ? null
          : {
              issueId: detail.parent.issueId,
              ticketId: ticketOfIssue.get(detail.parent.issueId) ?? null,
              identifier: detail.parent.identifier,
              title: detail.parent.title,
              status: { kind: "linear", stateId: detail.parent.stateId },
            },
      children: detail.children.map((child) => ({
        issueId: child.id,
        ticketId: ticketOfIssue.get(child.id) ?? null,
        identifier: child.identifier,
        title: child.title,
        status: { kind: "linear", stateId: child.stateId },
        priority: child.priority,
        assigneeId: child.assigneeId,
        url: child.url,
      })),
      comments: oldestFirst(
        detail.comments.map((comment) => toKanbanComment(comment, account.userId)),
      ),
      activity: oldestFirst([created, ...history]),
      fetchedAt,
    } satisfies KanbanTicketDetail;
  });

  const localDetail = Effect.fn("KanbanService.localDetail")(function* (
    ticket: KanbanTicket,
    fetchedAt: string,
  ) {
    const [description, comments, events, person] = yield* Effect.all([
      store.getLocalDescription(ticket.id),
      store.listLocalComments(ticket.id),
      store.listTicketEvents(ticket.id),
      localPeople,
    ]);
    return {
      ticketId: ticket.id,
      description: Option.getOrNull(description),
      parent: null,
      children: [],
      comments: comments.map((row) => localComment(row, person)),
      activity: events.map((event) => {
        const actor = person(event.actorId);
        return {
          id: event.id,
          actorId: event.actorId,
          actorName: actor.name,
          actorAvatarUrl: actor.avatarUrl,
          text: event.text,
          createdAt: event.createdAt,
        };
      }),
      fetchedAt,
    } satisfies KanbanTicketDetail;
  });

  const ticketDetail = Effect.fn("KanbanService.ticketDetail")(function* (input: KanbanTicketRef) {
    const ticket = yield* requireTicket(input.ticketId);
    const fetchedAt = yield* nowIso;
    return ticket.linear === null
      ? yield* localDetail(ticket, fetchedAt)
      : yield* linearDetail(ticket, ticket.linear, fetchedAt);
  });

  /** Checks a patch against the ticket's organization and team, then phrases it for Linear. */
  const linearUpdateOf = Effect.fn("KanbanService.linearUpdateOf")(function* (
    ticket: KanbanTicket,
    linearRef: NonNullable<KanbanTicket["linear"]>,
    patch: Omit<KanbanTicketPatch, "botId">,
  ) {
    const refuse = (message: string) => Effect.fail(new KanbanError({ message }));
    const { organizationId } = yield* requireAccount(linearRef.accountId);
    const assigneeId = patch.assigneeId ?? null;
    if (assigneeId !== null) {
      const people = yield* store.listPeople;
      const known = people.some(
        (person) => person.id === assigneeId && person.organizationId === organizationId,
      );
      if (!known)
        return yield* refuse(`That person is not in the workspace of ${ticket.identifier}.`);
    }
    if (patch.labelIds !== undefined) {
      const workspaceId = linearWorkspaceId(organizationId);
      const usable = new Set(
        (yield* store.listLabels).flatMap((label) =>
          label.source === "linear" &&
          label.workspaceId === workspaceId &&
          (label.teamId === null || label.teamId === linearRef.teamId)
            ? [label.id]
            : [],
        ),
      );
      const unusable = patch.labelIds.find((id) => !usable.has(id));
      if (unusable !== undefined) {
        return yield* refuse(`Label ${unusable} cannot be used on ${ticket.identifier}.`);
      }
    }
    const cycleId = patch.cycleId ?? null;
    if (cycleId !== null) {
      const cycles = yield* store.listCycles;
      if (!cycles.some((cycle) => cycle.id === cycleId && cycle.teamId === linearRef.teamId)) {
        return yield* refuse(`That cycle is not in the team of ${ticket.identifier}.`);
      }
    }
    const projectId = patch.linearProjectId ?? null;
    if (projectId !== null) {
      const projects = yield* store.listLinearProjects;
      const known = projects.some(
        (project) => project.id === projectId && project.organizationId === organizationId,
      );
      if (!known)
        return yield* refuse(`That project is not in the workspace of ${ticket.identifier}.`);
    }
    const milestoneId = patch.milestoneId ?? null;
    if (milestoneId !== null) {
      const project =
        patch.linearProjectId === undefined ? ticket.linearProjectId : patch.linearProjectId;
      const milestones = yield* store.listMilestones;
      const known = milestones.some(
        (milestone) => milestone.id === milestoneId && milestone.projectId === project,
      );
      if (project === null || !known) {
        return yield* refuse(`That milestone is not in the project of ${ticket.identifier}.`);
      }
    }
    const { linearProjectId, milestoneId: projectMilestoneId, ...same } = patch;
    return {
      ...same,
      ...(linearProjectId === undefined ? {} : { projectId: linearProjectId }),
      ...(projectMilestoneId === undefined ? {} : { projectMilestoneId }),
    } satisfies LinearIssueUpdate;
  });

  const updateLocalTicket = Effect.fn("KanbanService.updateLocalTicket")(function* (
    ticket: KanbanTicket,
    patch: KanbanTicketPatch,
    actorId: KanbanPersonId,
  ) {
    if (LINEAR_ONLY_KEYS.some((key) => patch[key] !== undefined)) {
      return yield* new KanbanError({
        message: `${ticket.identifier} is a local ticket: project, milestone, cycle and estimate exist only on Linear issues.`,
      });
    }
    yield* checkLocalFields(patch);
    const at = yield* nowIso;
    const [person, labels] = yield* Effect.all([localPeople, store.listLabels]);
    const labelName = (id: string) => labels.find((label) => label.id === id)?.name ?? id;
    const description = patch.description === undefined ? undefined : patch.description || null;
    const events: string[] = [];
    if (patch.title !== undefined && patch.title !== ticket.title) {
      events.push(`changed the title from ${ticket.title} to ${patch.title}`);
    }
    if (description !== undefined) {
      const previous = Option.getOrNull(yield* store.getLocalDescription(ticket.id));
      if (previous !== description) events.push("updated the description");
    }
    if (patch.priority !== undefined && patch.priority !== ticket.priority) {
      events.push(
        patch.priority === 0
          ? "removed the priority"
          : `set priority to ${priorityName(patch.priority)}`,
      );
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== ticket.assigneeId) {
      events.push(
        patch.assigneeId === null
          ? "removed the assignee"
          : `assigned to ${person(patch.assigneeId).name}`,
      );
    }
    const labelIds = patch.labelIds === undefined ? undefined : [...new Set(patch.labelIds)];
    if (labelIds !== undefined) {
      const added = labelIds.filter((id) => !ticket.labelIds.includes(id));
      const removed = ticket.labelIds.filter((id) => !labelIds.includes(id));
      events.push(
        ...labelsPhrase("added", added.map(labelName)),
        ...labelsPhrase("removed", removed.map(labelName)),
      );
    }
    if (patch.dueDate !== undefined && patch.dueDate !== ticket.dueDate) {
      events.push(
        patch.dueDate === null
          ? "removed the due date"
          : `set due date to ${shortDate(patch.dueDate)}`,
      );
    }
    if (patch.botId !== undefined && patch.botId !== ticket.botId) {
      events.push(
        patch.botId === null
          ? "removed the bot"
          : `set the bot to ${person(kanbanBotPersonId(patch.botId)).name}`,
      );
    }
    yield* store.updateLocalTicket(ticket.id, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(description === undefined ? {} : { description }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.assigneeId === undefined ? {} : { assigneeId: patch.assigneeId }),
      ...(labelIds === undefined ? {} : { labelIds }),
      ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
      updatedAt: at,
    });
    if (patch.botId !== undefined) yield* store.setTicketBot(ticket.id, patch.botId, at);
    yield* recordEvents(ticket.id, events, at, actorId);
  });

  const updateTicket = Effect.fn("KanbanService.updateTicket")(function* (
    input: KanbanTicketUpdateInput,
  ) {
    const ticket = yield* requireTicket(input.ticketId);
    const { botId, ...fields } = input.patch;
    if (botId !== undefined && botId !== null) yield* requireBot(botId);
    if (ticket.linear === null) {
      yield* updateLocalTicket(ticket, input.patch, KANBAN_OWNER_PERSON_ID);
    } else {
      const update = yield* linearUpdateOf(ticket, ticket.linear, fields);
      if (Object.keys(update).length > 0) {
        const issue = yield* linear.updateIssue(
          yield* accountKey(ticket.linear.accountId),
          ticket.linear.issueId,
          update,
        );
        yield* upsertIssues(ticket.projectId, ticket.linear.accountId, [issue]);
      }
      // The ticket's own bot lives in T3 only.
      if (botId !== undefined) yield* store.setTicketBot(ticket.id, botId);
    }
    yield* publish;
    return yield* requireTicket(ticket.id);
  });

  const comment = Effect.fn("KanbanService.comment")(function* (input: KanbanTicketCommentInput) {
    const ticket = yield* requireTicket(input.ticketId);
    if (ticket.linear !== null) {
      const created = yield* linear.createComment(
        yield* accountKey(ticket.linear.accountId),
        ticket.linear.issueId,
        input.body,
      );
      // Written with the account's key, so its user is the account's own.
      return toKanbanComment(created, created.user?.id ?? null);
    }
    const at = yield* nowIso;
    const row = {
      id: `c_${yield* randomHex}`,
      ticketId: ticket.id,
      authorId: KANBAN_OWNER_PERSON_ID,
      body: input.body,
      createdAt: at,
      updatedAt: at,
    };
    yield* store.insertLocalComment(row);
    return localComment(row, yield* localPeople);
  });

  const deleteComment = Effect.fn("KanbanService.deleteComment")(function* (
    input: KanbanTicketCommentRef,
  ) {
    const ticket = yield* requireTicket(input.ticketId);
    if (ticket.linear !== null) {
      const key = yield* accountKey(ticket.linear.accountId);
      if ((yield* linear.commentIssueId(key, input.commentId)) !== ticket.linear.issueId) {
        return yield* new KanbanError({
          message: `Comment ${input.commentId} does not exist on ${ticket.identifier}.`,
        });
      }
      yield* linear.deleteComment(key, input.commentId);
      return input;
    }
    if (!(yield* store.deleteLocalComment(ticket.id, input.commentId))) {
      return yield* new KanbanError({
        message: `Comment ${input.commentId} does not exist on ${ticket.identifier}.`,
      });
    }
    return input;
  });

  const requireView = (viewId: KanbanViewId) =>
    store.getView(viewId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new KanbanError({ message: `View ${viewId} does not exist.` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const newViewId = randomHex.pipe(Effect.map((hex) => KanbanViewId.make(`v_${hex}`)));

  const saveView = Effect.fn("KanbanService.saveView")(function* (input: KanbanViewSaveInput) {
    const now = yield* nowIso;
    const fields = {
      projectId: input.projectId,
      name: input.name,
      icon: input.icon,
      config: input.config,
      updatedAt: now,
    };
    if (input.id === undefined) {
      const view: KanbanView = {
        id: yield* newViewId,
        linearViewId: null,
        createdAt: now,
        ...fields,
      };
      yield* store.insertView(view);
      yield* publish;
      return view;
    }
    const view: KanbanView = { ...(yield* requireView(input.id)), ...fields };
    yield* store.updateView(view);
    yield* publish;
    return view;
  });

  const deleteView = Effect.fn("KanbanService.deleteView")(function* (input: KanbanViewRef) {
    yield* requireView(input.viewId);
    yield* store.deleteView(input.viewId);
    yield* publish;
    return input;
  });

  const reorderViews = Effect.fn("KanbanService.reorderViews")(function* (
    input: KanbanViewReorderInput,
  ) {
    yield* store.reorderViews(input.viewIds);
    yield* publish;
    return input;
  });

  const importLinearViews = Effect.fn("KanbanService.importLinearViews")(function* (
    input: LinearAccountRef,
  ) {
    const account = yield* requireAccount(input.accountId);
    const customViews = yield* linear.customViews(yield* accountKey(account.id));
    const [accounts, links, labels, states] = yield* Effect.all([
      store.listAccounts,
      store.listLinks,
      store.listLabels,
      store.listStates,
    ]);
    const workspaceId = linearWorkspaceId(account.organizationId);
    const sameOrganization = new Set(
      accounts.flatMap((candidate) =>
        candidate.organizationId === account.organizationId ? [candidate.id] : [],
      ),
    );
    const organizationLinks = links.filter((link) => sameOrganization.has(link.accountId));
    const teams = new Set(organizationLinks.map((link) => link.teamId));
    const organizationLabels = labels.filter(
      (label) => label.source === "linear" && label.workspaceId === workspaceId,
    );
    const organizationStates = states.filter((state) => teams.has(state.teamId));
    const named = (name: string) => (candidate: { readonly name: string }) =>
      candidate.name.toLowerCase() === name.toLowerCase();
    const context = {
      labelIdsByName: (name: string) => {
        const ids = organizationLabels.filter(named(name)).map((label) => label.id);
        const groups = new Set(ids);
        const children = organizationLabels.flatMap((label) =>
          label.parentId !== null && groups.has(label.parentId) ? [label.id] : [],
        );
        return [...ids, ...children];
      },
      statesByName: (name: string) =>
        organizationStates.filter(named(name)).map((state) => state.id),
    };

    const imported: KanbanView[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const custom of customViews) {
      if (Option.isSome(yield* store.findViewByLinearId(custom.id))) {
        skipped.push({ name: custom.name, reason: "already imported" });
        continue;
      }
      const result = linearFilterToClauses(custom.filterData, context);
      if (!result.ok) {
        skipped.push({ name: custom.name, reason: result.reason });
        continue;
      }
      const teamProjects = [
        ...new Set(
          organizationLinks.flatMap((link) =>
            link.teamId === custom.teamId ? [link.projectId] : [],
          ),
        ),
      ];
      const now = yield* nowIso;
      const view: KanbanView = {
        id: yield* newViewId,
        // A team's view belongs on that team's board when exactly one project shows it.
        projectId: teamProjects.length === 1 ? (teamProjects[0] ?? null) : null,
        name: custom.name.trim().slice(0, KANBAN_LIMITS.viewName).trim() || "Linear view",
        icon: custom.icon,
        config: { ...KANBAN_DEFAULT_VIEW_CONFIG, filters: result.filters },
        linearViewId: custom.id,
        createdAt: now,
        updatedAt: now,
      };
      yield* store.insertView(view);
      imported.push(view);
    }
    if (imported.length > 0) yield* publish;
    return { imported, skipped };
  }, importPermit.withPermits(1));

  const createLabel = Effect.fn("KanbanService.createLabel")(function* (
    input: KanbanLabelCreateInput,
  ) {
    const label: KanbanLabel = {
      id: `ll_${yield* randomHex}`,
      workspaceId: LOCAL_KANBAN_WORKSPACE_ID,
      teamId: null,
      name: input.name,
      color: input.color,
      parentId: null,
      source: "local",
    };
    yield* store.insertLocalLabel(label, yield* nowIso);
    yield* publish;
    return label;
  });

  const deleteLabel = Effect.fn("KanbanService.deleteLabel")(function* (input: KanbanLabelRef) {
    const label = (yield* store.listLabels).find((candidate) => candidate.id === input.labelId);
    if (label === undefined) {
      return yield* new KanbanError({ message: `Label ${input.labelId} does not exist.` });
    }
    if (label.source === "linear") {
      return yield* new KanbanError({
        message: `${label.name} is a Linear label; manage it in Linear.`,
      });
    }
    yield* store.deleteLocalLabel(label.id);
    yield* publish;
    return input;
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
    ticketDetail,
    updateTicket,
    comment,
    deleteComment,
    saveView,
    deleteView,
    reorderViews,
    importLinearViews,
    createLabel,
    deleteLabel,
  });
});

/** Needs KanbanStore, BotsStore, LinearClient and ServerSecretStore. */
export const layerService = Layer.effect(KanbanService, make);

export const layer = layerService.pipe(
  Layer.provide(LinearClientModule.layer),
  Layer.provide(KanbanStoreModule.layer),
);
