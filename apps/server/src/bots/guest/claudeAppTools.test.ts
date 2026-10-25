import { assert, describe, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppTools } from "@t3tools/provider-core/server/ProviderAdapter";

import { claudeAppToolsServer, withClaudeAppTools } from "./claudeAppTools.ts";

const appTools: AppTools = {
  server: "t3-guest",
  tools: [
    {
      name: "echo",
      description: "Echoes.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (args) => {
        const text = (args as { text?: unknown }).text;
        return typeof text === "string" ? { text } : { text: "no text", isError: true };
      },
    },
  ],
};

describe("claudeAppToolsServer", () => {
  it("lists and runs the tools over MCP", async () => {
    const config = claudeAppToolsServer(appTools);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    assert.deepStrictEqual(
      tools.map((tool) => [tool.name, tool.inputSchema.required]),
      [["echo", ["text"]]],
    );
    assert.deepStrictEqual(await client.callTool({ name: "echo", arguments: { text: "oi" } }), {
      content: [{ type: "text", text: "oi" }],
    });
    const failed = await client.callTool({ name: "echo", arguments: {} });
    assert.isTrue(failed.isError);
    const unknown = await client.callTool({ name: "rm", arguments: {} });
    assert.isTrue(unknown.isError);
    await client.close();
  });

  it("keeps the instance out of JSON, so the live-query key stays stable", () => {
    const config = claudeAppToolsServer(appTools);
    assert.isTrue("instance" in config);
    assert.strictEqual(JSON.stringify(config), '{"type":"sdk","name":"t3-guest"}');
  });
});

describe("withClaudeAppTools", () => {
  it("adds the server and pre-approves only its tools", () => {
    const merged = withClaudeAppTools({ allowedTools: ["Read"] }, appTools);
    assert.deepStrictEqual(merged.allowedTools, ["Read", "mcp__t3-guest__*"]);
    assert.deepStrictEqual(Object.keys(merged.mcpServers ?? {}), ["t3-guest"]);
    const plain = { allowedTools: ["Read"] };
    assert.strictEqual(withClaudeAppTools(plain, undefined), plain);
  });
});
