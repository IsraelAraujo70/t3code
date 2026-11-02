/**
 * Seed only a copied database: node scripts/friend/wf/seed-step-thread.ts --base-dir <dir> [--port <n>].
 * First: mkdir -p <dir>/userdata && sqlite3 /home/israel/.cache/t3-testdata/statev2.sqlite "VACUUM INTO '<dir>/userdata/statev2.sqlite'"
 * If needed: cp /home/israel/.cache/t3-testdata/settings.json <dir>/userdata/
 * Never points a server at the live install. No provider turn is requested.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ShellSnapshot,
  ThreadId,
  WsRpcGroup,
  workflowStepThreadId,
  isListedThreadLineage,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const freePort = () =>
  Effect.callback<number>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        resume(Effect.succeed(typeof address === "object" && address ? address.port : 0)),
      );
    });
  });

const waitForPort = Effect.fn("environment.waitForPort")(function* (port: number) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const open = yield* Effect.callback<boolean>((resume) => {
      const socket = NodeNet.connect(port, "127.0.0.1");
      socket.once("connect", () => (socket.destroy(), resume(Effect.succeed(true))));
      socket.once("error", () => resume(Effect.succeed(false)));
    });
    if (open) return;
    yield* Effect.sleep("500 millis");
  }
  return yield* new Error(`The server never listened on ${port}.`);
});

/** Runs a server CLI command and returns both output streams. */
const runCli = (args: ReadonlyArray<string>) =>
  Effect.try({
    try: () => {
      const result = NodeChildProcess.spawnSync("node", ["apps/server/src/bin.ts", ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return { stdout: result.stdout, stderr: result.stderr };
    },
    catch: (cause) => new Error(`CLI failed: ${cause}`),
  });

const { values } = NodeUtil.parseArgs({
  options: { "base-dir": { type: "string" }, port: { type: "string" } },
});
if (!values["base-dir"]) throw new Error("Required: --base-dir <dir>");
const baseDir = NodePath.resolve(values["base-dir"]);
const live = NodeFS.realpathSync(NodePath.join(NodeOS.homedir(), ".t3"));
const resolved = NodeFS.existsSync(baseDir) ? NodeFS.realpathSync(baseDir) : baseDir;
if (resolved === live || resolved.startsWith(`${live}/`))
  throw new Error("Refusing base dir under ~/.t3 (live install).");
if (!NodeFS.existsSync(NodePath.join(baseDir, "userdata/statev2.sqlite")))
  throw new Error(
    `Missing copied database. Run: mkdir -p '${baseDir}/userdata' && sqlite3 /home/israel/.cache/t3-testdata/statev2.sqlite "VACUUM INTO '${baseDir}/userdata/statev2.sqlite'"`,
  );
const main = Effect.fn("seedStepThread.main")(function* () {
  const port = values.port === undefined ? yield* freePort() : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const home = NodePath.join(baseDir, "seed-home");
  NodeFS.mkdirSync(home, { recursive: true });
  const log = NodeFS.openSync(NodePath.join(baseDir, "seed-server.log"), "w");
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        "node",
        [
          "apps/server/src/bin.ts",
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--base-dir",
          baseDir,
          "--no-browser",
        ],
        { cwd: REPO_ROOT, stdio: ["ignore", log, log], env: { ...process.env, HOME: home } },
      ),
    ),
    (child) =>
      Effect.promise(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGTERM");
          await exited;
        }
        NodeFS.closeSync(log);
        console.log(`Stopped server on port ${port}`);
      }),
  );
  yield* waitForPort(port);
  const origin = `http://127.0.0.1:${port}`;
  const issued = yield* runCli(["auth", "session", "issue", "--base-dir", baseDir, "--token-only"]);
  // The token is the last line of stdout; stderr is only a fallback.
  const lastLine = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.trim())
      .at(-1)
      ?.trim();
  const token = lastLine(issued.stdout) ?? lastLine(issued.stderr) ?? "";
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader(
          ORCHESTRATION_PROTOCOL_HEADER,
          String(ORCHESTRATION_PROTOCOL_VERSION),
        ),
      ),
    ),
    HttpClient.filterStatusOk,
  );
  const descriptor = yield* http
    .get(`${origin}/.well-known/t3/environment`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)));
  const shell = () =>
    http
      .get(`${origin}/api/orchestration/shell`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(OrchestrationV2ShellSnapshot)));
  const ticket = yield* http
    .execute(HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`))
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String }))),
    );
  // Built into the caller's scope: `Effect.provide` would close the socket once `make` returns.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(NodeSocket.layerWebSocketConstructorWS),
    ),
  );
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  const environmentId = EnvironmentId.make(descriptor.environmentId);

  const snapshot = yield* shell();
  const project = [...snapshot.projects]
    .filter((p) => p.archivedAt === null)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (!project) throw new Error("No non-archived project in copied database");
  const config = yield* client["server.getConfig"]({});
  const provider = config.providers.find((p) => p.enabled && p.models.length > 0);
  if (!provider)
    throw new Error(
      "No enabled provider with a model in copied server config; copy settings.json first.",
    );
  const model = provider.models[0]!;
  const stamp = NodeCrypto.randomBytes(8).toString("hex");
  const control = ThreadId.make(NodeCrypto.randomUUID());
  const step = workflowStepThreadId(
    `wfr_${NodeCrypto.randomBytes(10).toString("hex")}`,
    NodeCrypto.randomBytes(16).toString("hex"),
  );
  let failed = false;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
    failed ||= !ok;
  };
  for (const [id, kind] of [
    [control, "control"],
    [step, "step"],
  ] as const) {
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: id,
      projectId: project.id,
      title: `wf-hide ${kind} ${stamp}`,
      modelSelection: { instanceId: provider.instanceId, model: model.slug },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    });
    const projection = yield* client["orchestration.getThreadProjection"]({ threadId: id });
    check(projection.thread.id === id, `${kind} direct projection exists`);
    check(
      projection.runs.length === 0 &&
        projection.providerThreads.every((p) => p.providerSessionId === null),
      `${kind} idle, no provider session started`,
    );
  }
  // Neither thread has messages, so server search has nothing to match; ThreadSearch.test.ts
  // covers it, and the sidebar matches active titles over the listed rows checked below.
  const after = yield* shell();
  const stepShell = after.threads.find((t) => t.id === step);
  const controlShell = after.threads.find((t) => t.id === control);
  check(stepShell !== undefined, "shell carries step");
  check(
    stepShell !== undefined && !isListedThreadLineage(stepShell.lineage),
    "step lineage is unlisted",
  );
  check(
    controlShell !== undefined && isListedThreadLineage(controlShell.lineage),
    "control lineage is listed",
  );
  console.log(
    `Environment: ${environmentId}\nControl: ${control}\nStep: ${step}\nDirect path: /${environmentId}/${encodeURIComponent(step)}`,
  );
  console.log(`Next: T3CODE_DEV_SEED=0 vp run dev --home-dir '${baseDir}'`);
  console.log(
    `Open the direct path. Confirm step is absent from sidebar, sidebar search for ${stamp}, command palette and Settings → Archived; control is listed; direct path opens step.`,
  );
  if (failed) throw new Error("Seed verification failed");
}, Effect.provide(FetchHttpClient.layer));
await Effect.runPromise(Effect.scoped(main()));
