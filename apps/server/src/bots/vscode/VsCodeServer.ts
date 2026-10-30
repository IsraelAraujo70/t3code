// @effect-diagnostics nodeBuiltinImport:off - systemd-run and systemctl run once per start or stop; undici reaches the unix socket.
/**
 * One `code serve-web` per T3 server, a capped transient systemd unit started on demand and stopped
 * when idle. It has no connection token, because its client repeats the token inside the socket
 * protocol; a unix socket in a 0700 directory keeps other users and web pages out.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as Undici from "undici";

import { VSCODE_BASE_PATH } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../../config.ts";

export const VSCODE_CLI_ENV = "T3CODE_VSCODE_CLI";
export const VSCODE_DATA_DIR_ENV = "T3CODE_VSCODE_DATA_DIR";
export const VSCODE_IDLE_MS_ENV = "T3CODE_VSCODE_IDLE_MS";
export const VSCODE_MEMORY_MAX_ENV = "T3CODE_VSCODE_MEMORY_MAX";

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MEMORY_MAX = "3G";
const READY_TIMEOUT = Duration.seconds(60);
const COMMAND_TIMEOUT_MS = 30_000;

export class VsCodeError extends Schema.TaggedError<VsCodeError>()("VsCodeError", {
  message: Schema.String,
}) {}

/** Every upstream URL uses this origin; the connection goes to serve-web's socket. */
export const UPSTREAM_ORIGIN = "http://vscode.local";

/** How the proxy reaches a running serve-web. */
export interface VsCodeUpstream {
  readonly http: HttpClient.HttpClient;
  readonly openWebSocket: (url: string) => Socket.WebSocketLike;
}

// undici is external to the CLI bundle; see outboundHttp.ts.
const requireUndici = NodeModule.createRequire(import.meta.url);

/** HTTP and WebSocket over a unix socket, through npm undici's dispatcher. */
export const unixSocketUpstream = Effect.fn("VsCodeServer.unixSocketUpstream")(function* (
  socketPath: string,
) {
  const undici = requireUndici("undici") as typeof Undici;
  const agent = new undici.Agent({ connect: { socketPath } });
  // The fetch client reads Fetch and RequestInit per request, so each request gets them here.
  // npm undici's fetch and WebSocket match the globals at runtime; only their types differ.
  const http = HttpClient.transform(
    yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)),
    (response) =>
      response.pipe(
        Effect.provideService(FetchHttpClient.Fetch, undici.fetch as unknown as typeof fetch),
        Effect.provideService(FetchHttpClient.RequestInit, {
          dispatcher: agent,
        } as unknown as RequestInit),
      ),
  );
  const upstream: VsCodeUpstream = {
    http,
    openWebSocket: (url) =>
      new undici.WebSocket(url, { dispatcher: agent }) as unknown as Socket.WebSocketLike,
  };
  return { upstream, close: Effect.promise(() => agent.close()) };
});

/** Starts and stops the serve-web process; injectable so tests need no systemd. */
export interface VsCodeLauncher {
  /** Starts serve-web and waits until it answers. */
  readonly launch: Effect.Effect<VsCodeUpstream, VsCodeError>;
  readonly stop: Effect.Effect<void>;
}

export class VsCodeServer extends Context.Service<
  VsCodeServer,
  {
    /** The running server, started first when needed. Counts as activity. */
    readonly upstream: Effect.Effect<VsCodeUpstream, VsCodeError>;
    /** Keeps the server from idling while the scope lives: one per proxied WebSocket. */
    readonly holdOpen: Effect.Effect<void, never, Scope.Scope>;
    /** Forgets a server the proxy could not reach, so the next request starts a new one. */
    readonly lost: (upstream: VsCodeUpstream) => Effect.Effect<void>;
  }
>()("t3/bots/vscode/VsCodeServer") {}

/** How often the idle check runs: often enough to stop within a quarter of the timeout. */
export const idleCheckInterval = (idleMs: number) =>
  Duration.millis(Math.min(Math.max(Math.floor(idleMs / 4), 1000), 60_000));

export const make = Effect.fn("VsCodeServer.make")(function* (
  launcher: VsCodeLauncher,
  idleMs: number,
) {
  const lock = yield* Semaphore.make(1);
  let running: VsCodeUpstream | undefined;
  let openConnections = 0;
  let lastActivity = yield* Clock.currentTimeMillis;
  const touch = Effect.map(Clock.currentTimeMillis, (now) => {
    lastActivity = now;
  });

  const stopIfIdle = lock.withPermits(1)(
    Effect.gen(function* () {
      if (running === undefined || openConnections > 0) return;
      if ((yield* Clock.currentTimeMillis) - lastActivity < idleMs) return;
      running = undefined;
      yield* Effect.logInfo("VS Code was idle; stopping it.");
      yield* launcher.stop;
    }),
  );
  yield* stopIfIdle.pipe(
    Effect.repeat(Schedule.spaced(idleCheckInterval(idleMs))),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => (running === undefined ? Effect.void : launcher.stop)),
  );

  const upstream = Effect.gen(function* () {
    yield* touch;
    if (running !== undefined) return running;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (running !== undefined) return running;
        yield* Effect.logInfo("Starting VS Code.");
        running = yield* launcher.launch;
        yield* touch;
        return running;
      }),
    );
  });

  return VsCodeServer.of({
    upstream,
    holdOpen: Effect.acquireRelease(
      Effect.sync(() => {
        openConnections += 1;
      }),
      () =>
        Effect.andThen(
          Effect.sync(() => {
            openConnections -= 1;
          }),
          touch,
        ),
    ).pipe(Effect.asVoid),
    lost: Effect.fn("VsCodeServer.lost")(function* (lostUpstream: VsCodeUpstream) {
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          if (running === lostUpstream) running = undefined;
        }),
      );
    }),
  });
});

