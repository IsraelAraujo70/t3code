/**
 * Pure mapping from Linear's GraphQL answers to the kanban's shapes: the synced issue, its
 * attached GitHub pull requests, the issue detail, and history entries phrased for a timeline.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { KanbanPullRequestRef } from "@t3tools/contracts";

const Id = Schema.Struct({ id: Schema.String });
const Name = Schema.Struct({ name: Schema.String });

const LinearUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});
const BotActor = Schema.Struct({ name: Schema.String, avatarUrl: Schema.NullOr(Schema.String) });

export const LinearAttachment = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
  sourceType: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
});

export const IssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.Number,
  estimate: Schema.NullOr(Schema.Number),
  dueDate: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  canceledAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  autoClosedAt: Schema.NullOr(Schema.String),
  state: Id,
  team: Id,
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  creator: Schema.NullOr(Id),
  project: Schema.NullOr(Id),
  projectMilestone: Schema.NullOr(Id),
  cycle: Schema.NullOr(Id),
  parent: Schema.NullOr(
    Schema.Struct({ id: Schema.String, identifier: Schema.String, title: Schema.String }),
  ),
  children: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ id: Schema.String, state: Schema.Struct({ type: Schema.String }) }),
    ),
  }),
  labels: Schema.Struct({ nodes: Schema.Array(Id) }),
  attachments: Schema.Struct({ nodes: Schema.Array(LinearAttachment) }),
});
export type IssueNode = typeof IssueNode.Type;

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
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly creatorId: string | null;
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly labelIds: ReadonlyArray<string>;
  readonly projectId: string | null;
  readonly milestoneId: string | null;
  readonly cycleId: string | null;
  readonly parent: {
    readonly issueId: string;
    readonly identifier: string;
    readonly title: string;
  } | null;
  readonly subIssues: { readonly total: number; readonly closed: number } | null;
  readonly pullRequests: ReadonlyArray<KanbanPullRequestRef>;
  readonly sortOrder: number;
  readonly closedAt: string | null;
  readonly autoClosed: boolean;
}

const CLOSED_STATE_TYPES: ReadonlySet<string> = new Set(["completed", "canceled", "duplicate"]);
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

const PullRequestMetadata = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const decodePullRequestMetadata = Schema.decodeUnknownOption(PullRequestMetadata);

/** A GitHub pull request from Linear's GitHub integration; null for any other attachment. */
export function parsePullRequest(
  attachment: typeof LinearAttachment.Type,
): KanbanPullRequestRef | null {
  if (attachment.sourceType !== "github") return null;
  const match = PULL_REQUEST_URL.exec(attachment.url);
  if (match === null) return null;
  const metadata = Option.getOrElse(decodePullRequestMetadata(attachment.metadata), () => ({
    status: null,
    mergedAt: null,
    draft: null,
  }));
  const state =
    metadata.status === "merged" || (metadata.mergedAt ?? null) !== null
      ? "merged"
      : metadata.status === "closed"
        ? "closed"
        : metadata.draft === true
          ? "draft"
          : "open";
  return {
    attachmentId: attachment.id,
    url: attachment.url,
    repository: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    title: attachment.title,
    state,
  };
}

export function toIssue(node: IssueNode): LinearIssue {
  const children = node.children.nodes;
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
    assigneeId: node.assignee?.id ?? null,
    assigneeName: node.assignee?.name ?? null,
    creatorId: node.creator?.id ?? null,
    estimate: node.estimate,
    dueDate: node.dueDate,
    labelIds: node.labels.nodes.map((label) => label.id),
    projectId: node.project?.id ?? null,
    milestoneId: node.projectMilestone?.id ?? null,
    cycleId: node.cycle?.id ?? null,
    parent:
      node.parent === null
        ? null
        : { issueId: node.parent.id, identifier: node.parent.identifier, title: node.parent.title },
    subIssues:
      children.length === 0
        ? null
        : {
            total: children.length,
            closed: children.filter((child) => CLOSED_STATE_TYPES.has(child.state.type)).length,
          },
    pullRequests: node.attachments.nodes.flatMap(
      (attachment) => parsePullRequest(attachment) ?? [],
    ),
    sortOrder: node.sortOrder,
    closedAt: node.completedAt ?? node.canceledAt,
    autoClosed: node.autoClosedAt !== null,
  };
}

/** `botActor` is absent from the `commentCreate` selection; a comment we create has none. */
export const CommentNode = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  editedAt: Schema.NullOr(Schema.String),
  user: Schema.NullOr(LinearUser),
  botActor: Schema.optional(Schema.NullOr(BotActor)),
  parent: Schema.NullOr(Id),
});

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly user: typeof LinearUser.Type | null;
  readonly botActor: typeof BotActor.Type | null;
  /** The comment this one replies to. */
  readonly parentId: string | null;
}

export function toComment(node: typeof CommentNode.Type): LinearComment {
  return {
    id: node.id,
    body: node.body,
    createdAt: node.createdAt,
    editedAt: node.editedAt,
    user: node.user,
    botActor: node.botActor ?? null,
    parentId: node.parent?.id ?? null,
  };
}

