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
  type LinearTeamSummary,
  type LinearWorkflowState,
} from "@t3tools/contracts";

const ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;

export interface LinearViewer {
  readonly userName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationUrlKey: string;
}

export interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly priority: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly stateId: string;
  readonly teamId: string;
  readonly assigneeName: string | null;
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
  }
>()("t3/bots/kanban/LinearClient") {}

const ISSUE_FIELDS = `
  id identifier title url priority createdAt updatedAt archivedAt
  state { id } team { id } assignee { name }
`;

const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  state: Schema.Struct({ id: Schema.String }),
  team: Schema.Struct({ id: Schema.String }),
  assignee: Schema.NullOr(Schema.Struct({ name: Schema.String })),
});
type IssueNode = typeof IssueNode.Type;

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
    name: Schema.String,
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

const isStateType = Schema.is(LinearStateType);

function toIssue(node: IssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    priority: node.priority,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt,
    stateId: node.state.id,
    teamId: node.team.id,
    assigneeName: node.assignee?.name ?? null,
  };
}

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

  return LinearClient.of({
    viewer: Effect.fn("LinearClient.viewer")((key) =>
      request(key, ViewerData, `{ viewer { name organization { id name urlKey } } }`, {}).pipe(
        Effect.map(({ viewer }) => ({
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
    setIssueState: Effect.fn("LinearClient.setIssueState")((key, issueId, stateId) =>
      request(
        key,
        IssueUpdateData,
        `mutation($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE_FIELDS} } }
        }`,
        { id: issueId, stateId },
      ).pipe(
        Effect.flatMap(({ issueUpdate }) =>
          issueUpdate.success && issueUpdate.issue !== null
            ? Effect.succeed(toIssue(issueUpdate.issue))
            : Effect.fail(failure("Linear did not move the issue.")),
        ),
      ),
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
  });
});

export const layer = Layer.effect(LinearClient, make);
