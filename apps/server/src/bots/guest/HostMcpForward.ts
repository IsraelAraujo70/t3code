/**
 * Host MCP servers a guest's bot gets as AppTools: T3 calls them with the Bearer, so the sandbox
 * gains no route or secret. Config, rules and failure modes: docs/friend/bot-host-mcp.md.
 */
import type { BotId } from "@t3tools/contracts";
import type { AppTool, AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeOS from "node:os";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const HOST_MCP_FILE_ENV = "T3CODE_BOT_HOST_MCP_FILE";
const LIST_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 10;

/** Server names the agent already sees: the guest's AppTools (GUEST_TOOLS_SERVER, not imported
 * because GuestTools imports this module) and T3's own MCP server. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["t3-guest", "t3-code"]);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Pure. Why a forwarded server's URL is refused, or undefined when it is a loopback http(s) URL. */
export function loopbackUrlIssue(url: string): string | undefined {
  if (!URL.canParse(url)) return "url is not a valid URL";
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url must be http(s)";
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return "url must point at 127.0.0.1, localhost or ::1";
  if (parsed.username !== "" || parsed.password !== "") return "url must not carry credentials";
  return undefined;
}

const ForwardName = Schema.String.check(
  Schema.makeFilter((name) =>
    !/^[a-z0-9_-]+$/.test(name)
      ? "name must match [a-z0-9_-]+"
      : RESERVED_NAMES.has(name)
        ? `name ${name} is reserved`
        : true,
  ),
);

const ForwardServer = Schema.Struct({
  name: ForwardName,
  url: Schema.String.check(Schema.makeFilter((url) => loopbackUrlIssue(url) ?? true)),
  tokenFile: Schema.String.check(Schema.isNonEmpty()),
});
export type ForwardServer = typeof ForwardServer.Type;

const ForwardServers = Schema.Array(ForwardServer).check(
  Schema.makeFilter((servers) =>
    new Set(servers.map((server) => server.name)).size === servers.length
      ? true
      : "server names must be unique per bot",
  ),
);

export const HostMcpConfig = Schema.Record(Schema.String, ForwardServers);
export type HostMcpConfig = typeof HostMcpConfig.Type;
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(HostMcpConfig));

class ForwardFailure extends Schema.TaggedError<ForwardFailure>()("ForwardFailure", {
  /** What the bot reads; never carries the token. */
  message: Schema.String,
}) {}

/** A failed request to the server, already stripped of the token. */
class RemoteFailure extends Data.TaggedError("RemoteFailure")<{
  readonly reason: string;
  readonly detail: string;
}> {}

/** Pure. `text` with every occurrence of `secret` blanked out. */
const redact = (text: string, secret: string) =>
  secret === "" ? text : text.replaceAll(secret, "[redacted]");

/** Pure. A remote tool result as the one text an AppTool returns. */
function resultText(content: ReadonlyArray<unknown>, structured: unknown): string {
  const parts = content.map((part) => {
    if (typeof part !== "object" || part === null) return "";
    const { type, text } = part as { readonly type?: unknown; readonly text?: unknown };
    if (type === "text" && typeof text === "string") return text;
    return `[${typeof type === "string" ? type : "unknown"} content omitted]`;
  });
  const text = parts.filter((part) => part !== "").join("\n");
  if (text === "" && structured !== undefined) return JSON.stringify(structured);
  return text;
}

/** Runs `use` on a connected client and always closes it; aborting `signal` closes it too. */
async function withRemote<A>(
  server: ForwardServer,
  token: string,
  signal: AbortSignal,
  use: (client: Client) => Promise<A>,
): Promise<A> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: "t3-host-mcp-forward", version: "1.0.0" });
  const close = () => void client.close().catch(() => undefined);
  signal.addEventListener("abort", close, { once: true });
  try {
    // The SDK's optional fields predate exactOptionalPropertyTypes; the transport is its own.
    await client.connect(transport as Transport, { signal });
    return await use(client);
  } finally {
    signal.removeEventListener("abort", close);
    await client.close().catch(() => undefined);
  }
}

export class HostMcpForward extends Context.Service<
  HostMcpForward,
  {
    /** One AppTools per configured server of `botId`; servers that failed to list have no tools. */
    readonly forBot: (botId: BotId) => Effect.Effect<ReadonlyArray<AppTools>>;
  }
>()("t3/bots/guest/HostMcpForward") {}

