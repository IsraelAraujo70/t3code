// @effect-diagnostics nodeBuiltinImport:off - the fixture is a real CLI stand-in and a real T3 stand-in.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";

import * as VsCodeServer from "./VsCodeServer.ts";

// Stands in for `code serve-web`: answers on --socket-path, and keeps a child of its own on a
// second socket, as serve-web keeps its node server.
const FAKE_CLI = `
const http = require("node:http");
const net = require("node:net");
const childProcess = require("node:child_process");
const args = process.argv.slice(2);
const socket = args[args.indexOf("--socket-path") + 1];
const helper = childProcess.spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1])", socket + ".helper"], { stdio: ["ignore", "ignore", "inherit"] });
http.createServer((request, response) => response.end(JSON.stringify({ url: request.url, args }))).listen(socket);
`;

const withFakeCli = <A, E, R>(
  run: (settings: VsCodeServer.VsCodeSettings) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-vscode-"))),
    (dataDir) => {
      const cli = NodePath.join(dataDir, "code");
      NodeFS.writeFileSync(cli, `#!${process.execPath}\n${FAKE_CLI}`, { mode: 0o755 });
      return run({
        cli,
        dataDir,
        idleMs: 60_000,
        memoryMax: "1G",
        unit: "t3code-vscode-test.service",
      });
    },
    (dataDir) => Effect.sync(() => NodeFS.rmSync(dataDir, { recursive: true, force: true })),
  );

const socketOf = (settings: VsCodeServer.VsCodeSettings) =>
  NodePath.join(settings.dataDir, "run", "t3code-vscode-test.sock");

/** Settles when whatever listens on `path` exits and the kernel closes the connection. */
const connectionClosed = (path: string) =>
  Effect.promise(
    () =>
      new Promise<Effect.Effect<void>>((resolve, reject) => {
        const connection = NodeNet.connect(path);
        const closed = new Promise<void>((settle) => connection.once("close", () => settle()));
        connection.once("error", reject);
        connection.once("connect", () => resolve(Effect.promise(() => closed)));
      }),
  );

it.live(
  "runs serve-web as a direct child that answers on the socket and leaves nothing behind",
  () =>
    withFakeCli((settings) =>
      Effect.gen(function* () {
        const launcher = VsCodeServer.directLauncher(settings);
        const upstream = yield* launcher.launch;
        const response = yield* upstream.http.execute(
          HttpClientRequest.get(`${VsCodeServer.UPSTREAM_ORIGIN}/vscode/`),
        );
        const body = (yield* response.json) as { url: string; args: ReadonlyArray<string> };
        expect(body.url).toBe("/vscode/");
        expect(body.args).toEqual(expect.arrayContaining(["--server-base-path", "/vscode"]));
        expect(NodeFS.statSync(NodePath.dirname(socketOf(settings))).mode & 0o777).toBe(0o700);

        const serveWebGone = yield* connectionClosed(socketOf(settings));
        const helperGone = yield* connectionClosed(`${socketOf(settings)}.helper`);
        yield* launcher.stop;
        yield* serveWebGone;
        yield* helperGone;
        expect(NodeFS.existsSync(socketOf(settings))).toBe(false);
      }).pipe(Effect.scoped),
    ),
);

it.live("serve-web dies with a T3 server that is killed outright", () =>
  withFakeCli((settings) =>
    Effect.gen(function* () {
      const standIn = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import * as Effect from "effect/Effect";
           import { directLauncher } from ${JSON.stringify(NodePath.join(import.meta.dirname, "VsCodeServer.ts"))};
           await Effect.runPromise(directLauncher(${JSON.stringify(settings)}).launch);
           process.stdout.write("ready\\n");
           setInterval(() => {}, 1 << 30);`,
        ],
        {
          cwd: NodePath.resolve(import.meta.dirname, "../../.."),
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      // The stand-in's logs share stdout, so wait for its own line.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            let output = "";
            standIn.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString();
              if (output.includes("ready\n")) resolve();
            });
          }),
      );
      const serveWebGone = yield* connectionClosed(socketOf(settings));
      const helperGone = yield* connectionClosed(`${socketOf(settings)}.helper`);
      standIn.kill("SIGKILL");
      yield* serveWebGone;
      yield* helperGone;
    }),
  ),
);
