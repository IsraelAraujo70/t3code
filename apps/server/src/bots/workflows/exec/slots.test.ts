// @effect-diagnostics nodeBuiltinImport:off - real flock files and processes in a temporary directory.
/**
 * Resource slots with real flock and real processes: wfUnit (the command inside a unit) and
 * wfSlot (the holder unit of an agent turn), both run without systemd. Every lock lives in a temporary
 * directory, never in ~/.cache/t3-testdata/slots.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import { fakeSystemd } from "../testkit/fakeSystemd.ts";
import { make } from "./Slots.ts";
import { slotFile, tryLock } from "./slotLock.ts";

const WF_UNIT = NodePath.join(import.meta.dirname, "wfUnit.ts");
const WF_SLOT = NodePath.join(import.meta.dirname, "wfSlot.ts");

const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-slots-"));
  return { dir, [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
};

/** A script the commands run: written to the temporary directory, run with node. */
const script = (dir: string, name: string, source: string) => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, source);
  return path;
};

const exited = (child: NodeChildProcess.ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });

/** Runs wfUnit like a unit does, without systemd; resolves with its exit receipt. */
const runUnit = async (input: {
  readonly receipt: string;
  readonly slotsDir: string;
  readonly resource: string;
  readonly slots: number;
  readonly argv: ReadonlyArray<string>;
  readonly timeoutMs?: number;
}) => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      WF_UNIT,
      "--receipt",
      input.receipt,
      "--cwd",
      NodePath.dirname(input.receipt),
      "--parse",
      "none",
      "--timeout-ms",
      String(input.timeoutMs ?? 60_000),
      "--drain-ms",
      "50",
      "--slot-dir",
      input.slotsDir,
      "--resource",
      input.resource,
      "--slots",
      String(input.slots),
      "--",
      ...input.argv,
    ],
    { stdio: "ignore" },
  );
  expect(await exited(child)).toBe(0);
  const read = (name: string) =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(input.receipt, name), "utf8")) as {
      readonly exit?: number | null;
      readonly signal?: string | null;
      readonly slot?: number;
    };
  return { started: read("started.json"), exit: read("exit.json") };
};

/** Every slot of `resource` is free: this process can lock each one (and lets go at once). */
const allFree = (dir: string, resource: string, slots: number) =>
  Array.from({ length: slots }, (_, slot) => {
    const fd = tryLock(slotFile(dir, resource, slot));
    if (fd !== null) NodeFS.closeSync(fd);
    return fd !== null;
  }).every(Boolean);

it.live("four commands on two slots never run more than two at a time, and all of them run", () =>
  Effect.promise(async () => {
    using tmp = tempDir();
    const active = NodePath.join(tmp.dir, "active");
    NodeFS.mkdirSync(active);
    const counts = NodePath.join(tmp.dir, "counts.log");
    // The counter: the commands inside the resource right now, logged as each one enters.
    const work = script(
      tmp.dir,
      "work.mjs",
      `import * as fs from "node:fs";
const [active, counts, id] = process.argv.slice(2);
fs.writeFileSync(active + "/" + id, "");
fs.writeFileSync(active + "/../slot-" + id, process.env.WF_SLOT ?? "none");
fs.appendFileSync(counts, fs.readdirSync(active).length + "\\n");
setTimeout(() => fs.rmSync(active + "/" + id), 400);
`,
    );
    const slotsDir = NodePath.join(tmp.dir, "slots");
    const runs = await Promise.all(
      [0, 1, 2, 3].map((id) =>
        runUnit({
          receipt: NodePath.join(tmp.dir, `unit-${id}`),
          slotsDir,
          resource: "moneria-verify",
          slots: 2,
          argv: [process.execPath, work, active, counts, String(id)],
        }),
      ),
    );
    const seen = NodeFS.readFileSync(counts, "utf8").trim().split("\n").map(Number);
    expect(seen).toHaveLength(4);
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
    expect(runs.map((run) => run.exit.exit)).toEqual([0, 0, 0, 0]);
    expect(runs.every((run) => run.started.slot === 0 || run.started.slot === 1)).toBe(true);
    // Each command learns its slot as WF_SLOT, the one its start receipt records.
    expect(
      [0, 1, 2, 3].map((id) => NodeFS.readFileSync(NodePath.join(tmp.dir, `slot-${id}`), "utf8")),
    ).toEqual(runs.map((run) => String(run.started.slot)));
    expect(allFree(slotsDir, "moneria-verify", 2)).toBe(true);
  }),
);

