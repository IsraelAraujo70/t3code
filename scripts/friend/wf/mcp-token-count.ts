#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - workflow CLIs run as plain Node subprocesses.
/** Measures the advertised MCP inventory of this checkout without starting server layers. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { Tool } from "effect/ai";
import { hasFlag, runCli, type McpTokenCountOutput } from "./cli.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const UPSTREAM = {
  preview: ["PreviewStandardToolkit", "PreviewSnapshotToolkit"],
  orchestrator: ["OrchestratorToolkit"],
  thread: ["ThreadToolkit"],
  attachment: ["AttachmentToolkit"],
  project: ["ProjectToolkit"],
  environment: ["EnvironmentToolkit"],
  previewControls: ["PreviewControlsToolkit"],
  worktree: ["WorktreeToolkit"],
  pullRequests: ["PullRequestsToolkit"],
  device: ["DeviceStandardToolkit", "DeviceScreenshotToolkit"],
  html: ["HtmlRenderToolkit", "HtmlPreviewToolkit"],
};
const MODULES = [
  ...Object.entries(UPSTREAM).map(([name, exports]) => ({
    path: `mcp/toolkits/${name}/tools.ts`,
    exports,
    group: "upstream",
  })),
  {
    path: "bots/mcp/tools.ts",
    exports: ["BotMemoryToolkit", "BotManagementToolkit"],
    group: "fork",
  },
  { path: "bots/threadWatch/tools.ts", exports: ["ThreadWatchToolkit"], group: "fork" },
  { path: "bots/kanban/tools.ts", exports: ["KanbanToolkit"], group: "fork" },
];
const HELP = `Usage: node scripts/friend/wf/mcp-token-count.ts [--json]
Estimates tokens as ceil(JSON.stringify(inventory).length / 4), not tokenizer tokens.
Checks registered toolkit names against the inventory; drift exits 1 without a verdict.
`;

/** Extracts the unique toolkit names registered or decoded by the MCP server. */
export function registeredToolkitNames(source: string): string[] {
  return [
    ...new Set(
      Array.from(
        source.matchAll(/(?:toolkitRegistration|decodeAsAdvertised)\(\s*([A-Z]\w*Toolkit)\b/g),
        (match) => match[1]!,
      ),
    ),
  ].sort();
}

/** Rejects missing or unexpected registrations before producing a verdict. */
export function checkToolkitNames(source: string): void {
  const actual = registeredToolkitNames(source);
  const expected = MODULES.flatMap((module) => module.exports);
  const extra = actual.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !actual.includes(name));
  if (extra.length || missing.length)
    throw new Error(`Toolkit drift: extra [${extra.join(", ")}]; missing [${missing.join(", ")}]`);
}

/** Builds the same advertised entries as the server, optionally restricted to one group. */
export async function advertisedTools(group?: "upstream" | "fork") {
  checkToolkitNames(
    NodeFS.readFileSync(NodePath.join(ROOT, "apps/server/src/mcp/McpHttpServer.ts"), "utf8"),
  );
  const schemaModule: unknown = await import(
    NodePath.join(ROOT, "apps/server/src/mcp/advertisedJsonSchema.ts")
  );
  if (
    typeof schemaModule !== "object" ||
    schemaModule === null ||
    !("advertisedJsonSchema" in schemaModule) ||
    typeof schemaModule.advertisedJsonSchema !== "function"
  )
    throw new Error("Invalid advertisedJsonSchema export");
  const schema = schemaModule.advertisedJsonSchema;
  const entries: { name: string; description: string | undefined; inputSchema: unknown }[] = [];
  for (const module of MODULES.filter((module) => group === undefined || module.group === group)) {
    const loaded: Record<string, unknown> = await import(
      NodePath.join(ROOT, "apps/server/src", module.path)
    );
    for (const name of module.exports) {
      const toolkit = loaded[name];
      if (
        (typeof toolkit !== "object" && typeof toolkit !== "function") ||
        toolkit === null ||
        !("tools" in toolkit) ||
        typeof toolkit.tools !== "object" ||
        toolkit.tools === null
      )
        throw new Error(`Invalid toolkit ${name}`);
      for (const tool of Object.values(toolkit.tools)) {
        if (!Tool.isUserDefined(tool) && !Tool.isProviderDefined(tool) && !Tool.isDynamic(tool))
          throw new Error(`Invalid tool in ${name}`);
        entries.push({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: schema(tool),
        });
      }
    }
  }
  return entries;
}

/** Counts characters and estimates tokens for the complete advertised inventory. */
export async function countTokens(): Promise<McpTokenCountOutput> {
  const entries = await advertisedTools();
  const chars = JSON.stringify(entries).length;
  return {
    chars,
    total: Math.ceil(chars / 4),
    method: "chars/4",
    tools: entries.length,
    perTool: Object.fromEntries(
      entries.map((entry) => [entry.name, Math.ceil(JSON.stringify(entry).length / 4)]),
    ),
  };
}

if (import.meta.main) {
  if (hasFlag("--help")) process.stdout.write(HELP);
  else await runCli(countTokens);
}