export const HistoryNode = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  actor: Schema.NullOr(LinearUser),
  botActor: Schema.NullOr(BotActor),
  fromState: Schema.NullOr(Name),
  toState: Schema.NullOr(Name),
  fromAssignee: Schema.NullOr(Name),
  toAssignee: Schema.NullOr(Name),
  fromPriority: Schema.NullOr(Schema.Number),
  toPriority: Schema.NullOr(Schema.Number),
  addedLabels: Schema.NullOr(Schema.Array(Name)),
  removedLabels: Schema.NullOr(Schema.Array(Name)),
  fromParent: Schema.NullOr(Schema.Struct({ identifier: Schema.String })),
  toParent: Schema.NullOr(Schema.Struct({ identifier: Schema.String })),
  fromTitle: Schema.NullOr(Schema.String),
  toTitle: Schema.NullOr(Schema.String),
  fromDueDate: Schema.NullOr(Schema.String),
  toDueDate: Schema.NullOr(Schema.String),
  fromProject: Schema.NullOr(Name),
  toProject: Schema.NullOr(Name),
  fromCycle: Schema.NullOr(Schema.Struct({ number: Schema.Number })),
  toCycle: Schema.NullOr(Schema.Struct({ number: Schema.Number })),
  fromEstimate: Schema.NullOr(Schema.Number),
  toEstimate: Schema.NullOr(Schema.Number),
  archived: Schema.NullOr(Schema.Boolean),
  trashed: Schema.NullOr(Schema.Boolean),
  autoClosed: Schema.NullOr(Schema.Boolean),
  autoArchived: Schema.NullOr(Schema.Boolean),
});
export type LinearHistoryEntry = typeof HistoryNode.Type;

export const IssueDetailNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  description: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      identifier: Schema.String,
      title: Schema.String,
      state: Id,
    }),
  ),
  children: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        identifier: Schema.String,
        title: Schema.String,
        priority: Schema.Number,
        url: Schema.String,
        state: Id,
        assignee: Schema.NullOr(Id),
      }),
    ),
  }),
  comments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
  history: Schema.Struct({ nodes: Schema.Array(HistoryNode) }),
});

export interface LinearIssueDetail {
  readonly description: string | null;
  readonly parent: {
    readonly issueId: string;
    readonly identifier: string;
    readonly title: string;
    readonly stateId: string;
  } | null;
  readonly children: ReadonlyArray<{
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly priority: number;
    readonly url: string;
    readonly stateId: string;
    readonly assigneeId: string | null;
  }>;
  readonly comments: ReadonlyArray<LinearComment>;
  /** Newest first, as Linear sends it. */
  readonly history: ReadonlyArray<LinearHistoryEntry>;
}

export function toIssueDetail(node: typeof IssueDetailNode.Type): LinearIssueDetail {
  return {
    description: node.description,
    parent:
      node.parent === null
        ? null
        : {
            issueId: node.parent.id,
            identifier: node.parent.identifier,
            title: node.parent.title,
            stateId: node.parent.state.id,
          },
    children: node.children.nodes.map((child) => ({
      id: child.id,
      identifier: child.identifier,
      title: child.title,
      priority: child.priority,
      url: child.url,
      stateId: child.state.id,
      assigneeId: child.assignee?.id ?? null,
    })),
    comments: node.comments.nodes.map(toComment),
    history: node.history.nodes,
  };
}

const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];
const priorityName = (priority: number | null) =>
  priority === null ? null : (PRIORITY_NAMES[priority] ?? String(priority));

function describeChange(
  field: string,
  from: string | number | null,
  to: string | number | null,
): string | null {
  if (from === null && to === null) return null;
  if (from === null) return `set ${field} to ${to}`;
  if (to === null) return `removed ${field}`;
  return `changed ${field} from ${from} to ${to}`;
}

function describeAssignee(from: string | null, to: string | null): string | null {
  if (from === null && to === null) return null;
  if (from === null) return `assigned to ${to}`;
  if (to === null) return `unassigned ${from}`;
  return `changed assignee from ${from} to ${to}`;
}

function describeLabels(verb: string, labels: ReadonlyArray<{ readonly name: string }> | null) {
  if (labels === null || labels.length === 0) return null;
  const noun = labels.length === 1 ? "label" : "labels";
  return `${verb} ${noun} ${labels.map((label) => label.name).join(", ")}`;
}

/**
 * The sentence after the actor's name for one history entry ("changed status from Backlog to
 * Done"), several changes joined with ", "; null when it records nothing we can phrase.
 */
export function phraseHistory(entry: LinearHistoryEntry): string | null {
  const phrases = [
    describeChange("status", entry.fromState?.name ?? null, entry.toState?.name ?? null),
    describeAssignee(entry.fromAssignee?.name ?? null, entry.toAssignee?.name ?? null),
    describeChange("priority", priorityName(entry.fromPriority), priorityName(entry.toPriority)),
    describeLabels("added", entry.addedLabels),
    describeLabels("removed", entry.removedLabels),
    describeChange(
      "parent issue",
      entry.fromParent?.identifier ?? null,
      entry.toParent?.identifier ?? null,
    ),
    describeChange("the title", entry.fromTitle, entry.toTitle),
    describeChange("due date", entry.fromDueDate, entry.toDueDate),
    describeChange("project", entry.fromProject?.name ?? null, entry.toProject?.name ?? null),
    describeChange("cycle", entry.fromCycle?.number ?? null, entry.toCycle?.number ?? null),
    describeChange("estimate", entry.fromEstimate, entry.toEstimate),
    entry.archived === true ? "archived the issue" : null,
    entry.autoArchived === true ? "auto-archived the issue" : null,
    entry.autoClosed === true ? "auto-closed the issue" : null,
    entry.trashed === true ? "deleted the issue" : null,
  ].filter((phrase) => phrase !== null);
  return phrases.length === 0 ? null : phrases.join(", ");
}
