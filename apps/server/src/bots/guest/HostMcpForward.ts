/**
 * Host MCP servers a bot gets as AppTools: T3 calls them with the Bearer, so neither the bot nor a
 * guest's sandbox is given a route or the secret. Config, rules and failure modes:
 * docs/friend/bot-host-mcp.md.
 */
// Files open with O_NOFOLLOW | O_NONBLOCK and requests go through a capped fetch, which the
// Effect FileSystem and HttpClient cannot express; the MCP SDK takes a fetch function.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
import type { BotId } from "@t3tools/contracts";
import type { AppTool, AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const HOST_MCP_FILE_ENV = "T3CODE_BOT_HOST_MCP_FILE";
const CONFIG_TIMEOUT_MS = 1_000;
const LIST_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 10;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_TOOLS = 128;
export const MAX_CONTENT_BLOCKS = 64;

/** Server names the agent already sees: the guest's AppTools (GUEST_TOOLS_SERVER, not imported
 * because GuestTools imports this module) and T3's own MCP server. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["t3-guest", "t3-code"]);
/** Literal addresses only: a name like `localhost` resolves through DNS at request time. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);

/** Pure. Why a forwarded server's URL is refused, or undefined when it is a loopback http(s) URL. */
export function loopbackUrlIssue(url: string): string | undefined {
  if (!URL.canParse(url)) return "url is not a valid URL";
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url must be http(s)";
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return "url must point at 127.0.0.1 or [::1]";
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
  tokenFile: Schema.String.check(
    Schema.makeFilter((file) =>
      file.startsWith("/") || file.startsWith("~/") ? true : "tokenFile must be absolute or ~/",
    ),
  ),
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
  /** What the bot reads; never carries the token or a remote name. */
  message: Schema.String,
}) {}

/** A failed request to the server, already stripped of the token. */
class RemoteFailure extends Data.TaggedError("RemoteFailure")<{
  readonly reason: string;
  readonly detail: string;
}> {}

class FileRefused extends Data.TaggedError("FileRefused")<{ readonly reason: string }> {}

/** Pure. `text` with every occurrence of `secret` blanked out. */
const redact = (text: string, secret: string) =>
  secret === "" ? text : text.replaceAll(secret, "[redacted]");

/** Pure. `value` with `secret` blanked out of every string in it, object keys included. */
function redactDeep(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redact(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secret));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key, secret), redactDeep(item, secret)]),
    );
  }
  return value;
}

/** Pure. A remote tool result as the one text an AppTool returns. */
function resultText(content: ReadonlyArray<unknown>, structured: unknown): string {
  const parts = content.map((part) => {
    if (typeof part !== "object" || part === null) return "";
    const { type, text } = part as { readonly type?: unknown; readonly text?: unknown };
    if (type === "text" && typeof text === "string") return text;
    return "[non-text content omitted]";
  });
  const text = parts.filter((part) => part !== "").join("\n");
  if (text === "" && structured !== undefined) return JSON.stringify(structured);
  return text;
}

/**
 * The text of a small regular file. Refuses symlinks (O_NOFOLLOW), FIFOs and devices (opened
 * non-blocking, then fstat), and anything over `maxBytes`, so a read can neither hang nor balloon.
 */
async function readRegularFile(file: string, maxBytes: number): Promise<string> {
  const flags =
    NodeFSP.constants.O_RDONLY | NodeFSP.constants.O_NOFOLLOW | NodeFSP.constants.O_NONBLOCK;
  const handle = await NodeFSP.open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new FileRefused({ reason: "not a regular file" });
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw new FileRefused({ reason: `larger than ${maxBytes} bytes` });
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Pure. Why a file could not be read, without its contents. */
function fileIssue(error: unknown): string {
  if (error instanceof FileRefused) return error.reason;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "ENOENT") return "missing";
  if (code === "ELOOP") return "a symlink";
  return typeof code === "string" ? code : "unreadable";
}

