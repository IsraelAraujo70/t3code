import {
  BotId,
  KanbanLocalState,
  KanbanPersonId,
  KanbanTicketCommentInput,
  KanbanTicketId,
  KanbanTicketTitle,
  KanbanWorkspaceId,
  KANBAN_LIMITS,
  LinearId,
  LinearStateType,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as BotsService from "../BotsService.ts";
import * as KanbanService from "./KanbanService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotsService.BotsService,
    KanbanService.KanbanService,
  ],
};

export const KANBAN_LIST_DEFAULT = 100;
export const KANBAN_LIST_MAX = 300;

const ONLY_RESPONSIBLE =
  "Only for a bot the user made responsible for the ticket's workspace on the Kanban page; every other caller is refused.";

/** What a bot sees of a ticket. */
export const TicketView = Schema.Struct({
  id: KanbanTicketId,
  identifier: Schema.String,
  title: Schema.String,
  projectId: ProjectId,
  workspaceId: KanbanWorkspaceId,
  /** Linear's workflow state id, or the local state. */
  state: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literals(["local", "linear"]),
  }),
  /** Linear's scale: 0 none, 1 urgent … 4 low. */
  priority: Schema.Struct({ value: Schema.Number, name: Schema.String }),
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  labels: Schema.Array(Schema.String),
  /** The parent issue's identifier. */
  parent: Schema.NullOr(Schema.String),
  subIssues: Schema.NullOr(Schema.Struct({ total: Schema.Number, closed: Schema.Number })),
  /** `#12 open https://github.com/…`. */
  pullRequests: Schema.Array(Schema.String),
  dueDate: Schema.NullOr(Schema.String),
  /** The bot that owns the ticket, if one was set. */
  botId: Schema.NullOr(BotId),
  url: Schema.NullOr(Schema.String),
  threadIds: Schema.Array(ThreadId),
});

const Priority = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }));

const Choice = Schema.Struct({ id: Schema.String, name: Schema.String });

const StateView = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  name: Schema.String,
  type: Schema.String,
});

