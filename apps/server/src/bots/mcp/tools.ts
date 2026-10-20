import { BotMemory, BotMemoryId, BotMemoryText, OrchestratorMcpFailure } from "@t3tools/contracts";
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

export const BotMemoryToolkit = Toolkit.make(MemoryListTool, MemorySaveTool, MemoryForgetTool);
