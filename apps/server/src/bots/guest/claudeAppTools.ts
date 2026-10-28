/**
 * AppTools as a Claude Agent SDK in-process MCP server. The SDK relays the CLI's MCP traffic for
 * `type: "sdk"` servers over the CLI's own stdin/stdout, so a CLI in a guest's Docker sandbox
 * calls these tools on the host without any network route or credential.
 */
import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** One fresh server per query: the SDK connects each instance to one CLI. */
export function claudeAppToolsServer(appTools: AppTools): McpSdkServerConfigWithInstance {
  const mcp = new McpServer(
    { name: appTools.server, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: appTools.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        ...tool.inputSchema,
        required: tool.inputSchema.required === undefined ? [] : [...tool.inputSchema.required],
      },
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = appTools.tools.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return {
        content: [{ type: "text", text: `Unknown tool ${request.params.name}.` }],
        isError: true,
      };
    }
    const result = await tool.run(request.params.arguments ?? {});
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.isError === true ? { isError: true } : {}),
    };
  });
  // The adapter keys live-query reuse on JSON of the MCP config, so `identity` is enumerable and
  // the instance is not; the SDK sends the CLI only the name and finds the instance with `in`.
  const config = {
    type: "sdk" as const,
    name: appTools.server,
    ...(appTools.identity === undefined ? {} : { identity: appTools.identity }),
  };
  Object.defineProperty(config, "instance", { value: mcp, enumerable: false });
  return config as McpSdkServerConfigWithInstance;
}

interface ClaudeMcpOverrides {
  readonly allowedTools?: ReadonlyArray<string>;
  readonly mcpServers?: Record<string, McpServerConfig> | undefined;
}

/**
 * The adapter's MCP overrides plus the thread's AppTools servers, pre-approved, since headless
 * permission modes deny tools that are not. Servers without tools, or named like a server the
 * overrides already carry, are left out. Unchanged without AppTools.
 */
export function withClaudeAppTools(
  overrides: ClaudeMcpOverrides,
  appTools: ReadonlyArray<AppTools> | undefined,
): ClaudeMcpOverrides {
  const servers = (appTools ?? []).filter(
    (server, index, all) =>
      server.tools.length > 0 &&
      overrides.mcpServers?.[server.server] === undefined &&
      all.findIndex((other) => other.server === server.server) === index,
  );
  if (servers.length === 0) return overrides;
  return {
    ...overrides,
    allowedTools: [
      ...(overrides.allowedTools ?? []),
      ...servers.map((server) => `mcp__${server.server}__*`),
    ],
    mcpServers: {
      ...overrides.mcpServers,
      ...Object.fromEntries(
        servers.map((server) => [server.server, claudeAppToolsServer(server)] as const),
      ),
    },
  };
}
