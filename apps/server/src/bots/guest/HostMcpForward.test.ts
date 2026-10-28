// Drives the forward against a fake MCP server over real loopback HTTP.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BotId } from "@t3tools/contracts";
import type { AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import { HOST_MCP_FILE_ENV, HostMcpForward, layer, loopbackUrlIssue } from "./HostMcpForward.ts";

const TOKEN = "test-token-4f1c9d";
const financeBot = BotId.make("b_finance");
const assistantBot = BotId.make("b_assistant");

/**
 * A stateless Streamable HTTP MCP server on an ephemeral loopback port with one `balance` tool.
 * It answers 401 to any other Bearer, echoing the header it got, the way a careless server might.
 */
const fakeServer = (expectedToken: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const authorizations: string[] = [];
      const http = NodeHttp.createServer(async (request, response) => {
        const authorization = request.headers.authorization ?? "";
        authorizations.push(authorization);
        if (authorization !== `Bearer ${expectedToken}`) {
          response.writeHead(401, { "content-type": "text/plain" });
          response.end(`rejected ${authorization}`);
          return;
        }
        const mcp = new Server({ name: "fake", version: "1" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [
            {
              name: "balance",
              description: "Account balance.",
              inputSchema: {
                type: "object",
                properties: { account: { type: "string" } },
                required: ["account"],
              },
            },
          ],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, (call) => {
          const account = call.params.arguments?.account;
          return typeof account === "string"
            ? { content: [{ type: "text", text: `${account}: R$ 10,00` }] }
            : { content: [{ type: "text", text: "account is required" }], isError: true };
        });
        const transport = new StreamableHTTPServerTransport({});
        response.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport as Transport);
        await transport.handleRequest(request, response);
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const { port } = http.address() as NodeNet.AddressInfo;
      return { http, authorizations, url: `http://127.0.0.1:${port}/mcp` };
    }),
    ({ http }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            http.closeAllConnections();
            http.close(() => resolve());
          }),
      ),
  );

interface Fixture {
  readonly service: typeof HostMcpForward.Service;
  readonly logs: ReadonlyArray<string>;
  readonly tokenFile: string;
}

/**
 * Runs `body` against a config naming `url` for the finance bot (or `raw` as the file's text, or
 * no file at all for null), with `token` in the token file (no file when undefined).
 */
