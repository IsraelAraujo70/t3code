/**
 * The few Linear GraphQL calls the kanban needs, authenticated with a personal API key (Linear
 * takes it bare in `Authorization`, without `Bearer`). The key arrives redacted and is only
 * unwrapped into the request header.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  KanbanError,
  LinearStateType,
  type KanbanCycle,
  type KanbanLabel,
  type KanbanLinearProject,
  type KanbanMilestone,
  type KanbanPerson,
  type LinearTeamSummary,
  type LinearWorkflowState,
} from "@t3tools/contracts";

import {
  CommentNode,
  IssueDetailNode,
  IssueNode,
  toComment,
  toIssue,
  toIssueDetail,
  type LinearComment,
  type LinearIssue,
  type LinearIssueDetail,
} from "./linearMapping.ts";

export type { LinearComment, LinearIssue, LinearIssueDetail } from "./linearMapping.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;
const CATALOG_MAX_PAGES = 10;

export interface LinearViewer {
  readonly userId: string | null;
  readonly userAvatarUrl: string | null;
  readonly userName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationUrlKey: string;
}

/** The caller adds the organization (or workspace) these belong to. */
export type LinearPerson = Omit<KanbanPerson, "organizationId">;
export type LinearLabel = Omit<KanbanLabel, "workspaceId" | "source">;
export type LinearProject = Omit<KanbanLinearProject, "organizationId">;
export type LinearMilestone = KanbanMilestone & { readonly sortOrder: number };

export interface LinearCustomView {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly color: string | null;
  readonly shared: boolean;
  readonly teamId: string | null;
  /** Linear's IssueFilter JSON; `linearFilterToClauses` reads it. */
  readonly filterData: unknown;
}

/** Omitted fields stay as they are; `null` clears one. */
export interface LinearIssueUpdate {
  readonly stateId?: string;
  readonly priority?: number;
  readonly assigneeId?: string | null;
  readonly labelIds?: ReadonlyArray<string>;
  /** `YYYY-MM-DD`. */
  readonly dueDate?: string | null;
  readonly estimate?: number | null;
  readonly projectId?: string | null;
  readonly cycleId?: string | null;
  readonly projectMilestoneId?: string | null;
  readonly title?: string;
  readonly description?: string;
}

/** Which issues of a team (optionally one Linear project) a query asks for. */
export interface LinearIssueScope {
  readonly teamId: string;
  readonly linearProjectId: string | null;
}

