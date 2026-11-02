// @effect-diagnostics nodeBuiltinImport:off - receipts are files in a temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { make, type UnitStart } from "./Units.ts";

/** A fake systemctl/systemd-run: `state` is what `is-active` prints; `stopExit` what `stop` exits. */
const setup = (state: string, stopExit = 0) => {
  const calls: Array<readonly [string, ReadonlyArray<string>]> = [];
  const units = make({
    node: "node",
    wfUnitPath: "wfUnit.ts",
    heavyLock: "heavy.lock",
    run: (command, args) => {
      calls.push([command, args]);
      if (args[1] === "is-active")
        return Effect.succeed({ exitCode: 3, stdout: `${state}\n`, stderr: "" });
      if (args[1] === "stop")
        return Effect.succeed({ exitCode: stopExit, stdout: "", stderr: "failed" });
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    },
  });
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-units-"));
  const input: UnitStart = {
    unit: "wf-test",
    receiptDir: dir,
    argv: ["cargo", "build"],
    cwd: dir,
    heavy: true,
    timeoutMs: 60_000,
    env: {},
    parse: "none",
  };
  const write = (name: string, value: unknown) =>
    NodeFS.writeFileSync(NodePath.join(dir, name), JSON.stringify(value));
  const spawned = () => calls.filter(([command]) => command === "systemd-run");
  return {
    units,
    calls,
    input,
    write,
    spawned,
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true }),
  };
};

it.effect("adopts a receipt or a live unit instead of starting a second one", () =>
  Effect.gen(function* () {
    using withReceipt = setup("inactive");
    withReceipt.write("started.json", { at: "2026-11-02T00:00:00.000Z" });
    yield* withReceipt.units.start(withReceipt.input);
    expect(withReceipt.spawned()).toEqual([]);

    using stopping = setup("deactivating");
    yield* stopping.units.start(stopping.input);
    expect(stopping.spawned()).toEqual([]);
  }),
);

it.effect("runs a heavy command under the heavy lock without a runtime cap", () =>
  Effect.gen(function* () {
    using fresh = setup("inactive");
    yield* fresh.units.start(fresh.input);
    const args = fresh.spawned()[0]?.[1] ?? [];
    const command = args.slice(args.indexOf("--") + 1);
    expect(command.slice(0, 4)).toEqual(["flock", "heavy.lock", "node", "wfUnit.ts"]);
    expect(command.slice(-3)).toEqual(["--", "cargo", "build"]);
    expect(args).toContain("MemoryMax=6G");
    expect(args).toEqual(expect.arrayContaining(["-E", "CI=1"]));
    expect(args.some((arg) => arg.startsWith("TMPDIR="))).toBe(true);
    expect(args.some((arg) => arg.startsWith("RuntimeMaxSec="))).toBe(false);

    using light = setup("inactive");
    yield* light.units.start({ ...light.input, heavy: false });
    const lightArgs = light.spawned()[0]?.[1] ?? [];
    expect(lightArgs).toContain("RuntimeMaxSec=180");
    expect(lightArgs).not.toContain("flock");
    expect(lightArgs).not.toContain("CI=1");
  }),
);

it.effect("reads the exit receipt, and reports a vanished unit as lost", () =>
  Effect.gen(function* () {
    using done = setup("inactive");
    done.write("started.json", { at: "2026-11-02T00:00:02.000Z" });
    done.write("exit.json", {
      exit: 0,
      signal: null,
      out: { ok: true },
      parseError: null,
      tail: "ok",
    });
    const spawnedAt = Date.parse("2026-11-02T00:00:00.000Z");
    expect(
      yield* done.units.observe({ unit: "wf-test", receiptDir: done.input.receiptDir, spawnedAt }),
    ).toEqual({
      exit: 0,
      signal: null,
      out: { ok: true },
      parseError: null,
      tail: "ok",
      queuedMs: 2000,
      started: true,
      lost: false,
    });

    using begun = setup("inactive");
    begun.write("started.json", { at: "2026-11-02T00:00:00.000Z" });
    const lost = yield* begun.units.observe({
      unit: "wf-test",
      receiptDir: begun.input.receiptDir,
      spawnedAt,
    });
    expect(lost).toMatchObject({ lost: true, started: true });

    using never = setup("failed");
    const notRun = yield* never.units.observe({
      unit: "wf-test",
      receiptDir: never.input.receiptDir,
      spawnedAt,
    });
    expect(notRun).toMatchObject({ lost: true, started: false });
  }),
);

it.effect("stops by name, and a unit already collected counts as stopped", () =>
  Effect.gen(function* () {
    using gone = setup("inactive", 5);
    yield* gone.units.stop("wf-test");
    expect(gone.calls).toEqual([["systemctl", ["--user", "stop", "wf-test"]]]);

    using broken = setup("inactive", 1);
    const error = yield* broken.units.stop("wf-test").pipe(Effect.flip);
    expect(error.message).toBe("failed");
  }),
);

it.effect("asks systemd about a waiting unit every ten seconds, not every second", () =>
  Effect.gen(function* () {
    using waiting = setup("active");
    const observed = yield* waiting.units
      .observe({ unit: "wf-test", receiptDir: waiting.input.receiptDir, spawnedAt: 0 })
      .pipe(Effect.forkScoped);
    for (let second = 0; second < 20; second++) yield* TestClock.adjust("1 second");
    const checks = waiting.calls.filter(([, args]) => args[1] === "is-active").length;
    expect(checks).toBe(3);
    waiting.write("started.json", { at: "1970-01-01T00:00:00.000Z" });
    waiting.write("exit.json", { exit: 0, signal: null, out: null, parseError: null, tail: "" });
    yield* TestClock.adjust("1 second");
    expect((yield* Fiber.join(observed)).exit).toBe(0);
  }),
);
