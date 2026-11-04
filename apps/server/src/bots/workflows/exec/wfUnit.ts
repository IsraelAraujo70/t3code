// @effect-diagnostics nodeBuiltinImport:off - runs alone inside a systemd unit.
// @effect-diagnostics globalDate:off globalTimers:off - standalone Node process has no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { acquireSlot } from "./slotLock.ts";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
// Only wfUnit's own options, before `--`: the command's argv may contain the same words.
const options = args.slice(0, separator);
const option = (name: string) => options[options.indexOf(name) + 1]!;
const receipt = option("--receipt");
/** After the command exits, how long its output may still drain before leftovers are killed. */
const drainMs = options.includes("--drain-ms") ? Number(option("--drain-ms")) : 2000;
const parse = option("--parse");
/** stdout kept: all of a parsed result up to 1 MiB, else the tail the receipt reports. */
const keepBytes = parse === "none" ? 8192 : 1 << 20;
/** The parsed result lands in the journal and in every fold of the run, so it stays small. */
const MAX_OUT_BYTES = 64 * 1024;
NodeFS.mkdirSync(receipt, { recursive: true });
// `uses`: wait for a slot before the start receipt, so the wait counts as queued, not as running.
const slot = options.includes("--resource")
  ? await acquireSlot({
      dir: option("--slot-dir"),
      resource: option("--resource"),
      slots: Number(option("--slots")),
    })
  : undefined;
const startedAt = new Date().toISOString();
const fd = NodeFS.openSync(NodePath.join(receipt, "started.json"), "w");
try {
  NodeFS.writeSync(fd, JSON.stringify({ pid: process.pid, at: startedAt, slot }));
  NodeFS.fsyncSync(fd);
} finally {
  NodeFS.closeSync(fd);
}
const argv = args.slice(separator + 1);
// Its own process group: a shell or package manager leaves descendants that hold stdout open.
const child = NodeChildProcess.spawn(argv[0]!, argv.slice(1), {
  cwd: option("--cwd"),
  // The slot number, for a command that names per-slot state (a compose project, a port range).
  env: slot === undefined ? process.env : { ...process.env, WF_SLOT: String(slot) },
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
  stdout = Buffer.concat([stdout, data]).subarray(-keepBytes);
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
    if (parseError === null && JSON.stringify(out).length > MAX_OUT_BYTES) {
      out = null;
      parseError = `the parsed result is over ${MAX_OUT_BYTES / 1024} KiB; write large results to a file and print its path`;
    }
  }
  const temp = NodeFS.openSync(NodePath.join(receipt, "exit.json.tmp"), "w");
  NodeFS.writeSync(
    temp,
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
  // Durable before it is visible: an empty exit.json after a power loss would never decode.
  NodeFS.fsyncSync(temp);
  NodeFS.closeSync(temp);
  NodeFS.renameSync(NodePath.join(receipt, "exit.json.tmp"), NodePath.join(receipt, "exit.json"));
  process.exit(0);
};
child.on("exit", (code, signal) => {
  // The command ended in time; draining its output must not turn that into a timeout.
  clearTimeout(timer);
  drainTimer = setTimeout(() => finish(code, signal), drainMs);
});
child.on("close", finish);
