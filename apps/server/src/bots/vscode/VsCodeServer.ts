// @effect-diagnostics nodeBuiltinImport:off - serve-web runs as a systemd unit or a child process; undici reaches the unix socket.
/**
 * One `code serve-web` per T3 server, started on demand and stopped when idle: a capped transient
 * systemd unit where the user manager works, else a child process. It has no connection token,
 * because its client repeats the token inside the socket protocol; a unix socket in a 0700
 * directory keeps other users and web pages out.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as Undici from "undici";

import { VSCODE_BASE_PATH } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../../config.ts";
import { installTheme } from "./VsCodeTheme.ts";

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

/** Starts and stops the serve-web process; injectable so tests need neither systemd nor the CLI. */
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
  /** `T3CODE_VSCODE_CLI` when set; otherwise each start looks the CLI up with `cliCandidates`. */
  readonly cli: string | undefined;
  readonly dataDir: string;
  readonly idleMs: number;
  readonly memoryMax: string;
  readonly unit: string;
}

const defaultCliPath = (home: string) => NodePath.join(home, ".t3-friend", "vscode", "bin", "code");

/** Reads the env once at startup. The unit name follows the T3 state dir, so servers never share one. */
export const readSettings = Effect.fn("VsCodeServer.readSettings")(function* (stateDir: string) {
  const home = NodeOS.homedir();
  const cli = yield* Config.String(VSCODE_CLI_ENV).pipe(Config.option);
  const dataDir = yield* Config.String(VSCODE_DATA_DIR_ENV).pipe(
    Config.withDefault(NodePath.join(home, ".t3-friend", "vscode")),
  );
  const idleMs = yield* Config.Int(VSCODE_IDLE_MS_ENV).pipe(Config.withDefault(DEFAULT_IDLE_MS));
  const memoryMax = yield* Config.String(VSCODE_MEMORY_MAX_ENV).pipe(
    Config.withDefault(DEFAULT_MEMORY_MAX),
  );
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 10);
  return {
    cli: Option.getOrUndefined(cli),
    dataDir,
    idleMs: Math.max(idleMs, 1000),
    memoryMax,
    unit: `t3code-vscode-${hash}.service`,
  } satisfies VsCodeSettings;
});

const MAC_APP_CLI = [
  "Visual Studio Code.app",
  "Contents",
  "Resources",
  "app",
  "bin",
  "code-tunnel",
];

/**
 * Where the CLI is looked for, in order. `T3CODE_VSCODE_CLI` is the only place when set. On macOS
 * the installed app's `code-tunnel` is the same CLI, `serve-web` included.
 */
export const cliCandidates = (
  override: string | undefined,
  home: string,
  platform: NodeJS.Platform,
  pathEnv: string | undefined,
): ReadonlyArray<string> =>
  override !== undefined
    ? [override]
    : [
        defaultCliPath(home),
        ...(platform === "darwin"
          ? ["/Applications", NodePath.join(home, "Applications")].map((dir) =>
              NodePath.join(dir, ...MAC_APP_CLI),
            )
          : []),
        ...(pathEnv ?? "")
          .split(NodePath.delimiter)
          .filter((dir) => dir !== "")
          .map((dir) => NodePath.join(dir, "code")),
      ];

/** The standalone CLI's name on code.visualstudio.com for this machine. */
const cliAsset = (platform: NodeJS.Platform, arch: string) =>
  platform === "darwin"
    ? `cli-darwin-${arch === "arm64" ? "arm64" : "x64"}`
    : arch === "arm64"
      ? "cli-alpine-arm64"
      : arch === "arm"
        ? "cli-linux-armhf"
        : "cli-alpine-x64";

const missingCliMessage = (
  override: string | undefined,
  home: string,
  platform: NodeJS.Platform,
  arch: string,
) =>
  override !== undefined
    ? `The VS Code CLI is not installed at ${override}, where ${VSCODE_CLI_ENV} points.`
    : `No VS Code CLI found. Download the standalone "code" CLI from https://code.visualstudio.com/sha/download?build=stable&os=${cliAsset(platform, arch)} and unpack it to ${defaultCliPath(home)}${platform === "darwin" ? ", install Visual Studio Code in /Applications" : ""}, or point ${VSCODE_CLI_ENV} at one.`;