/**
 * fetch that never follows a redirect and fails a response body past `maxBytes` while it streams,
 * before the SDK parses it. Covers every request the transport makes, POST and GET/SSE alike.
 */
function cappedFetch(maxBytes: number, state: { tooLarge: boolean }): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, { ...init, redirect: "error" });
    if (response.body === null) return response;
    let total = 0;
    const capped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            state.tooLarge = true;
            controller.error(new Error("response too large"));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(capped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Runs `use` on a connected client and always closes it; aborting `signal` closes it too. */
async function withRemote<A>(
  server: ForwardServer,
  token: string,
  signal: AbortSignal,
  state: { tooLarge: boolean },
  use: (client: Client) => Promise<A>,
): Promise<A> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
    fetch: cappedFetch(MAX_RESPONSE_BYTES, state),
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

/** Pure. Changes whenever the server's address, token file or (redacted) catalog changes. */
function catalogIdentity(server: ForwardServer, tools: ReadonlyArray<AppTool>): string {
  const catalog = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ url: server.url, tokenFile: server.tokenFile, catalog }))
    .digest("hex")
    .slice(0, 16);
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
  const home = NodeOS.homedir();
  const defaultFile = NodePath.join(home, ".t3-friend", "bot-host-mcp.json");
  const configFile = yield* Config.String(HOST_MCP_FILE_ENV).pipe(
    Config.withDefault(defaultFile),
    Effect.orElseSucceed(() => defaultFile),
  );
  const expandHome = (file: string) =>
    file.startsWith("~/") ? NodePath.join(home, file.slice(2)) : file;

  const readFile = (file: string, maxBytes: number) =>
    NodePath.isAbsolute(file)
      ? Effect.tryPromise({
          try: () => readRegularFile(file, maxBytes),
          catch: (error) => new FileRefused({ reason: fileIssue(error) }),
        })
      : Effect.fail(new FileRefused({ reason: "not an absolute path" }));

  const noConfig: HostMcpConfig = {};
  const configUnusable = (reason: string) =>
    Effect.logWarning("Bot host MCP config is unusable; no bot gets forwarded tools.", {
      file: configFile,
      // Decode issues quote the offending value; a URL there may carry credentials.
      reason: reason.replace(/\/\/[^/\s"'@]*@/g, "//[redacted]@"),
    }).pipe(Effect.as(noConfig));
  const readConfig = readFile(configFile, MAX_CONFIG_BYTES).pipe(
    Effect.flatMap(decodeConfig),
    Effect.timeoutOrElse({
      duration: CONFIG_TIMEOUT_MS,
      orElse: () => Effect.fail(new FileRefused({ reason: "timed out" })),
    }),
    Effect.catch((error) =>
      error._tag === "FileRefused" && error.reason === "missing"
        ? Effect.succeed(noConfig)
        : configUnusable(error._tag === "FileRefused" ? error.reason : error.message),
    ),
  );

  const readToken = (server: ForwardServer) =>
    readFile(expandHome(server.tokenFile), MAX_TOKEN_BYTES).pipe(
      Effect.map((text) => text.trim()),
      Effect.filterOrFail(
        (token) => token !== "",
        () => new FileRefused({ reason: "empty" }),
      ),
      Effect.catchTags({
        FileRefused: (refused) =>
          Effect.logWarning("Bot host MCP token file is unusable.", {
            server: server.name,
            tokenFile: server.tokenFile,
            reason: refused.reason,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ForwardFailure({ message: `${server.name} is not set up on the host.` }),
              ),
            ),
          ),
      }),
    );

  /**
   * Reads the token and runs one request session, all under one deadline. `use` gets the token
   * so it can redact what the server sends back. Failures name only the server and the reason.
   */
  const remote = <A>(
    server: ForwardServer,
    operation: "list" | "call",
    timeoutMs: number,
    use: (client: Client, signal: AbortSignal, token: string) => Promise<A>,
  ) => {
    const state = { tooLarge: false };
    return Effect.gen(function* () {
      const token = yield* readToken(server);
      return yield* Effect.tryPromise({
        try: (signal) =>
          withRemote(server, token, signal, state, (client) => use(client, signal, token)),
        catch: (error) =>
          new RemoteFailure({
            reason: state.tooLarge
              ? "response too large"
              : error instanceof RemoteFailure
                ? error.reason
                : error instanceof StreamableHTTPError && error.code !== undefined
                  ? `HTTP ${error.code}`
                  : "unreachable",
            detail: error instanceof Error ? redact(error.message, token) : "",
          }),
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new RemoteFailure({
              reason: state.tooLarge ? "response too large" : "timed out",
              detail: "",
            }),
          ),
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
  };

  const callTool = (server: ForwardServer, name: string) => (args: unknown) =>
    Effect.runPromiseWith(services)(
      (typeof args !== "object" || args === null || Array.isArray(args)
        ? Effect.fail(new ForwardFailure({ message: "Invalid arguments: expected an object." }))
        : remote(server, "call", CALL_TIMEOUT_MS, async (client, signal, token) => {
            const result = await client.callTool(
              { name, arguments: args as Record<string, unknown> },
              undefined,
              { signal, timeout: CALL_TIMEOUT_MS },
            );
            const content = Array.isArray(result.content) ? result.content : [];
            if (content.length > MAX_CONTENT_BLOCKS) {
              throw new RemoteFailure({ reason: "too many content blocks", detail: "" });
            }
            const text = resultText(
              redactDeep(content, token) as ReadonlyArray<unknown>,
              redactDeep(result.structuredContent, token),
            );
            return {
              text: redact(text, token),
              ...(result.isError === true ? { isError: true } : {}),
            };
          })
      ).pipe(
        Effect.catchTags({
          ForwardFailure: (failure) => Effect.succeed({ text: failure.message, isError: true }),
        }),
        Effect.catchDefect((defect) =>
          Effect.logError(`Bot host MCP tool of ${server.name} failed`, { defect }).pipe(
            Effect.as({ text: "The tool failed on the server. Try again later.", isError: true }),
          ),
        ),
      ),
    );

  const listTools = (server: ForwardServer) =>
    remote(server, "list", LIST_TIMEOUT_MS, async (client, signal, token) => {
      const tools: AppTool[] = [];
      let dropped = 0;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
          signal,
          timeout: LIST_TIMEOUT_MS,
        });
        for (const tool of result.tools) {
          if (tool.name.includes(token)) {
            dropped++;
            continue;
          }
          if (tools.length >= MAX_TOOLS) {
            throw new RemoteFailure({ reason: `more than ${MAX_TOOLS} tools`, detail: "" });
          }
          const { required, ...schema } = redactDeep(
            tool.inputSchema,
            token,
          ) as typeof tool.inputSchema;
          tools.push({
            name: tool.name,
            description: redact(tool.description ?? "", token),
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
      return { tools, dropped };
    }).pipe(
      Effect.tap(({ dropped }) =>
        dropped === 0
          ? Effect.void
          : Effect.logWarning("Bot host MCP dropped tools whose name carries the token.", {
              server: server.name,
              dropped,
            }),
      ),
      Effect.map(({ tools }): AppTools => ({
        server: server.name,
        tools,
        identity: catalogIdentity(server, tools),
      })),
      Effect.catchTags({
        ForwardFailure: () => Effect.succeed<AppTools>({ server: server.name, tools: [] }),
      }),
    );

  const forBot = Effect.fn("HostMcpForward.forBot")(
    function* (botId: BotId) {
      const servers = (yield* readConfig)[botId] ?? [];
      return yield* Effect.forEach(servers, listTools, { concurrency: "unbounded" });
    },
    Effect.catchCause((cause) =>
      Effect.logError("Bot host MCP forwarding failed.", { cause }).pipe(
        Effect.as<ReadonlyArray<AppTools>>([]),
      ),
    ),
  );

  return HostMcpForward.of({ forBot });
});

export const layer = Layer.effect(HostMcpForward, make);
