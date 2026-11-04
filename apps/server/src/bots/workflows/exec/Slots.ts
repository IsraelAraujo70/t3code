// @effect-diagnostics nodeBuiltinImport:off - starts holder units and reads their receipts.
/**
 * Slots for agent turns. A command takes its slot inside its own unit (wfUnit), but a turn is not
 * a process of the engine, so a holder unit (`wfSlot.ts` under `systemd-run --user`) keeps the
 * flock while the turn runs. The unit outlives a server restart, so a turn that keeps running
 * keeps its slot; it is named after the run and the intent, so a replay adopts it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { Options as UnitOptions } from "./Units.ts";

export class WorkflowSlotError extends Data.TaggedError("WorkflowSlotError")<{
  readonly message: string;
}> {}

export interface SlotHold {
  /** `wf-slot-<32 hex>`, a pure function of the run and the intent key. */
  readonly unit: string;
  /** Where the holder writes `held.json`. */
  readonly receiptDir: string;
  readonly resource: string;
  readonly slots: number;
  /** The slot the turn recorded: the holder waits for exactly that one. */
  readonly slot?: number | undefined;
  /** The holder's runtime cap: a slot nobody releases is freed by then. */
  readonly maxSec: number;
}

export class WorkflowSlots extends Context.Service<
  WorkflowSlots,
  {
    /**
     * Adopts the holder unit when it is live, else starts it, and waits until it holds a slot;
     * interrupting the wait stops the unit.
     */
    readonly acquire: (hold: SlotHold) => Effect.Effect<number, WorkflowSlotError>;
    /** Stops the holder unit, which frees its slot; a unit already gone is fine. */
    readonly release: (unit: string) => Effect.Effect<void, WorkflowSlotError>;
  }
>()("t3/bots/workflows/exec/Slots/WorkflowSlots") {}

export interface SlotsOptions {
  readonly node: string;
  readonly wfSlotPath: string;
  /** Where `<resource>-<i>.lock` live, shared with wfUnit and manual `flock` sessions. */
  readonly slotsDir: string;
  readonly run: UnitOptions["run"];
}

/** `systemctl is-active` states in which the holder may still hold or take a slot. */
const LIVE_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);

const decodeHeld = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ slot: Schema.Number })),
);

/** Creates the slot holder implementation with an injectable command runner. */
export const make = (options: SlotsOptions): WorkflowSlots["Service"] => {
  const active = (unit: string) =>
    options
      .run("systemctl", ["--user", "is-active", unit])
      .pipe(Effect.map((result) => LIVE_STATES.has(result.stdout.trim())));
  const release = Effect.fn("WorkflowSlots.release")(function* (unit: string) {
    const result = yield* options.run("systemctl", ["--user", "stop", unit]);
    // Exit 5: the unit is not loaded, already stopped and collected.
    if (result.exitCode !== 0 && result.exitCode !== 5)
      return yield* new WorkflowSlotError({ message: result.stderr || result.stdout });
  });
  const held = (receiptDir: string) =>
    Effect.try({
      try: () => {
        const path = NodePath.join(receiptDir, "held.json");
        return NodeFS.existsSync(path) ? decodeHeld(NodeFS.readFileSync(path, "utf8")).slot : null;
      },
      catch: (error) => new WorkflowSlotError({ message: String(error) }),
    });
  const start = Effect.fn("WorkflowSlots.start")(function* (hold: SlotHold) {
    if (yield* active(hold.unit)) return;
    // A receipt without a live unit is a slot that is no longer held.
    yield* Effect.sync(() => {
      NodeFS.rmSync(NodePath.join(hold.receiptDir, "held.json"), { force: true });
      NodeFS.mkdirSync(hold.receiptDir, { recursive: true });
    });
    const result = yield* options.run("systemd-run", [
      "--user",
      `--unit=${hold.unit}`,
      "--collect",
      "--quiet",
      "-p",
      `RuntimeMaxSec=${hold.maxSec}`,
      "--",
      options.node,
      options.wfSlotPath,
      "--slot-dir",
      options.slotsDir,
      "--resource",
      hold.resource,
      "--slots",
      String(hold.slots),
      ...(hold.slot === undefined ? [] : ["--slot", String(hold.slot)]),
      "--receipt",
      hold.receiptDir,
    ]);
    if (result.exitCode !== 0 && !(yield* active(hold.unit)))
      return yield* new WorkflowSlotError({ message: result.stderr || result.stdout });
  });
  return {
    acquire: Effect.fn("WorkflowSlots.acquire")(function* (hold) {
      yield* start(hold);
      // held.json is read every second; systemd is asked every ten, since a wait can be long.
      return yield* Effect.gen(function* () {
        for (let tick = 1; ; tick++) {
          const slot = yield* held(hold.receiptDir);
          if (slot !== null) return slot;
          if (
            tick % 10 === 0 &&
            !(yield* active(hold.unit)) &&
            (yield* held(hold.receiptDir)) === null
          )
            return yield* new WorkflowSlotError({
              message: `the slot holder ${hold.unit} stopped before it held a slot`,
            });
          yield* Effect.sleep("1 second");
        }
      }).pipe(Effect.onInterrupt(() => release(hold.unit).pipe(Effect.ignore)));
    }),
    release,
  };
};

/** Provides slot holder units backed by the supplied runner. */
export const layer = (options: SlotsOptions) => Layer.succeed(WorkflowSlots, make(options));