const KanbanListTool = Tool.make("kanban_list", {
  ...shared,
  description: `List the tickets of the Kanban workspaces you are responsible for (a local workspace, or Linear workspaces synced every minute), most recently updated first, with each one's state, priority, assignee, labels, linked threads and project, plus the workflow states a Linear ticket can move to. Every filter given must match; a list filter matches any of its values. \`assignee\` is a person id, \`none\`, or \`me\` (you, on local tickets). \`stateIds\` takes Linear state ids or local states. \`text\` searches identifiers and titles. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    workspaceId: Schema.optional(KanbanWorkspaceId),
    statusTypes: Schema.optional(Schema.Array(LinearStateType)),
    stateIds: Schema.optional(Schema.Array(Schema.String)),
    assignee: Schema.optional(KanbanPersonId),
    priorities: Schema.optional(Schema.Array(Priority)),
    labels: Schema.optional(Schema.Array(Schema.String)),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
    hasThreads: Schema.optional(Schema.Boolean),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: KANBAN_LIST_MAX })).annotate({
        description: `Default ${KANBAN_LIST_DEFAULT}, at most ${KANBAN_LIST_MAX}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    workspaces: Schema.Array(Schema.Struct({ id: KanbanWorkspaceId, name: Schema.String })),
    tickets: Schema.Array(TicketView),
    states: Schema.Array(StateView),
    /** Present when more tickets matched than `limit`. */
    truncated: Schema.optional(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const KanbanGetTool = Tool.make("kanban_get", {
  ...shared,
  description: `Read one ticket in full: description, parent, sub-issues, comments and history (from Linear for a synced ticket), plus the labels and assignees kanban_update accepts for it. Long text and long lists are trimmed, newest kept, and \`trimmed\` says what was cut. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({ ticketId: KanbanTicketId }),
  success: Schema.Struct({
    ticket: TicketView,
    description: Schema.NullOr(Schema.String),
    parent: Schema.NullOr(
      Schema.Struct({
        identifier: Schema.String,
        title: Schema.String,
        ticketId: Schema.NullOr(KanbanTicketId),
      }),
    ),
    children: Schema.Array(
      Schema.Struct({
        identifier: Schema.String,
        title: Schema.String,
        state: Schema.String,
        ticketId: Schema.NullOr(KanbanTicketId),
      }),
    ),
    /** Oldest first. */
    comments: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: Schema.String,
        body: Schema.String,
        replyTo: Schema.NullOr(Schema.String),
        createdAt: Schema.String,
      }),
    ),
    /** Oldest first. */
    activity: Schema.Array(
      Schema.Struct({ actor: Schema.String, text: Schema.String, createdAt: Schema.String }),
    ),
    labels: Schema.Array(Choice),
    assignees: Schema.Array(Choice),
    trimmed: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const KanbanUpdateTool = Tool.make("kanban_update", {
  ...shared,
  description: `Change a ticket's priority, assignee, labels, due date, title or owning bot; omitted fields stay. A Linear ticket changes in Linear too, and a refusal there changes nothing. \`assigneeId\` is a person id from kanban_get or \`none\`; a local ticket takes \`owner\` (the user) or \`bot:<id>\`. \`labelIds\` replaces the labels. Status changes go through kanban_move. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({
    ticketId: KanbanTicketId,
    priority: Schema.optional(Priority),
    assigneeId: Schema.optional(KanbanPersonId),
    labelIds: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
    dueDate: Schema.optional(
      Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
    ),
    title: Schema.optional(KanbanTicketTitle),
    botId: Schema.optional(Schema.NullOr(BotId)),
  }),
  success: TicketView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const KanbanCommentTool = Tool.make("kanban_comment", {
  ...shared,
  description: `Comment on a ticket, in Markdown. On a Linear ticket the comment is posted in Linear as the account's user; on a local ticket it is signed by you. ${ONLY_RESPONSIBLE}`,
  parameters: KanbanTicketCommentInput,
  success: Schema.Struct({ id: Schema.String, ticketId: KanbanTicketId, author: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const KanbanMoveTool = Tool.make("kanban_move", {
  ...shared,
  description: `Move a ticket to another column. A Linear ticket takes \`stateId\`, a workflow state of its own team from kanban_list, and the issue changes in Linear too. A local ticket takes \`localState\`. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({
    ticketId: KanbanTicketId,
    stateId: Schema.optional(LinearId),
    localState: Schema.optional(KanbanLocalState),
  }),
  success: TicketView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const KanbanCreateTool = Tool.make("kanban_create", {
  ...shared,
  description: `Create a ticket on a project's board. A project linked to Linear gets a new Linear issue in its team (and Linear project, if linked); any other project gets a local ticket. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({
    projectId: ProjectId,
    title: KanbanTicketTitle,
    description: Schema.optional(
      Schema.String.check(Schema.isMaxLength(KANBAN_LIMITS.description)),
    ),
  }),
  success: TicketView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const KanbanLinkThreadTool = Tool.make("kanban_link_thread", {
  ...shared,
  description: `Link a thread to a ticket, so the board shows its status on the card. Without \`threadId\` it links the thread you are running in. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({ ticketId: KanbanTicketId, threadId: Schema.optional(ThreadId) }),
  success: TicketView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const KanbanUnlinkThreadTool = Tool.make("kanban_unlink_thread", {
  ...shared,
  description: `Remove a thread's link to a ticket; the thread itself stays. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({ ticketId: KanbanTicketId, threadId: ThreadId }),
  success: TicketView,
}).annotate(Tool.Destructive, false);

export const KanbanToolkit = Toolkit.make(
  KanbanListTool,
  KanbanGetTool,
  KanbanMoveTool,
  KanbanUpdateTool,
  KanbanCommentTool,
  KanbanCreateTool,
  KanbanLinkThreadTool,
  KanbanUnlinkThreadTool,
);
