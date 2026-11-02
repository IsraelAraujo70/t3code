import { BotMemoryToolkit, BotManagementToolkit } from "./tools.ts";
import { ThreadWatchToolkit } from "../threadWatch/tools.ts";
import { KanbanToolkit } from "../kanban/tools.ts";
import { WorkflowToolkit } from "../workflows/mcp/tools.ts";

/** The fork's MCP toolkits, as the eval lists them; McpHttpServer registers each with its handlers. */
export const FORK_MCP_TOOLKITS = [
  BotMemoryToolkit,
  BotManagementToolkit,
  ThreadWatchToolkit,
  KanbanToolkit,
  WorkflowToolkit,
] as const;
