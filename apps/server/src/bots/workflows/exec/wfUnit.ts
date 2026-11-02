// @effect-diagnostics nodeBuiltinImport:off - runs alone inside a systemd unit.
// @effect-diagnostics globalDate:off globalTimers:off - standalone Node process has no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const option = (name: string) => args[args.indexOf(name) + 1]!;
const receipt = option("--receipt");
/** After the command exits, how long its output may still drain before leftovers are killed. */
const drainMs = args.includes("--drain-ms") ? Number(option("--drain-ms")) : 2000;
const startedAt = new Date().toISOString();
NodeFS.mkdirSync(receipt, { recursive: true });
const fd = NodeFS.openSync(NodePath.join(receipt, "started.json"), "w");
try {
  NodeFS.writeSync(fd, JSON.stringify({ pid: process.pid, at: startedAt }));
  NodeFS.fsyncSync(fd);
} finally {
  NodeFS.closeSync(fd);
}
const argv = args.slice(separator + 1);
// Its own process group: a shell or package manager leaves descendants that hold stdout open.
const child = NodeChildProcess.spawn(argv[0]!, argv.slice(1), {
  cwd: option("--cwd"),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const killGroup = (signal: NodeJS.Signals) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
};
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
child.stdout.on("data", (data: Buffer) => {
  stdout = Buffer.concat([stdout, data]).subarray(-65536);
});
child.stderr.on("data", (data: Buffer) => {
  stderr = Buffer.concat([stderr, data]).subarray(-8192);
});
let timedOut = false;
let killTimer: ReturnType<typeof setTimeout> | undefined;
let drainTimer: ReturnType<typeof setTimeout> | undefined;
const timer = setTimeout(
  () => {
    timedOut = true;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 10000);
  },
  Number(option("--timeout-ms")),
);
process.on("SIGTERM", () => killGroup("SIGTERM"));
let spawnError: Error | undefined;
child.on("error", (error) => {
  spawnError = error;
});

let finished = false;
const finish = (code: number | null, signal: NodeJS.Signals | null) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  clearTimeout(killTimer);
  clearTimeout(drainTimer);
  killGroup("SIGKILL");
  let out: unknown = null;
  let parseError: string | null = null;
  const parse = option("--parse");
  if (parse !== "none") {
    try {
      const text = stdout.toString().trim();
      out = JSON.parse(
        parse === "json-last-line"
          ? text
              .split("\n")
              .filter((line) => line.trim())
              .at(-1)!
          : text,
      );
    } catch (error) {
      parseError = String(error);
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(receipt, "exit.json.tmp"),
    JSON.stringify({
      exit: spawnError ? 127 : code,
      signal: timedOut ? "TIMEOUT" : signal,
      startedAt,
      endedAt: new Date().toISOString(),
      out,
      parseError,
      tail: stdout.subarray(-8192).toString(),
      stderrTail: spawnError ? String(spawnError) : stderr.toString(),
    }),
  );
  NodeFS.renameSync(NodePath.join(receipt, "exit.json.tmp"), NodePath.join(receipt, "exit.json"));
  process.exit(0);
};
child.on("exit", (code, signal) => {
  // The command ended in time; draining its output must not turn that into a timeout.
  clearTimeout(timer);
  drainTimer = setTimeout(() => finish(code, signal), drainMs);
});
child.on("close", finish);
