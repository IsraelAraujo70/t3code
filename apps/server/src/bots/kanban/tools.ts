import {
  KanbanLocalState,
  KanbanTicketId,
  KanbanTicketTitle,
  KanbanWorkspaceId,
  KANBAN_LIMITS,
  LinearId,
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
  url: Schema.NullOr(Schema.String),
  assigneeName: Schema.NullOr(Schema.String),
  threadIds: Schema.Array(ThreadId),
});

const StateView = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  name: Schema.String,
  type: Schema.String,
});

const KanbanListTool = Tool.make("kanban_list", {
  ...shared,
  description: `List the tickets of the Kanban workspaces you are responsible for (a local workspace, or Linear workspaces synced every minute), with each one's state, linked threads and project, plus the workflow states a Linear ticket can move to. ${ONLY_RESPONSIBLE}`,
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    workspaceId: Schema.optional(KanbanWorkspaceId),
  }),
  success: Schema.Struct({
    workspaces: Schema.Array(Schema.Struct({ id: KanbanWorkspaceId, name: Schema.String })),
    tickets: Schema.Array(TicketView),
    states: Schema.Array(StateView),
  }),
})
  .annotate(Tool.Readonly, true)
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
  KanbanMoveTool,
  KanbanCreateTool,
  KanbanLinkThreadTool,
  KanbanUnlinkThreadTool,
);