type RunCommand = (
  command: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<string, VsCodeError>;

const execCommand: RunCommand = (command, args) =>
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

const runPaths = (settings: VsCodeSettings) => {
  const runDir = NodePath.join(settings.dataDir, "run");
  // A unix socket path is capped near 104 bytes on macOS and 108 on Linux, so the name is short.
  const name = settings.unit.replace(/\.service$/, "");
  return {
    runDir,
    socketPath: NodePath.join(runDir, `${name}.sock`),
    logPath: NodePath.join(runDir, `${name}.log`),
  };
};

/** Finds the CLI, readies the socket's 0700 directory and the theme, and returns the serve-web command. */
const prepareLaunch = Effect.fn("VsCodeServer.prepareLaunch")(function* (settings: VsCodeSettings) {
  const home = NodeOS.homedir();
  const platform = yield* HostProcess.Platform;
  const cli = cliCandidates(settings.cli, home, platform, process.env.PATH).find((path) =>
    isExecutable(path),
  );
  if (cli === undefined) {
    return yield* new VsCodeError({
      message: missingCliMessage(settings.cli, home, platform, yield* HostProcess.Architecture),
    });
  }
  const { runDir, socketPath } = runPaths(settings);
  yield* Effect.try({
    try: () => {
      NodeFS.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      NodeFS.chmodSync(runDir, 0o700);
      NodeFS.rmSync(socketPath, { force: true });
    },
    catch: (cause) =>
      new VsCodeError({ message: `Cannot prepare ${runDir} for VS Code's socket: ${cause}` }),
  });
  yield* installTheme(NodePath.join(settings.dataDir, "server", "extensions"));
  return [
    cli,
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
  ] as const;
});

const waitUntilReady = (upstream: VsCodeUpstream, logHint: string) =>
  upstream.http.execute(HttpClientRequest.get(`${UPSTREAM_ORIGIN}${VSCODE_BASE_PATH}/`)).pipe(
    Effect.scoped,
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeout(READY_TIMEOUT),
    Effect.mapError(
      () => new VsCodeError({ message: `VS Code did not answer within 60 seconds. ${logHint}` }),
    ),
    Effect.asVoid,
  );

/** serve-web as a transient `systemd-run --user` unit. */
export const systemdLauncher = (settings: VsCodeSettings): VsCodeLauncher => {
  const { socketPath } = runPaths(settings);
  let closeUpstream: Effect.Effect<void> = Effect.void;

  const stop = Effect.gen(function* () {
    yield* execCommand("systemctl", ["--user", "stop", settings.unit]).pipe(Effect.ignore);
    yield* execCommand("systemctl", ["--user", "reset-failed", settings.unit]).pipe(Effect.ignore);
    yield* closeUpstream;
    closeUpstream = Effect.void;
    yield* Effect.sync(() => NodeFS.rmSync(socketPath, { force: true }));
  });

  const launch = Effect.gen(function* () {
    // A unit left by an earlier server process would hold the socket.
    yield* stop;
    const command = yield* prepareLaunch(settings);
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
      ...command,
    ]);
    const { upstream, close } = yield* unixSocketUpstream(socketPath);
    closeUpstream = close;
    yield* waitUntilReady(upstream, `See journalctl --user -u ${settings.unit}.`).pipe(
      Effect.tapError(() => stop),
    );
    yield* Effect.logInfo("VS Code is running.", { unit: settings.unit });
    return upstream;
  });

  return { launch, stop };
};

// Runs the command in the background, then kills the whole process group once T3's end of stdin
// closes. The kernel closes it whenever T3 exits, so serve-web cannot outlive a crashed T3.
const WATCHDOG = '"$@" </dev/null & read -r _; kill -TERM 0';
const STOP_GRACE = Duration.seconds(5);

// What only T3 or its Electron shell should see, as the T3 terminal leaves out (terminal/Manager.ts).
const CHILD_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);

const childEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const name = key.toUpperCase();
      return (
        !name.startsWith("T3CODE_") && !name.startsWith("VITE_") && !CHILD_ENV_BLOCKLIST.has(name)
      );
    }),
  );

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
};

/**
 * serve-web as a child in its own process group, for machines without a systemd user manager, such
 * as macOS. `nice` stands in for CPUWeight; there is no memory cap. stderr goes to a log file next
 * to the socket, rewritten on each start.
 */
export const directLauncher = (settings: VsCodeSettings): VsCodeLauncher => {
  const { socketPath, logPath } = runPaths(settings);
  let running: { readonly pid: number; readonly closed: Promise<void> } | undefined;
  let closeUpstream: Effect.Effect<void> = Effect.void;

  // `closed` settles once every process that inherited stderr has exited, serve-web's included.
  const stop = Effect.gen(function* () {
    const child = running;
    running = undefined;
    if (child !== undefined) {
      signalGroup(child.pid, "SIGTERM");
      yield* Effect.promise(() => child.closed).pipe(Effect.timeoutOption(STOP_GRACE));
      signalGroup(child.pid, "SIGKILL");
    }
    yield* closeUpstream;
    closeUpstream = Effect.void;
    yield* Effect.sync(() => NodeFS.rmSync(socketPath, { force: true }));
  });

  const spawn = (command: ReadonlyArray<string>) =>
    Effect.try({
      try: () => {
        const log = NodeFS.createWriteStream(logPath, { mode: 0o600 });
        log.on("error", () => {});
        const child = NodeChildProcess.spawn(
          "/bin/sh",
          ["-c", WATCHDOG, "sh", "nice", "-n", "10", ...command],
          {
            cwd: NodeOS.homedir(),
            detached: true,
            env: childEnv(process.env),
            stdio: ["pipe", "ignore", "pipe"],
          },
        );
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.once("error", () => resolve());
        });
        child.stderr?.pipe(log);
        if (child.pid === undefined) throw new Error("/bin/sh did not start");
        return { pid: child.pid, closed };
      },
      catch: (cause) => new VsCodeError({ message: `Cannot start VS Code: ${cause}` }),
    });

  const launch = Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") {
      return yield* new VsCodeError({ message: "VS Code in T3 does not run on Windows servers." });
    }
    yield* stop;
    const command = yield* prepareLaunch(settings);
    const child = yield* spawn(command);
    running = child;
    const { upstream, close } = yield* unixSocketUpstream(socketPath);
    closeUpstream = close;
    yield* waitUntilReady(upstream, `See ${logPath}.`).pipe(Effect.tapError(() => stop));
    yield* Effect.logInfo("VS Code is running.", { pid: child.pid, log: logPath });
    return upstream;
  });

  return { launch, stop };
};

/** Whether a systemd user manager can run transient units here: `systemd-run` exists and the manager answers. */
export const canUseSystemd = (run: RunCommand) =>
  Effect.all([
    run("systemd-run", ["--version"]),
    run("systemctl", ["--user", "show", "--property=Version"]),
  ]).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));

/** Uses systemd when it works and a direct child otherwise, decided on the first start. */
export const pickLauncher = (
  systemdWorks: Effect.Effect<boolean>,
  systemd: () => VsCodeLauncher,
  direct: () => VsCodeLauncher,
): VsCodeLauncher => {
  let chosen: VsCodeLauncher | undefined;
  return {
    launch: Effect.gen(function* () {
      if (chosen === undefined) {
        const useSystemd = yield* systemdWorks;
        if (!useSystemd) {
          yield* Effect.logInfo(
            "No systemd user manager; VS Code runs as a child of this server, without a memory cap.",
          );
        }
        chosen = useSystemd ? systemd() : direct();
      }
      return yield* chosen.launch;
    }),
    stop: Effect.suspend(() => chosen?.stop ?? Effect.void),
  };
};

export const layer = Layer.effect(
  VsCodeServer,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* readSettings(config.stateDir);
    const launcher = pickLauncher(
      canUseSystemd(execCommand),
      () => systemdLauncher(settings),
      () => directLauncher(settings),
    );
    return yield* make(launcher, settings.idleMs);
  }),
);