export class LinearClient extends Context.Service<
  LinearClient,
  {
    readonly viewer: (key: Redacted.Redacted) => Effect.Effect<LinearViewer, KanbanError>;
    /** Teams the key can see (up to 100), each with its projects (up to 500 in all). */
    readonly teams: (
      key: Redacted.Redacted,
    ) => Effect.Effect<ReadonlyArray<LinearTeamSummary>, KanbanError>;
    readonly teamStates: (
      key: Redacted.Redacted,
      teamId: string,
    ) => Effect.Effect<ReadonlyArray<LinearWorkflowState>, KanbanError>;
    /**
     * With `recentSince`: open issues plus those updated since then. With `updatedAfter`: every
     * issue updated since. Archived issues are included either way so the caller can drop them.
     * At most `maxPages` pages of 100, newest first from Linear, returned oldest first.
     */
    readonly issues: (
      key: Redacted.Redacted,
      scope: LinearIssueScope,
      window:
        | { readonly updatedAfter: string }
        | { readonly recentSince: string; readonly updatedAfter?: undefined },
      maxPages: number,
    ) => Effect.Effect<ReadonlyArray<LinearIssue>, KanbanError>;
    /** Issues by id wherever they now are, archived included. */
    readonly issuesById: (
      key: Redacted.Redacted,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LinearIssue>, KanbanError>;
    readonly updateIssue: (
      key: Redacted.Redacted,
      issueId: string,
      input: LinearIssueUpdate,
    ) => Effect.Effect<LinearIssue, KanbanError>;
    readonly setIssueState: (
      key: Redacted.Redacted,
      issueId: string,
      stateId: string,
    ) => Effect.Effect<LinearIssue, KanbanError>;
    readonly createIssue: (
      key: Redacted.Redacted,
      input: {
        readonly teamId: string;
        readonly projectId: string | null;
        readonly title: string;
        readonly description: string | null;
      },
    ) => Effect.Effect<LinearIssue, KanbanError>;
    /** Description, parent, sub-issues, the first 100 comments and history entries. */
    readonly issueDetail: (
      key: Redacted.Redacted,
      issueId: string,
    ) => Effect.Effect<LinearIssueDetail, KanbanError>;
    readonly createComment: (
      key: Redacted.Redacted,
      issueId: string,
      body: string,
    ) => Effect.Effect<LinearComment, KanbanError>;
    readonly deleteComment: (
      key: Redacted.Redacted,
      commentId: string,
    ) => Effect.Effect<void, KanbanError>;
    /** Catalogs below read at most 10 pages each. */
    readonly people: (
      key: Redacted.Redacted,
    ) => Effect.Effect<ReadonlyArray<LinearPerson>, KanbanError>;
    readonly labels: (
      key: Redacted.Redacted,
    ) => Effect.Effect<ReadonlyArray<LinearLabel>, KanbanError>;
    readonly linearProjects: (
      key: Redacted.Redacted,
    ) => Effect.Effect<ReadonlyArray<LinearProject>, KanbanError>;
    readonly milestones: (
      key: Redacted.Redacted,
    ) => Effect.Effect<ReadonlyArray<LinearMilestone>, KanbanError>;
    /** The team's cycles ending after `since` (an ISO date). */
    readonly cycles: (
      key: Redacted.Redacted,
      teamId: string,
      since: string,
    ) => Effect.Effect<ReadonlyArray<KanbanCycle>, KanbanError>;
    readonly customViews: (
      key: Redacted.Redacted,
    ) => Effect.Effect<ReadonlyArray<LinearCustomView>, KanbanError>;
  }
>()("t3/bots/kanban/LinearClient") {}

const ISSUE_FIELDS = `
  id identifier title url priority estimate dueDate sortOrder
  createdAt updatedAt completedAt canceledAt archivedAt autoClosedAt
  state { id } team { id } assignee { id name } creator { id }
  project { id } projectMilestone { id } cycle { id }
  parent { id identifier title }
  children(first: 50) { nodes { id state { type } } }
  labels(first: 50) { nodes { id } }
  attachments(first: 25) { nodes { id url title sourceType metadata } }
`;

const Id = Schema.Struct({ id: Schema.String });

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const GraphQlResponse = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.optional(
          Schema.Struct({ userPresentableMessage: Schema.optional(Schema.String) }),
        ),
      }),
    ),
  ),
});

const ViewerData = Schema.Struct({
  viewer: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    avatarUrl: Schema.NullOr(Schema.String),
    organization: Schema.Struct({ id: Schema.String, name: Schema.String, urlKey: Schema.String }),
  }),
});
const TeamsData = Schema.Struct({
  teams: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
    ),
  }),
});
const ProjectsData = Schema.Struct({
  projects: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        teams: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      }),
    ),
    pageInfo: PageInfo,
  }),
});
const StatesData = Schema.Struct({
  team: Schema.Struct({
    states: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          type: Schema.String,
          position: Schema.Number,
          color: Schema.String,
        }),
      ),
    }),
  }),
});
const IssuesData = Schema.Struct({
  issues: Schema.Struct({ nodes: Schema.Array(IssueNode), pageInfo: PageInfo }),
});
const IssueUpdateData = Schema.Struct({
  issueUpdate: Schema.Struct({ success: Schema.Boolean, issue: Schema.NullOr(IssueNode) }),
});
const IssueCreateData = Schema.Struct({
  issueCreate: Schema.Struct({ success: Schema.Boolean, issue: Schema.NullOr(IssueNode) }),
});

const IssueDetailData = Schema.Struct({ issue: IssueDetailNode });
const CommentCreateData = Schema.Struct({
  commentCreate: Schema.Struct({ success: Schema.Boolean, comment: Schema.NullOr(CommentNode) }),
});
const CommentDeleteData = Schema.Struct({
  commentDelete: Schema.Struct({ success: Schema.Boolean }),
});

const Connection = <S extends Schema.Top>(node: S) =>
  Schema.Struct({ nodes: Schema.Array(node), pageInfo: PageInfo });