const withForward = <A, E>(
  options: {
    readonly url: string;
    readonly token: string | undefined;
    readonly raw?: string | null;
  },
  body: (fixture: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-mcp-" });
    const tokenFile = path.join(dir, "token");
    if (options.token !== undefined) yield* fs.writeFileString(tokenFile, `${options.token}\n`);
    const configFile = path.join(dir, "bot-host-mcp.json");
    if (options.raw !== null) {
      yield* fs.writeFileString(
        configFile,
        options.raw ??
          JSON.stringify({ [financeBot]: [{ name: "pluggy", url: options.url, tokenFile }] }),
      );
    }
    const logs: string[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(JSON.stringify(message));
    });
    const captured = Logger.layer([logger], { mergeWithExisting: false });
    return yield* Effect.gen(function* () {
      return yield* body({ service: yield* HostMcpForward, logs, tokenFile });
    }).pipe(
      Effect.provide(
        // The layer captures its services for tool calls, so it gets the logger as well.
        Layer.mergeAll(layer.pipe(Layer.provide(captured)), captured).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { [HOST_MCP_FILE_ENV]: configFile } }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const run = (servers: ReadonlyArray<AppTools>, name: string, args: unknown) =>
  Effect.promise(() => servers[0]!.tools.find((tool) => tool.name === name)!.run(args));

const noForwardedTools = [{ server: "pluggy", tools: [] }];

describe("HostMcpForward", () => {
  it.live("lists and calls the host server's tools with the Bearer from the token file", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer(TOKEN);
      yield* withForward({ url: fake.url, token: TOKEN }, ({ service }) =>
        Effect.gen(function* () {
          const servers = yield* service.forBot(financeBot);
          assert.deepStrictEqual(
            servers.map((server) => [server.server, server.tools.map((tool) => tool.name)]),
            [["pluggy", ["balance"]]],
          );
          assert.deepStrictEqual(servers[0]!.tools[0]!.inputSchema.required, ["account"]);
          assert.deepStrictEqual(yield* run(servers, "balance", { account: "nubank" }), {
            text: "nubank: R$ 10,00",
          });
          assert.deepStrictEqual(yield* run(servers, "balance", {}), {
            text: "account is required",
            isError: true,
          });
          assert.isTrue((yield* run(servers, "balance", "nubank")).isError);
        }),
      );
      assert.isAbove(fake.authorizations.length, 0);
      for (const authorization of fake.authorizations) {
        assert.strictEqual(authorization, `Bearer ${TOKEN}`);
      }
    }),
  );

  it.live("gives an unlisted bot nothing, and nothing at all without a config file", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer(TOKEN);
      yield* withForward({ url: fake.url, token: TOKEN }, ({ service }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(assistantBot), []);
        }),
      );
      yield* withForward({ url: fake.url, token: TOKEN, raw: null }, ({ service }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(financeBot), []);
        }),
      );
      assert.lengthOf(fake.authorizations, 0);
    }),
  );

  it.live("fails closed when the server is down", () =>
    Effect.gen(function* () {
      // A port that was just free and is closed again.
      const url = yield* fakeServer(TOKEN).pipe(
        Effect.map((fake) => fake.url),
        Effect.scoped,
      );
      yield* withForward({ url, token: TOKEN }, ({ service, logs }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools);
          assert.isTrue(logs.some((log) => log.includes("Bot host MCP list failed")));
          assert.isFalse(logs.some((log) => log.includes(TOKEN)));
        }),
      );
    }),
  );

  it.live("fails closed without a token and never calls the server", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer(TOKEN);
      for (const token of [undefined, "  "]) {
        yield* withForward({ url: fake.url, token }, ({ service, logs }) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools);
            assert.isTrue(logs.some((log) => log.includes("token file is missing or empty")));
          }),
        );
      }
      assert.lengthOf(fake.authorizations, 0);
    }),
  );

  it.live("keeps the token out of logs when the server rejects it", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer("another-token");
      yield* withForward({ url: fake.url, token: TOKEN }, ({ service, logs }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools);
          assert.isTrue(logs.some((log) => log.includes("HTTP 401")));
          assert.isFalse(logs.some((log) => log.includes(TOKEN)));
        }),
      );
      // The server got it and echoed it back in its error body.
      assert.include(fake.authorizations, `Bearer ${TOKEN}`);
    }),
  );

  it.live("reads the token for each call and keeps it out of a failed call's result", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer(TOKEN);
      const rotated = "rotated-token-77ab";
      yield* withForward({ url: fake.url, token: TOKEN }, ({ service, logs, tokenFile }) =>
        Effect.gen(function* () {
          const servers = yield* service.forBot(financeBot);
          yield* (yield* FileSystem.FileSystem).writeFileString(tokenFile, rotated);
          const result = yield* run(servers, "balance", { account: "nubank" });
          assert.isTrue(result.isError);
          assert.include(result.text, "HTTP 401");
          assert.notInclude(result.text, rotated);
          assert.isFalse(logs.some((log) => log.includes(rotated) || log.includes(TOKEN)));
        }),
      );
      assert.include(fake.authorizations, `Bearer ${rotated}`);
    }),
  );

  it.live("forwards nothing from an invalid config", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer(TOKEN);
      const invalid = [
        [{ name: "t3-guest", url: fake.url, tokenFile: "/x" }],
        [{ name: "Pluggy", url: fake.url, tokenFile: "/x" }],
        [{ name: "pluggy", url: "http://10.0.0.5:3796/mcp", tokenFile: "/x" }],
        [{ name: "pluggy", url: "file:///etc/passwd", tokenFile: "/x" }],
        [
          { name: "pluggy", url: fake.url, tokenFile: "/x" },
          { name: "pluggy", url: fake.url, tokenFile: "/y" },
        ],
      ];
      for (const entries of invalid) {
        yield* withForward(
          { url: fake.url, token: TOKEN, raw: JSON.stringify({ [financeBot]: entries }) },
          ({ service, logs }) =>
            Effect.gen(function* () {
              assert.deepStrictEqual(yield* service.forBot(financeBot), []);
              assert.isTrue(logs.some((log) => log.includes("config is unusable")));
            }),
        );
      }
      yield* withForward({ url: fake.url, token: TOKEN, raw: "{not json" }, ({ service }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(financeBot), []);
        }),
      );
      assert.lengthOf(fake.authorizations, 0);
    }),
  );
});

describe("loopbackUrlIssue", () => {
  it("accepts only loopback http(s) URLs without credentials", () => {
    for (const url of [
      "http://127.0.0.1:3796/mcp",
      "https://localhost/mcp",
      "http://[::1]:3796/mcp",
    ]) {
      assert.isUndefined(loopbackUrlIssue(url), url);
    }
    for (const url of [
      "http://example.com/mcp",
      "http://127.0.0.2/mcp",
      "ws://127.0.0.1/mcp",
      "http://user:pass@127.0.0.1/mcp",
      "not a url",
    ]) {
      assert.isDefined(loopbackUrlIssue(url), url);
    }
  });
});
