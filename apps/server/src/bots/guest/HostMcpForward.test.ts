// Drives the forward against a fake MCP server over real loopback HTTP.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BotId } from "@t3tools/contracts";
import type { AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import { withClaudeAppTools } from "./claudeAppTools.ts";
import {
  HOST_MCP_FILE_ENV,
  HostMcpForward,
  layer,
  loopbackUrlIssue,
  MAX_CONTENT_BLOCKS,
  MAX_RESPONSE_BYTES,
  MAX_TOOLS,
} from "./HostMcpForward.ts";

const TOKEN = "test-token-4f1c9d";
const financeBot = BotId.make("b_finance");
const assistantBot = BotId.make("b_assistant");

interface RemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

const balanceTool: RemoteTool = {
  name: "balance",
  description: "Account balance.",
  inputSchema: {
    type: "object",
    properties: { account: { type: "string" } },
    required: ["account"],
  },
};

type CallReply =
  | { readonly result: Record<string, unknown> }
  | { readonly status: number; readonly body: string };

interface FakeOptions {
  /** The Bearer it accepts; anything else gets a 401 echoing the header it got. */
  readonly token?: string;
  readonly tools?: (authorization: string) => ReadonlyArray<RemoteTool>;
  readonly call?: (name: string, args: unknown, authorization: string) => CallReply;
  /** Answers every request with a 307 to this URL. */
  readonly redirectTo?: string;
}

const defaultCall = (_name: string, args: unknown): CallReply => {
  const account = (args as { account?: unknown } | undefined)?.account;
  return {
    result:
      typeof account === "string"
        ? { content: [{ type: "text", text: `${account}: R$ 10,00` }] }
        : { content: [{ type: "text", text: "account is required" }], isError: true },
  };
};

/** A stateless Streamable HTTP MCP server, JSON-RPC by hand, on an ephemeral loopback port. */
const fakeServer = (options: FakeOptions = {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const authorizations: string[] = [];
      const expected = `Bearer ${options.token ?? TOKEN}`;
      const http = NodeHttp.createServer(async (request, response) => {
        const authorization = request.headers.authorization ?? "";
        authorizations.push(authorization);
        if (options.redirectTo !== undefined) {
          response.writeHead(307, { location: options.redirectTo }).end();
          return;
        }
        if (authorization !== expected) {
          response
            .writeHead(401, { "content-type": "text/plain" })
            .end(`rejected ${authorization}`);
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        const message = JSON.parse(raw) as {
          id?: number;
          method: string;
          params?: { protocolVersion?: string; name?: string; arguments?: unknown };
        };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const reply = (result: unknown) =>
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        if (message.method === "initialize") {
          reply({
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          });
        } else if (message.method === "tools/list") {
          reply({ tools: options.tools?.(authorization) ?? [balanceTool] });
        } else if (message.method === "tools/call") {
          const answer = (options.call ?? defaultCall)(
            message.params?.name ?? "",
            message.params?.arguments,
            authorization,
          );
          if ("result" in answer) reply(answer.result);
          else response.writeHead(answer.status, { "content-type": "text/plain" }).end(answer.body);
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "not found" },
            }),
          );
        }
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
  readonly dir: string;
  readonly tokenFile: string;
  readonly configFile: string;
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
    /** What the env names as the config file, when not the file written here. */
    readonly configEnv?: string;
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
      return yield* body({ service: yield* HostMcpForward, logs, dir, tokenFile, configFile });
    }).pipe(
      Effect.provide(
        // The layer captures its services for tool calls, so it gets the logger as well.
        Layer.mergeAll(layer.pipe(Layer.provide(captured)), captured).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { [HOST_MCP_FILE_ENV]: options.configEnv ?? configFile },
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const run = (servers: ReadonlyArray<AppTools>, name: string, args: unknown) =>
  Effect.promise(() => servers[0]!.tools.find((tool) => tool.name === name)!.run(args));

/** What the sandboxed CLI sees of the tools. */
const sandboxView = (servers: ReadonlyArray<AppTools>) =>
  JSON.stringify(
    servers.map((server) =>
      server.tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ),
  );

const noForwardedTools = [{ server: "pluggy", tools: [] }];

describe("HostMcpForward", () => {
  it.live("lists and calls the host server's tools with the Bearer from the token file", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer();
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
      const fake = yield* fakeServer();
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
      const url = yield* fakeServer().pipe(
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
      const fake = yield* fakeServer();
      for (const token of [undefined, "  "]) {
        yield* withForward({ url: fake.url, token }, ({ service, logs }) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools);
            assert.isTrue(logs.some((log) => log.includes("token file is unusable")));
          }),
        );
      }
      assert.lengthOf(fake.authorizations, 0);
    }),
  );

  it.live("keeps the token out of logs when the server rejects it", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer({ token: "another-token" });
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
      const fake = yield* fakeServer();
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

  it.live("keeps a reflected token out of everything the sandbox and the log get", () =>
    Effect.gen(function* () {
      const echo = (authorization: string) => `you sent ${authorization}`;
      const mode = (args: unknown) => (args as { mode?: string } | undefined)?.mode;
      const fake = yield* fakeServer({
        tools: (authorization) => [
          {
            name: "balance",
            description: echo(authorization),
            inputSchema: {
              type: "object",
              properties: { [TOKEN]: { type: "string", description: echo(authorization) } },
            },
          },
          { name: `leak_${TOKEN}`, inputSchema: { type: "object" } },
          { name: "fails", inputSchema: { type: "object" } },
        ],
        call: (name, args, authorization) =>
          name === "fails"
            ? { status: 500, body: echo(authorization) }
            : mode(args) === "structured"
              ? { result: { content: [], structuredContent: { header: echo(authorization) } } }
              : {
                  result: {
                    content: [{ type: "text", text: echo(authorization) }],
                    isError: mode(args) === "error",
                  },
                },
      });
      yield* withForward({ url: fake.url, token: TOKEN }, ({ service, logs }) =>
        Effect.gen(function* () {
          const servers = yield* service.forBot(financeBot);
          assert.deepStrictEqual(
            servers[0]!.tools.map((tool) => tool.name),
            ["balance", "fails"],
          );
          const results = [
            yield* run(servers, "balance", {}),
            yield* run(servers, "balance", { mode: "error" }),
            yield* run(servers, "balance", { mode: "structured" }),
            yield* run(servers, "fails", {}),
          ];
          assert.isTrue(results[1]!.isError);
          assert.isTrue(results[3]!.isError);
          const seen = sandboxView(servers) + JSON.stringify(results);
          assert.include(seen, "[redacted]");
          assert.notInclude(seen, TOKEN);
          assert.isFalse(logs.some((log) => log.includes(TOKEN)));
          assert.isTrue(logs.some((log) => log.includes("dropped tools")));
        }),
      );
    }),
  );

  it.live("refuses an oversized response, too many content blocks and too many tools", () =>
    Effect.gen(function* () {
      const big = yield* fakeServer({
        tools: () => [balanceTool, { ...balanceTool, name: "blocks" }],
        call: (name) => ({
          result: {
            content:
              name === "balance"
                ? [{ type: "text", text: "x".repeat(MAX_RESPONSE_BYTES + 1) }]
                : Array.from({ length: MAX_CONTENT_BLOCKS + 1 }, () => ({
                    type: "text",
                    text: "x",
                  })),
          },
        }),
      });
      yield* withForward({ url: big.url, token: TOKEN }, ({ service }) =>
        Effect.gen(function* () {
          const servers = yield* service.forBot(financeBot);
          assert.deepStrictEqual(yield* run(servers, "balance", {}), {
            text: "pluggy call failed: response too large.",
            isError: true,
          });
          assert.deepStrictEqual(yield* run(servers, "blocks", {}), {
            text: "pluggy call failed: too many content blocks.",
            isError: true,
          });
        }),
      );
      const many = yield* fakeServer({
        tools: () =>
          Array.from({ length: MAX_TOOLS + 1 }, (_, index) => ({
            ...balanceTool,
            name: `tool_${index}`,
          })),
      });
      yield* withForward({ url: many.url, token: TOKEN }, ({ service }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools);
        }),
      );
    }),
  );

  it.live("follows no redirect, so the Bearer stays with the configured address", () =>
    Effect.gen(function* () {
      const destination = yield* fakeServer();
      const redirecting = yield* fakeServer({ redirectTo: destination.url });
      yield* withForward({ url: redirecting.url, token: TOKEN }, ({ service }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools);
        }),
      );
      assert.isAbove(redirecting.authorizations.length, 0);
      assert.lengthOf(destination.authorizations, 0);
    }),
  );

  it.live("reads only small regular files by absolute path, without hanging", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer();
      yield* withForward(
        { url: fake.url, token: TOKEN },
        ({ service, dir, tokenFile, configFile }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const fifo = `${dir}/fifo`;
            NodeChildProcess.execFileSync("mkfifo", [fifo]);
            const link = `${dir}/link`;
            yield* fs.symlink(tokenFile, link);
            const big = `${dir}/big`;
            yield* fs.writeFileString(big, "x".repeat(5000));
            const configFor = (file: string) =>
              JSON.stringify({
                [financeBot]: [{ name: "pluggy", url: fake.url, tokenFile: file }],
              });
            for (const file of [fifo, link, big, dir]) {
              yield* fs.writeFileString(configFile, configFor(file));
              assert.deepStrictEqual(yield* service.forBot(financeBot), noForwardedTools, file);
            }
            // A relative token path is a config error; a FIFO as the config forwards nothing.
            yield* fs.writeFileString(configFile, configFor("token"));
            assert.deepStrictEqual(yield* service.forBot(financeBot), []);
            yield* fs.remove(configFile);
            NodeChildProcess.execFileSync("mkfifo", [configFile]);
            assert.deepStrictEqual(yield* service.forBot(financeBot), []);
          }),
      );
      // A config named by a relative path is not read.
      yield* withForward(
        { url: fake.url, token: TOKEN, configEnv: "bot-host-mcp.json" },
        ({ service, logs }) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* service.forBot(financeBot), []);
            assert.isTrue(logs.some((log) => log.includes("not an absolute path")));
          }),
      );
      assert.lengthOf(fake.authorizations, 0);
    }),
  );

  it.live("changes the server's identity when its address or catalog changes", () =>
    Effect.gen(function* () {
      const first = yield* fakeServer();
      const second = yield* fakeServer();
      const changed = yield* fakeServer({ tools: () => [{ ...balanceTool, description: "New." }] });
      yield* withForward({ url: first.url, token: TOKEN }, ({ service, tokenFile, configFile }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const keyFor = (servers: ReadonlyArray<AppTools>) =>
            JSON.stringify(withClaudeAppTools({}, servers).mcpServers);
          const before = keyFor(yield* service.forBot(financeBot));
          assert.strictEqual(keyFor(yield* service.forBot(financeBot)), before);
          const keys = [before];
          for (const url of [second.url, changed.url]) {
            yield* fs.writeFileString(
              configFile,
              JSON.stringify({ [financeBot]: [{ name: "pluggy", url, tokenFile }] }),
            );
            keys.push(keyFor(yield* service.forBot(financeBot)));
          }
          assert.strictEqual(new Set(keys).size, 3);
          assert.notInclude(keys.join(), TOKEN);
        }),
      );
    }),
  );

  it.live("forwards nothing from an invalid config, and logs no URL credentials", () =>
    Effect.gen(function* () {
      const fake = yield* fakeServer();
      const invalid = [
        [{ name: "t3-guest", url: fake.url, tokenFile: "/x" }],
        [{ name: "Pluggy", url: fake.url, tokenFile: "/x" }],
        [{ name: "pluggy", url: "http://10.0.0.5:3796/mcp", tokenFile: "/x" }],
        [{ name: "pluggy", url: "http://localhost:3796/mcp", tokenFile: "/x" }],
        [{ name: "pluggy", url: "file:///etc/passwd", tokenFile: "/x" }],
        [{ name: "pluggy", url: "http://user:url-secret@127.0.0.1:1/mcp", tokenFile: "/x" }],
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
              assert.isFalse(logs.some((log) => log.includes("url-secret")));
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
  it("accepts only literal loopback http(s) URLs without credentials", () => {
    for (const url of [
      "http://127.0.0.1:3796/mcp",
      "https://127.0.0.1/mcp",
      "http://[::1]:3796/mcp",
    ]) {
      assert.isUndefined(loopbackUrlIssue(url), url);
    }
    for (const url of [
      "http://localhost/mcp",
      "http://example.com/mcp",
      "http://127.0.0.2/mcp",
      "http://[::ffff:127.0.0.1]/mcp",
      "ws://127.0.0.1/mcp",
      "http://user:pass@127.0.0.1/mcp",
      "not a url",
    ]) {
      assert.isDefined(loopbackUrlIssue(url), url);
    }
  });
});
