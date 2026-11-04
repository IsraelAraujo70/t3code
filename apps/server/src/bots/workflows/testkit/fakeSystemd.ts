// @effect-diagnostics nodeBuiltinImport:off - runs the real unit programs as plain processes.
/**
 * `systemd-run --user`, `systemctl is-active` and `systemctl stop` for tests: each unit is a plain
 * child process keyed by its name. Units live in this object, not in an interpreter, so they
 * outlive a simulated server restart the way user units do.
 */
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

import type { Options } from "../exec/Units.ts";

const ok = { exitCode: 0, stdout: "", stderr: "" };

const exited = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

/** A fake user systemd; dispose it to stop every unit it still runs. */
export const fakeSystemd = () => {
  const units = new Map<string, NodeChildProcess.ChildProcess>();
  const waiters = new Map<string, Array<() => void>>();
  const alive = (unit: string) => {
    const child = units.get(unit);
    return child !== undefined && child.exitCode === null && child.signalCode === null;
  };
  const stop = async (unit: string, signal: NodeJS.Signals = "SIGTERM") => {
    const child = units.get(unit);
    if (child === undefined) return false;
    child.kill(signal);
    await exited(child);
    units.delete(unit);
    return true;
  };
  const run: Options["run"] = (command, args) =>
    Effect.promise(async () => {
      if (command === "systemd-run") {
        const unit = args.find((arg) => arg.startsWith("--unit="))!.slice("--unit=".length);
        const argv = args.slice(args.indexOf("--") + 1);
        units.set(unit, NodeChildProcess.spawn(argv[0]!, argv.slice(1), { stdio: "ignore" }));
        for (const wake of waiters.get(unit) ?? []) wake();
        waiters.delete(unit);
        return ok;
      }
      const unit = args[2]!;
      if (args[1] === "is-active")
        return alive(unit)
          ? { exitCode: 0, stdout: "active\n", stderr: "" }
          : { exitCode: 3, stdout: "inactive\n", stderr: "" };
      return (await stop(unit)) ? ok : { exitCode: 5, stdout: "", stderr: "not loaded" };
    });
  return {
    run,
    /** Unit names, in start order, of units still running. */
    live: () => [...units.keys()].filter(alive),
    /** Resolves once a unit of this name was started. */
    started: (unit: string) =>
      new Promise<void>((resolve) => {
        if (units.has(unit)) return resolve();
        waiters.set(unit, [...(waiters.get(unit) ?? []), resolve]);
      }),
    /** Kills a unit's process from outside, as the OOM killer or a reboot would. */
    kill: (unit: string) => stop(unit, "SIGKILL"),
    [Symbol.asyncDispose]: async () => {
      await Promise.all([...units.keys()].map((unit) => stop(unit)));
    },
  };
};