it.live("a command that fails or times out gives its slot back", () =>
  Effect.promise(async () => {
    using tmp = tempDir();
    const slotsDir = NodePath.join(tmp.dir, "slots");
    const failed = await runUnit({
      receipt: NodePath.join(tmp.dir, "failed"),
      slotsDir,
      resource: "r",
      slots: 1,
      argv: [process.execPath, "-e", "process.exit(3)"],
    });
    expect(failed.exit.exit).toBe(3);
    expect(allFree(slotsDir, "r", 1)).toBe(true);
    const timedOut = await runUnit({
      receipt: NodePath.join(tmp.dir, "timed-out"),
      slotsDir,
      resource: "r",
      slots: 1,
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 200,
    });
    expect(timedOut.exit.signal).toBe("TIMEOUT");
    expect(allFree(slotsDir, "r", 1)).toBe(true);
  }),
);

it.live("a manual flock on the slot file holds the engine's command until it lets go", () =>
  Effect.promise(async () => {
    using tmp = tempDir();
    const slotsDir = NodePath.join(tmp.dir, "slots");
    NodeFS.mkdirSync(slotsDir);
    const log = NodePath.join(tmp.dir, "order.log");
    // A manual session: `flock <slot file> <command>`, holding the slot for a while after it says so.
    const manual = NodeChildProcess.spawn(
      "flock",
      [
        slotFile(slotsDir, "r", 0),
        process.execPath,
        script(
          tmp.dir,
          "manual.mjs",
          `import * as fs from "node:fs";
fs.appendFileSync(process.argv[2], "manual start\\n");
console.log("held");
setTimeout(() => fs.appendFileSync(process.argv[2], "manual end\\n"), 1500);
`,
        ),
        log,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => manual.stdout.once("data", () => resolve()));
    const engine = await runUnit({
      receipt: NodePath.join(tmp.dir, "engine"),
      slotsDir,
      resource: "r",
      slots: 1,
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(log)}, "engine start\\n")`,
      ],
    });
    await exited(manual);
    expect(engine.exit.exit).toBe(0);
    expect(NodeFS.readFileSync(log, "utf8")).toBe("manual start\nmanual end\nengine start\n");
  }),
);

/** A fake user systemd for the test's scope; its units stop when the test ends. */
const systemdUnits = Effect.acquireDisposable(Effect.sync(fakeSystemd));

/** A holder unit's hold for slot tests: unit and receipts named after `name`. */
const holdOf = (dir: string, name: string, slots: number, slot?: number) => ({
  unit: `wf-slot-${name}`,
  receiptDir: NodePath.join(dir, "receipts", name),
  resource: "r",
  slots,
  slot,
  maxSec: 3600,
});

it.live("a holder unit that is stopped or killed frees its slot", () =>
  Effect.gen(function* () {
    using tmp = tempDir();
    const systemd = yield* systemdUnits;
    const slots = make({
      node: process.execPath,
      wfSlotPath: WF_SLOT,
      slotsDir: tmp.dir,
      run: systemd.run,
    });
    expect(yield* slots.acquire(holdOf(tmp.dir, "a", 1))).toBe(0);
    expect(allFree(tmp.dir, "r", 1)).toBe(false);
    yield* slots.release("wf-slot-a");
    expect(allFree(tmp.dir, "r", 1)).toBe(true);
    expect(yield* slots.acquire(holdOf(tmp.dir, "b", 1))).toBe(0);
    yield* Effect.promise(() => systemd.kill("wf-slot-b"));
    expect(allFree(tmp.dir, "r", 1)).toBe(true);
  }).pipe(Effect.scoped),
);

it.live("a holder that is stopping is not adopted, so its slot is not reported held", () =>
  Effect.gen(function* () {
    using tmp = tempDir();
    const hold = holdOf(tmp.dir, "a", 1);
    NodeFS.mkdirSync(hold.receiptDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(hold.receiptDir, "held.json"), JSON.stringify({ slot: 0 }));
    const slots = make({
      node: process.execPath,
      wfSlotPath: WF_SLOT,
      slotsDir: tmp.dir,
      // The old holder is deactivating; a new one cannot start under its name yet.
      run: (command) =>
        Effect.succeed(
          command === "systemd-run"
            ? { exitCode: 1, stdout: "", stderr: "Unit wf-slot-a.service already exists." }
            : { exitCode: 0, stdout: "deactivating\n", stderr: "" },
        ),
    });
    const error = yield* Effect.flip(slots.acquire(hold));
    expect(error.message).toContain("already exists");
  }),
);

it.live("an agent's slot waits while both are taken, and a cancelled wait takes none", () =>
  Effect.gen(function* () {
    using tmp = tempDir();
    const systemd = yield* systemdUnits;
    const slots = make({
      node: process.execPath,
      wfSlotPath: WF_SLOT,
      slotsDir: tmp.dir,
      run: systemd.run,
    });
    const first = yield* slots.acquire(holdOf(tmp.dir, "a", 2));
    const second = yield* slots.acquire(holdOf(tmp.dir, "b", 2));
    expect([first, second].sort()).toEqual([0, 1]);
    // Adopting a live holder returns the slot it holds, without a second unit.
    expect(yield* slots.acquire(holdOf(tmp.dir, "a", 2))).toBe(first);
    const waiting = yield* Effect.forkChild(slots.acquire(holdOf(tmp.dir, "c", 2)));
    yield* slots.release("wf-slot-a");
    expect(yield* Fiber.join(waiting)).toBe(first);

    const cancelled = yield* Effect.forkChild(slots.acquire(holdOf(tmp.dir, "d", 2)));
    yield* Fiber.interrupt(cancelled);
    expect(systemd.live()).toEqual(["wf-slot-b", "wf-slot-c"]);
    yield* slots.release("wf-slot-b");
    yield* slots.release("wf-slot-c");
    expect(allFree(tmp.dir, "r", 2)).toBe(true);
  }).pipe(Effect.scoped),
);

it.live("a recorded slot a manual session holds goes back to its turn, never to another step", () =>
  Effect.gen(function* () {
    using tmp = tempDir();
    const systemd = yield* systemdUnits;
    const slots = make({
      node: process.execPath,
      wfSlotPath: WF_SLOT,
      slotsDir: tmp.dir,
      run: systemd.run,
    });
    const manual = NodeChildProcess.spawn(
      "flock",
      [
        slotFile(tmp.dir, "r", 0),
        process.execPath,
        "-e",
        'console.log("held"); setTimeout(() => {}, 1500)',
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    yield* Effect.promise(
      () => new Promise<void>((resolve) => manual.stdout.once("data", () => resolve())),
    );
    // A new step waits for any free slot; the turn waits for slot 0, the one it recorded.
    const other = yield* Effect.forkChild(slots.acquire(holdOf(tmp.dir, "other", 1)));
    const recorded = yield* slots.acquire(holdOf(tmp.dir, "turn", 1, 0));
    expect(recorded).toBe(0);
    yield* slots.release("wf-slot-turn");
    expect(yield* Fiber.join(other)).toBe(0);
    yield* slots.release("wf-slot-other");
  }).pipe(Effect.scoped),
);
