import {
  Bot,
  BotId,
  BotMemory,
  BotMemoryId,
  BotMemoryText,
  BotName,
  BotRole,
  BotThreadTitle,
  BotThreadEntry,
  BotThreadOpenInput,
  ModelSelection,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as BotsService from "../BotsService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotsService.BotsService,
  ],
};

/** What a bot sees of one of its memories. */
const MemoryView = Schema.Struct({
  id: BotMemory.fields.id,
  text: BotMemory.fields.text,
  enabled: BotMemory.fields.enabled,
  source: BotMemory.fields.source,
});

const MemoryListTool = Tool.make("memory_list", {
  ...shared,
  description:
    "List your memories: durable facts about the user and your work that hold in every future conversation. Enabled memories are already in your instructions.",
  // No `parameters`: the default Tool.EmptyParams encodes to an object schema, as MCP requires.
  success: Schema.Struct({ memories: Schema.Array(MemoryView) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const MemorySaveTool = Tool.make("memory_save", {
  ...shared,
  description:
    "Save a durable fact about the user or your work that should hold in every future conversation. Keep it short and self-contained. Never store secrets.",
  parameters: Schema.Struct({ text: BotMemoryText }),
  success: MemoryView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const MemoryForgetTool = Tool.make("memory_forget", {
  ...shared,
  description: "Forget one of your memories by id, when it is wrong or no longer holds.",
  parameters: Schema.Struct({ memoryId: BotMemoryId }),
  success: Schema.Struct({ memoryId: BotMemoryId }),
}).annotate(Tool.Destructive, true);

const BotThreadOpenTool = Tool.make("bot_thread_open", {
  ...shared,
  description:
    "Open your own separate thread for one subject, such as a long task or a topic the user wants apart, running in parallel with this conversation. It has your role, memories and tools. Put the full brief in message, its first message: it cannot see this conversation. Returns the thread id. Tell the user it exists.",
  parameters: Schema.Struct({
    title: BotThreadTitle,
    message: Schema.optional(BotThreadOpenInput.fields.message.schema),
  }),
  success: Schema.Struct({ threadId: ThreadId, title: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const BotThreadListTool = Tool.make("bot_thread_list", {
  ...shared,
  description: "List your open side threads.",
  success: Schema.Struct({ threads: Schema.Array(BotThreadEntry) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotThreadHideTool = Tool.make("bot_thread_hide", {
  ...shared,
  description:
    "Hide one of your side threads from the user's sidebars, or show it again with hidden false. Use it only when the user asks. A hidden thread still takes messages and runs turns, and stays in search and bot_thread_list.",
  parameters: Schema.Struct({ threadId: ThreadId, hidden: Schema.Boolean }),
  success: Schema.Struct({ threadId: ThreadId, hidden: Schema.Boolean }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

export const BotMemoryToolkit = Toolkit.make(
  MemoryListTool,
  MemorySaveTool,
  MemoryForgetTool,
  BotThreadOpenTool,
  BotThreadListTool,
  BotThreadHideTool,
);

const ONLY_MANAGERS =
  "Only for a bot the user allowed to manage bots in Settings → Bots; every other caller is refused.";

/** What a managing bot sees of a bot. */
const BotView = Schema.Struct({
  id: Bot.fields.id,
  name: Bot.fields.name,
  role: Bot.fields.role,
  model: Bot.fields.model,
  canManageBots: Bot.fields.canManageBots,
  threadId: ThreadId,
});

const BotListTool = Tool.make("bot_list", {
  ...shared,
  description: `List the user's bots, in sidebar order, with each one's full role, model, and conversation thread. ${ONLY_MANAGERS}`,
  success: Schema.Struct({ bots: Schema.Array(BotView) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const BotCreateTool = Tool.make("bot_create", {
  ...shared,
  description: `Create a bot with a name, a standing role, a model, and optional starting memories; its conversation thread starts right away. Pick an enabled provider instance and model with orchestrator_capabilities. Never put secrets in a role or memory. ${ONLY_MANAGERS}`,
  parameters: Schema.Struct({
    name: BotName,
    role: BotRole,
    model: ModelSelection,
    memories: Schema.optional(Schema.Array(BotMemoryText)),
  }),
  success: BotView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const BotUpdateTool = Tool.make("bot_update", {
  ...shared,
  description: `Change a bot's name, role, or model; omitted fields keep their value. A role replaces the old one entirely, so read it with bot_list first. A new model applies from the bot's next conversation. ${ONLY_MANAGERS}`,
  parameters: Schema.Struct({
    botId: BotId,
    name: Schema.optional(BotName),
    role: Schema.optional(BotRole),
    model: Schema.optional(ModelSelection),
  }),
  success: BotView,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const BotDeleteTool = Tool.make("bot_delete", {
  ...shared,
  description: `Delete a bot with its memories and archive its conversation. Only do this when the user asked for it. You cannot delete yourself. ${ONLY_MANAGERS}`,
  parameters: Schema.Struct({ botId: BotId }),
  success: Schema.Struct({ botId: BotId }),
}).annotate(Tool.Destructive, true);

export const BotManagementToolkit = Toolkit.make(
  BotListTool,
  BotCreateTool,
  BotUpdateTool,
  BotDeleteTool,
);