const UsersData = Schema.Struct({
  users: Connection(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      displayName: Schema.String,
      avatarUrl: Schema.NullOr(Schema.String),
      active: Schema.Boolean,
    }),
  ),
});
const LabelsData = Schema.Struct({
  issueLabels: Connection(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      color: Schema.String,
      parent: Schema.NullOr(Id),
      team: Schema.NullOr(Id),
    }),
  ),
});
const LinearProjectsData = Schema.Struct({
  projects: Connection(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      color: Schema.String,
      icon: Schema.NullOr(Schema.String),
    }),
  ),
});
const MilestonesData = Schema.Struct({
  projectMilestones: Connection(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      sortOrder: Schema.Number,
      project: Id,
    }),
  ),
});
const CyclesData = Schema.Struct({
  team: Schema.Struct({
    cycles: Connection(
      Schema.Struct({
        id: Schema.String,
        number: Schema.Number,
        name: Schema.NullOr(Schema.String),
        startsAt: Schema.String,
        endsAt: Schema.String,
      }),
    ),
  }),
});
const CustomViewsData = Schema.Struct({
  customViews: Connection(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      icon: Schema.NullOr(Schema.String),
      color: Schema.NullOr(Schema.String),
      shared: Schema.Boolean,
      team: Schema.NullOr(Id),
      filterData: Schema.Unknown,
    }),
  ),
});

interface Page<N> {
  readonly nodes: ReadonlyArray<N>;
  readonly pageInfo: typeof PageInfo.Type;
}

const isStateType = Schema.is(LinearStateType);