export interface VsCodeSettings {
  readonly cli: string;
  readonly dataDir: string;
  readonly idleMs: number;
  readonly memoryMax: string;
  readonly unit: string;
}

/** Reads the env once at startup. The unit name follows the T3 state dir, so servers never share one. */
export const readSettings = Effect.fn("VsCodeServer.readSettings")(function* (stateDir: string) {
  const home = NodeOS.homedir();
  const cli = yield* Config.String(VSCODE_CLI_ENV).pipe(
    Config.withDefault(NodePath.join(home, ".t3-friend", "vscode", "bin", "code")),
  );
  const dataDir = yield* Config.String(VSCODE_DATA_DIR_ENV).pipe(
    Config.withDefault(NodePath.join(home, ".t3-friend", "vscode")),
  );
  const idleMs = yield* Config.Int(VSCODE_IDLE_MS_ENV).pipe(Config.withDefault(DEFAULT_IDLE_MS));
  const memoryMax = yield* Config.String(VSCODE_MEMORY_MAX_ENV).pipe(
    Config.withDefault(DEFAULT_MEMORY_MAX),
  );
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
  return {
    cli,
    dataDir,
    idleMs: Math.max(idleMs, 1000),
    memoryMax,
    unit: `t3code-vscode-${hash}.service`,
  } satisfies VsCodeSettings;
});

const execCommand = (command: string, args: ReadonlyArray<string>) =>
  Effect.callback<string, VsCodeError>((resume) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim() || error.message;
          resume(Effect.fail(new VsCodeError({ message: `${command} failed: ${detail}` })));
        } else {
          resume(Effect.succeed(String(stdout)));
        }
      },
    );
    return Effect.sync(() => child.kill());
  });

const isExecutable = (path: string) => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** serve-web as a transient `systemd-run --user` unit. */
export const systemdLauncher = (settings: VsCodeSettings): VsCodeLauncher => {
  const runDir = NodePath.join(settings.dataDir, "run");
  // A unix socket path is capped near 108 bytes, so the name is short.
  const socketPath = NodePath.join(runDir, `${settings.unit.replace(/\.service$/, "")}.sock`);
  let closeUpstream: Effect.Effect<void> = Effect.void;

  const stop = Effect.gen(function* () {
    yield* execCommand("systemctl", ["--user", "stop", settings.unit]).pipe(Effect.ignore);
    yield* execCommand("systemctl", ["--user", "reset-failed", settings.unit]).pipe(Effect.ignore);
    yield* closeUpstream;
    closeUpstream = Effect.void;
    yield* Effect.sync(() => NodeFS.rmSync(socketPath, { force: true }));
  });

  const waitUntilReady = (upstream: VsCodeUpstream) =>
    upstream.http.execute(HttpClientRequest.get(`${UPSTREAM_ORIGIN}${VSCODE_BASE_PATH}/`)).pipe(
      Effect.scoped,
      Effect.retry(Schedule.spaced("250 millis")),
      Effect.timeout(READY_TIMEOUT),
      Effect.mapError(
        () =>
          new VsCodeError({
            message: `VS Code did not answer within 60 seconds. See journalctl --user -u ${settings.unit}.`,
          }),
      ),
      Effect.asVoid,
    );

  const launch = Effect.gen(function* () {
    if (!isExecutable(settings.cli)) {
      return yield* new VsCodeError({
        message: `The VS Code CLI is not installed at ${settings.cli}. Download the standalone "code" CLI there, or point ${VSCODE_CLI_ENV} at it.`,
      });
    }
    // A unit left by an earlier server process would hold the socket.
    yield* stop;
    yield* Effect.try({
      try: () => {
        NodeFS.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        NodeFS.chmodSync(runDir, 0o700);
        NodeFS.rmSync(socketPath, { force: true });
      },
      catch: (cause) =>
        new VsCodeError({ message: `Cannot prepare ${runDir} for VS Code's socket: ${cause}` }),
    });
    const env = ["PATH", "LANG", "SHELL"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : ["-E", `${name}=${value}`];
    });
    yield* execCommand("systemd-run", [
      "--user",
      `--unit=${settings.unit}`,
      "--collect",
      "--quiet",
      `--working-directory=${NodeOS.homedir()}`,
      "-p",
      `MemoryMax=${settings.memoryMax}`,
      "-p",
      "CPUWeight=20",
      "-p",
      "IOWeight=20",
      "-p",
      "StandardOutput=null",
      ...env,
      settings.cli,
      "serve-web",
      "--socket-path",
      socketPath,
      "--without-connection-token",
      "--accept-server-license-terms",
      "--server-base-path",
      VSCODE_BASE_PATH,
      "--server-data-dir",
      NodePath.join(settings.dataDir, "server"),
      "--cli-data-dir",
      NodePath.join(settings.dataDir, "cli"),
      "--disable-telemetry",
    ]);
    const { upstream, close } = yield* unixSocketUpstream(socketPath);
    closeUpstream = close;
    yield* waitUntilReady(upstream).pipe(Effect.tapError(() => stop));
    yield* Effect.logInfo("VS Code is running.", { unit: settings.unit });
    return upstream;
  });

  return { launch, stop };
};

export const layer = Layer.effect(
  VsCodeServer,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* readSettings(config.stateDir);
    return yield* make(systemdLauncher(settings), settings.idleMs);
  }),
);
