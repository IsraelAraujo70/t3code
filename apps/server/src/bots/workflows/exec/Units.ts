// @effect-diagnostics nodeBuiltinImport:off - executes systemd commands and reads unit receipts.
/**
 * Commands of workflow steps, each in its own transient `systemd-run --user` unit that outlives a
 * server restart. The unit runs `wfUnit.ts`, which writes `started.json` (fsync) before the argv
 * and `exit.json` (atomic rename) after it, so a restart adopts the unit or reads its receipt.
 * A heavy command takes the heavy.sh lock inside the same unit, with heavy.sh's limits.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";

export class WorkflowUnitError extends Data.TaggedError("WorkflowUnitError")<{
  readonly message: string;
}> {}

export interface UnitStart {
  /** `wf-<32 hex>`, a pure function of the run and the intent key. */
  readonly unit: string;
  /** Directory of the unit's receipts (`started.json`, `exit.json`). */
  readonly receiptDir: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly heavy: boolean;
  readonly timeoutMs: number;
  readonly env: { readonly [name: string]: string };
  readonly parse: "none" | "json" | "json-last-line";
}

export interface UnitOutcome {
  readonly exit: number | null;
  /** "TIMEOUT" when wfUnit killed the command at its timeout. */
  readonly signal: string | null;
  /** From the unit's start to `started.json`: the heavy lock's wait. */
  readonly queuedMs: number;
  readonly out: Json;
  readonly parseError: string | null;
  /** stdout's last 8 KiB. */
  readonly tail: string;
  /** No exit receipt and the unit is gone. */
  readonly lost: boolean;
  /** `started.json` exists: the argv began. */
  readonly started: boolean;
}

export class WorkflowUnits extends Context.Service<
  WorkflowUnits,
  {
    /**
     * Idempotent per unit name: a receipt or an active unit is adopted; only when neither exists is
     * a new unit created. Returns when the unit exists (or already finished).
     */
    readonly start: (input: UnitStart) => Effect.Effect<void, WorkflowUnitError>;
    /** Waits until the unit's `exit.json` exists, or the unit is gone without one (lost). */
    readonly observe: (input: {
      readonly unit: string;
      readonly receiptDir: string;
      readonly spawnedAt: number;
    }) => Effect.Effect<UnitOutcome, WorkflowUnitError>;
    /** `systemctl --user stop <unit>`; a unit already gone is fine. Never stops by pattern. */
    readonly stop: (unit: string) => Effect.Effect<void, WorkflowUnitError>;
  }
>()("t3/bots/workflows/exec/Units/WorkflowUnits") {}

export interface Options {
  readonly node: string;
  readonly wfUnitPath: string;
  readonly heavyLock: string;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ exitCode: number; stdout: string; stderr: string }>;
}

/** `systemctl is-active` states in which the unit's processes may still run or write receipts. */
const LIVE_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

/** Executes one command without a shell. */
export const defaultRun: Options["run"] = (command, args) =>
  Effect.callback((resume) => {
    NodeChildProcess.execFile(command, [...args], (error, stdout, stderr) => {
      resume(
        Effect.succeed({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        }),
      );
    });
  });

/** Creates the unit lifecycle implementation with an injectable command runner. */
export const make = (options: Options): WorkflowUnits["Service"] => {
  const exists = (dir: string, name: string) => NodeFS.existsSync(NodePath.join(dir, name));
  const receiptExists = (dir: string) => exists(dir, "exit.json") || exists(dir, "started.json");
  const active = (unit: string) =>
    options
      .run("systemctl", ["--user", "is-active", unit])
      .pipe(Effect.map((result) => LIVE_STATES.has(result.stdout.trim())));
  return {
    start: Effect.fn("WorkflowUnits.start")(function* (input) {
      if (receiptExists(input.receiptDir) || (yield* active(input.unit))) return;
      const args = [
        "--user",
        `--unit=${input.unit}`,
        "--collect",
        "--quiet",
        `--working-directory=${input.cwd}`,
      ];
      // wfUnit enforces the timeout; this backstop would also count a heavy unit's wait for the lock.
      if (!input.heavy) args.push("-p", `RuntimeMaxSec=${Math.ceil(input.timeoutMs / 1000) + 120}`);
      if (input.heavy)
        args.push("-p", "CPUWeight=20", "-p", "IOWeight=20", "-p", "MemoryMax=6G", "-p", "Nice=19");
      for (const [name, value] of Object.entries({
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "",
        ...input.env,
      }))
        args.push("-E", `${name}=${value}`);
      args.push("--");
      if (input.heavy) args.push("flock", options.heavyLock);
      args.push(
        options.node,
        options.wfUnitPath,
        "--receipt",
        input.receiptDir,
        "--cwd",
        input.cwd,
        "--parse",
        input.parse,
        "--timeout-ms",
        String(input.timeoutMs),
        "--",
        ...input.argv,
      );
      const result = yield* options.run("systemd-run", args);
      if (result.exitCode !== 0 && !receiptExists(input.receiptDir) && !(yield* active(input.unit)))
        return yield* new WorkflowUnitError({ message: result.stderr || result.stdout });
    }),
    observe: Effect.fn("WorkflowUnits.observe")(function* (input) {
      while (true) {
        if (exists(input.receiptDir, "exit.json")) {
          const result = yield* Effect.try({
            try: () =>
              decodeExit(NodeFS.readFileSync(NodePath.join(input.receiptDir, "exit.json"), "utf8")),
            catch: (error) => new WorkflowUnitError({ message: String(error) }),
          });
          const started = yield* Effect.try({
            try: () =>
              decodeStarted(
                NodeFS.readFileSync(NodePath.join(input.receiptDir, "started.json"), "utf8"),
              ),
            catch: (error) => new WorkflowUnitError({ message: String(error) }),
          });
          return {
            ...result,
            queuedMs: Math.max(0, Date.parse(started.at) - input.spawnedAt),
            started: true,
            lost: false,
          };
        }
        if (!(yield* active(input.unit))) {
          if (exists(input.receiptDir, "exit.json")) continue;
          return {
            exit: null,
            signal: null,
            queuedMs: 0,
            out: null,
            parseError: null,
            tail: "",
            lost: true,
            started: exists(input.receiptDir, "started.json"),
          };
        }
        yield* Effect.sleep("1 second");
      }
    }),
    stop: Effect.fn("WorkflowUnits.stop")(function* (unit) {
      const result = yield* options.run("systemctl", ["--user", "stop", unit]);
      // Exit 5: the unit is not loaded, already finished and collected.
      if (result.exitCode !== 0 && result.exitCode !== 5)
        return yield* new WorkflowUnitError({ message: result.stderr || result.stdout });
    }),
  };
};

/** Provides workflow units backed by the supplied runner. */
export const layer = (options: Options) => Layer.succeed(WorkflowUnits, make(options));

const decodeExit = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      exit: Schema.NullOr(Schema.Number),
      signal: Schema.NullOr(Schema.String),
      out: Schema.Json,
      parseError: Schema.NullOr(Schema.String),
      tail: Schema.String,
    }),
  ),
);

const decodeStarted = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ at: Schema.String })),
);