const failure = (message: string, cause?: unknown) =>
  new KanbanError({ message, ...(cause === undefined ? {} : { cause }) });

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const request = Effect.fn("LinearClient.request")(function* <S extends Schema.Top>(
    key: Redacted.Redacted,
    data: S,
    query: string,
    variables: Record<string, unknown>,
  ) {
    const response = yield* HttpClientRequest.post(ENDPOINT).pipe(
      HttpClientRequest.setHeader("authorization", Redacted.value(key)),
      HttpClientRequest.bodyJson({ query, variables }),
      Effect.flatMap((built) => httpClient.execute(built)),
      Effect.timeout("30 seconds"),
      Effect.mapError((cause) => failure("Could not reach Linear.", cause)),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* failure("Linear refused the API key.");
    }
    const body = yield* HttpClientResponse.schemaBodyJson(GraphQlResponse)(response).pipe(
      Effect.mapError((cause) => failure(`Linear answered HTTP ${response.status}.`, cause)),
    );
    const firstError = body.errors?.[0];
    if (firstError !== undefined) {
      const detail = firstError.extensions?.userPresentableMessage ?? firstError.message;
      return yield* failure(`Linear: ${detail}`);
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failure(`Linear answered HTTP ${response.status}.`);
    }
    return yield* Schema.decodeUnknownEffect(data)(body.data).pipe(
      Effect.mapError((cause) => failure("Linear sent an unexpected answer.", cause)),
    );
  });

  const issuePages = Effect.fn("LinearClient.issuePages")(function* (
    key: Redacted.Redacted,
    filter: Record<string, unknown>,
    maxPages: number,
  ) {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const data: typeof IssuesData.Type = yield* request(
        key,
        IssuesData,
        `query($filter: IssueFilter, $after: String, $first: Int) {
          issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt,
            includeArchived: true) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after, first: PAGE_SIZE },
      );
      issues.push(...data.issues.nodes.map(toIssue));
      if (!data.issues.pageInfo.hasNextPage || data.issues.pageInfo.endCursor === null) break;
      after = data.issues.pageInfo.endCursor;
    }
    // `orderBy: updatedAt` is newest first; callers advance a cursor, so hand them oldest first.
    return issues.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  });

  /** `query` declares `$after: String` and passes it to the one connection `page` reads. */
  const catalogPages = Effect.fn("LinearClient.catalogPages")(function* <S extends Schema.Top, N>(
    key: Redacted.Redacted,
    data: S,
    page: (data: S["Type"]) => Page<N>,
    query: string,
    variables: Record<string, unknown> = {},
  ) {
    const nodes: N[] = [];
    let after: string | null = null;
    for (let index = 0; index < CATALOG_MAX_PAGES; index++) {
      const { nodes: pageNodes, pageInfo }: Page<N> = page(
        yield* request(key, data, query, { ...variables, after }),
      );
      nodes.push(...pageNodes);
      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) break;
      after = pageInfo.endCursor;
    }
    return nodes;
  });

  const updateIssue = Effect.fn("LinearClient.updateIssue")(function* (
    key: Redacted.Redacted,
    issueId: string,
    input: LinearIssueUpdate,
  ) {
    const { issueUpdate } = yield* request(
      key,
      IssueUpdateData,
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
      }`,
      { id: issueId, input },
    );
    if (!issueUpdate.success || issueUpdate.issue === null) {
      return yield* failure("Linear did not update the issue.");
    }
    return toIssue(issueUpdate.issue);
  });

  return LinearClient.of({
    viewer: Effect.fn("LinearClient.viewer")((key) =>
      request(
        key,
        ViewerData,
        `{ viewer { id name avatarUrl organization { id name urlKey } } }`,
        {},
      ).pipe(
        Effect.map(({ viewer }) => ({
          userId: viewer.id,
          userAvatarUrl: viewer.avatarUrl,
          userName: viewer.name,
          organizationId: viewer.organization.id,
          organizationName: viewer.organization.name,
          organizationUrlKey: viewer.organization.urlKey,
        })),
      ),
    ),
    // Projects are read flat and grouped by team: nesting them under teams multiplies Linear's
    // query complexity past its 10,000 limit on a workspace with a few teams.
    teams: Effect.fn("LinearClient.teams")(function* (key) {
      const { teams } = yield* request(
        key,
        TeamsData,
        `{ teams(first: 100) { nodes { id key name } } }`,
        {},
      );
      const projectsByTeam = new Map<string, Array<{ id: string; name: string }>>();
      let after: string | null = null;
      for (let page = 0; page < 5; page++) {
        const data: typeof ProjectsData.Type = yield* request(
          key,
          ProjectsData,
          `query($after: String) {
            projects(first: 100, after: $after) {
              nodes { id name teams(first: 20) { nodes { id } } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { after },
        );
        for (const project of data.projects.nodes) {
          for (const team of project.teams.nodes) {
            const list = projectsByTeam.get(team.id) ?? [];
            list.push({ id: project.id, name: project.name });
            projectsByTeam.set(team.id, list);
          }
        }
        if (!data.projects.pageInfo.hasNextPage || data.projects.pageInfo.endCursor === null) break;
        after = data.projects.pageInfo.endCursor;
      }
      return teams.nodes.map((team) => ({
        id: team.id,
        key: team.key,
        name: team.name,
        projects: projectsByTeam.get(team.id) ?? [],
      }));
    }),
    teamStates: Effect.fn("LinearClient.teamStates")((key, teamId) =>
      request(
        key,
        StatesData,
        `query($id: String!) {
          team(id: $id) { states(first: 100) { nodes { id name type position color } } }
        }`,
        { id: teamId },
      ).pipe(
        Effect.map(({ team }) =>
          team.states.nodes.map((state) => ({
            id: state.id,
            teamId,
            name: state.name,
            // A category Linear adds later still gets a column, beside the backlog.
            type: isStateType(state.type) ? state.type : "backlog",
            position: state.position,
            color: state.color,
          })),
        ),
      ),
    ),
    issues: Effect.fn("LinearClient.issues")((key, scope, window, maxPages) => {
      const base: Record<string, unknown> = {
        team: { id: { eq: scope.teamId } },
        ...(scope.linearProjectId === null
          ? {}
          : { project: { id: { eq: scope.linearProjectId } } }),
      };
      const filter =
        window.updatedAfter !== undefined
          ? { ...base, updatedAt: { gt: window.updatedAfter } }
          : {
              ...base,
              or: [
                { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
                { updatedAt: { gt: window.recentSince } },
              ],
            };
      return issuePages(key, filter, maxPages);
    }),
    issuesById: Effect.fn("LinearClient.issuesById")((key, ids) =>
      ids.length === 0
        ? Effect.succeed([])
        : issuePages(key, { id: { in: ids } }, Math.ceil(ids.length / PAGE_SIZE)),
    ),
    updateIssue,
    setIssueState: Effect.fn("LinearClient.setIssueState")((key, issueId, stateId) =>
      updateIssue(key, issueId, { stateId }),
    ),
    createIssue: Effect.fn("LinearClient.createIssue")((key, input) =>
      request(
        key,
        IssueCreateData,
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
        }`,
        {
          input: {
            teamId: input.teamId,
            title: input.title,
            ...(input.projectId === null ? {} : { projectId: input.projectId }),
            ...(input.description === null ? {} : { description: input.description }),
          },
        },
      ).pipe(
        Effect.flatMap(({ issueCreate }) =>
          issueCreate.success && issueCreate.issue !== null
            ? Effect.succeed(toIssue(issueCreate.issue))
            : Effect.fail(failure("Linear did not create the issue.")),
        ),
      ),
    ),
    issueDetail: Effect.fn("LinearClient.issueDetail")((key, issueId) =>
      request(
        key,
        IssueDetailData,
        `query($id: String!) {
          issue(id: $id) {
            id identifier description
            parent { id identifier title state { id } }
            children(first: 100) {
              nodes { id identifier title priority url state { id } assignee { id } }
            }
            comments(first: 100, orderBy: createdAt) {
              nodes {
                id body createdAt editedAt user { id name displayName avatarUrl }
                botActor { name avatarUrl } parent { id }
              }
            }
            history(first: 100) {
              nodes {
                id createdAt actor { id name displayName avatarUrl } botActor { name avatarUrl }
                fromState { name } toState { name } fromAssignee { name } toAssignee { name }
                fromPriority toPriority addedLabels { name } removedLabels { name }
                fromParent { identifier } toParent { identifier } fromTitle toTitle
                fromDueDate toDueDate fromProject { name } toProject { name }
                fromCycle { number } toCycle { number } fromEstimate toEstimate
                archived trashed autoClosed autoArchived
              }
            }
          }
        }`,
        { id: issueId },
      ).pipe(Effect.map(({ issue }) => toIssueDetail(issue))),
    ),
    createComment: Effect.fn("LinearClient.createComment")(function* (key, issueId, body) {
      const { commentCreate } = yield* request(
        key,
        CommentCreateData,
        `mutation($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment {
              id body createdAt editedAt user { id name displayName avatarUrl } parent { id }
            }
          }
        }`,
        { input: { issueId, body } },
      );
      if (!commentCreate.success || commentCreate.comment === null) {
        return yield* failure("Linear did not add the comment.");
      }
      return toComment(commentCreate.comment);
    }),
    deleteComment: Effect.fn("LinearClient.deleteComment")(function* (key, commentId) {
      const { commentDelete } = yield* request(
        key,
        CommentDeleteData,
        `mutation($id: String!) { commentDelete(id: $id) { success } }`,
        { id: commentId },
      );
      if (!commentDelete.success) return yield* failure("Linear did not delete the comment.");
    }),
    people: Effect.fn("LinearClient.people")((key) =>
      catalogPages(
        key,
        UsersData,
        (data) => data.users,
        `query($after: String) {
          users(first: 250, after: $after) {
            nodes { id name displayName avatarUrl active }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      ),
    ),
    labels: Effect.fn("LinearClient.labels")((key) =>
      catalogPages(
        key,
        LabelsData,
        (data) => data.issueLabels,
        `query($after: String) {
          issueLabels(first: 250, after: $after) {
            nodes { id name color parent { id } team { id } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      ).pipe(
        Effect.map((labels) =>
          labels.map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color,
            parentId: label.parent?.id ?? null,
            teamId: label.team?.id ?? null,
          })),
        ),
      ),
    ),
    linearProjects: Effect.fn("LinearClient.linearProjects")((key) =>
      catalogPages(
        key,
        LinearProjectsData,
        (data) => data.projects,
        `query($after: String) {
          projects(first: 100, after: $after) {
            nodes { id name color icon }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      ),
    ),
    milestones: Effect.fn("LinearClient.milestones")((key) =>
      catalogPages(
        key,
        MilestonesData,
        (data) => data.projectMilestones,
        `query($after: String) {
          projectMilestones(first: 250, after: $after) {
            nodes { id name sortOrder project { id } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      ).pipe(
        Effect.map((milestones) =>
          milestones.map((milestone) => ({
            id: milestone.id,
            projectId: milestone.project.id,
            name: milestone.name,
            sortOrder: milestone.sortOrder,
          })),
        ),
      ),
    ),
    cycles: Effect.fn("LinearClient.cycles")((key, teamId, since) =>
      catalogPages(
        key,
        CyclesData,
        (data) => data.team.cycles,
        `query($id: String!, $since: DateTimeOrDuration!, $after: String) {
          team(id: $id) {
            cycles(first: 50, after: $after, filter: { endsAt: { gt: $since } }) {
              nodes { id number name startsAt endsAt }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: teamId, since },
      ).pipe(Effect.map((cycles) => cycles.map((cycle) => ({ ...cycle, teamId })))),
    ),
    customViews: Effect.fn("LinearClient.customViews")((key) =>
      catalogPages(
        key,
        CustomViewsData,
        (data) => data.customViews,
        `query($after: String) {
          customViews(first: 50, after: $after) {
            nodes { id name icon color shared team { id } filterData }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      ).pipe(
        Effect.map((views) =>
          views.map(({ team, ...view }) => ({ ...view, teamId: team?.id ?? null })),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(LinearClient, make);