const make = Effect.gen(function* () {
  const services = yield* Effect.context<never>();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const defaultFile = path.join(home, ".t3-friend", "bot-host-mcp.json");
  const configFile = yield* Config.String(HOST_MCP_FILE_ENV).pipe(
    Config.withDefault(defaultFile),
    Effect.orElseSucceed(() => defaultFile),
  );
  const expandHome = (file: string) =>
    file === "~" ? home : file.startsWith("~/") ? path.join(home, file.slice(2)) : file;

  const noConfig: HostMcpConfig = {};
  const readConfig = Effect.gen(function* () {
    if (!(yield* fs.exists(configFile))) return noConfig;
    return yield* decodeConfig(yield* fs.readFileString(configFile));
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Bot host MCP config is unusable; no bot gets forwarded tools.", {
        file: configFile,
        reason: error.message,
      }).pipe(Effect.as(noConfig)),
    ),
  );

  const readToken = (server: ForwardServer) =>
    fs.readFileString(expandHome(server.tokenFile)).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
      Effect.filterOrElse(
        (token) => token !== "",
        () =>
          Effect.logWarning("Bot host MCP token file is missing or empty.", {
            server: server.name,
            tokenFile: server.tokenFile,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ForwardFailure({ message: `${server.name} is not set up on the host.` }),
              ),
            ),
          ),
      ),
    );

  /** One request session to the server under a deadline; failures say only what went wrong. */
  const remote = Effect.fn("HostMcpForward.remote")(function* <A>(
    server: ForwardServer,
    operation: string,
    timeoutMs: number,
    use: (client: Client, signal: AbortSignal) => Promise<A>,
  ) {
    const token = yield* readToken(server);
    return yield* Effect.tryPromise({
      try: (signal) => withRemote(server, token, signal, (client) => use(client, signal)),
      catch: (error) =>
        new RemoteFailure({
          reason:
            error instanceof StreamableHTTPError && error.code !== undefined
              ? `HTTP ${error.code}`
              : "unreachable",
          detail: error instanceof Error ? redact(error.message, token) : "",
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new RemoteFailure({ reason: "timed out", detail: "" })),
      }),
      Effect.catchTags({
        RemoteFailure: (failure) =>
          Effect.logWarning(`Bot host MCP ${operation} failed.`, {
            server: server.name,
            url: server.url,
            reason: failure.reason,
            detail: failure.detail,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ForwardFailure({
                  message: `${server.name} ${operation} failed: ${failure.reason}.`,
                }),
              ),
            ),
          ),
      }),
    );
  });

  const callTool = (server: ForwardServer, name: string) => (args: unknown) =>
    Effect.runPromiseWith(services)(
      (typeof args !== "object" || args === null || Array.isArray(args)
        ? Effect.fail(new ForwardFailure({ message: "Invalid arguments: expected an object." }))
        : remote(server, `call ${name}`, CALL_TIMEOUT_MS, (client, signal) =>
            client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
              signal,
              timeout: CALL_TIMEOUT_MS,
            }),
          )
      ).pipe(
        Effect.map((result) => ({
          text: resultText(
            Array.isArray(result.content) ? result.content : [],
            result.structuredContent,
          ),
          ...(result.isError === true ? { isError: true } : {}),
        })),
        Effect.catchTags({
          ForwardFailure: (failure) => Effect.succeed({ text: failure.message, isError: true }),
        }),
        Effect.catchDefect((defect) =>
          Effect.logError(`Bot host MCP tool ${server.name}/${name} failed`, { defect }).pipe(
            Effect.as({ text: "The tool failed on the server. Try again later.", isError: true }),
          ),
        ),
      ),
    );

  const listTools = (server: ForwardServer) =>
    remote(server, "list", LIST_TIMEOUT_MS, async (client, signal) => {
      const tools: AppTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
          signal,
          timeout: LIST_TIMEOUT_MS,
        });
        for (const tool of result.tools) {
          const { required, ...schema } = tool.inputSchema;
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: {
              ...schema,
              type: "object",
              properties: schema.properties ?? {},
              ...(required === undefined ? {} : { required }),
            },
            run: callTool(server, tool.name),
          });
        }
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      return tools;
    }).pipe(
      Effect.catchTags({ ForwardFailure: () => Effect.succeed([] as ReadonlyArray<AppTool>) }),
      Effect.map((tools): AppTools => ({ server: server.name, tools })),
    );

  const forBot = Effect.fn("HostMcpForward.forBot")(function* (botId: BotId) {
    const servers = (yield* readConfig)[botId] ?? [];
    return yield* Effect.forEach(servers, listTools, { concurrency: "unbounded" });
  });

  return HostMcpForward.of({ forBot });
});

export const layer = Layer.effect(HostMcpForward, make);
