// @effect-diagnostics nodeBuiltinImport:off - spawns the holder process that keeps a slot's flock.
/**
 * Slots for agent turns. A command takes its slot inside its own unit (wfUnit), but a turn is not
 * a process of the engine, so a holder child of the server (`wfSlot.ts`) keeps the flock while the
 * turn runs. The holder exits when it is released, when its stdin closes because the server died,
 * or when anything kills it; the kernel drops the flock with it, so no restart leaves a slot taken.
 */
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class WorkflowSlotError extends Data.TaggedError("WorkflowSlotError")<{
  readonly message: string;
}> {}

export interface SlotLease {
  readonly slot: number;
  /** Ends the holder and waits until it exited, so the slot is free; releasing twice is fine. */
  readonly release: Effect.Effect<void>;
}

export class WorkflowSlots extends Context.Service<
  WorkflowSlots,
  {
    /** Waits for a free slot of `resource`; interrupting the wait ends the holder and waits for it. */
    readonly acquire: (input: {
      readonly resource: string;
      readonly slots: number;
    }) => Effect.Effect<SlotLease, WorkflowSlotError>;
  }
>()("t3/bots/workflows/exec/Slots/WorkflowSlots") {}

export interface SlotsOptions {
  readonly node: string;
  readonly wfSlotPath: string;
  /** Where `<resource>-<i>.lock` live, shared with wfUnit and manual `flock` sessions. */
  readonly slotsDir: string;
}

/** Creates the slot holder implementation. */
export const make = (options: SlotsOptions): WorkflowSlots["Service"] => ({
  acquire: (input) =>
    Effect.callback<SlotLease, WorkflowSlotError>((resume) => {
      const child = NodeChildProcess.spawn(
        options.node,
        [
          options.wfSlotPath,
          "--slot-dir",
          options.slotsDir,
          "--resource",
          input.resource,
          "--slots",
          String(input.slots),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const end = Effect.callback<void>((exited) => {
        if (child.exitCode !== null || child.signalCode !== null) return exited(Effect.void);
        child.once("exit", () => exited(Effect.void));
        child.stdin.end();
        child.kill("SIGTERM");
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-2000);
      });
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        const line = stdout.split("\n")[0];
        if (settled || !stdout.includes("\n") || line === undefined) return;
        settled = true;
        const slot = Number((JSON.parse(line) as { readonly slot: unknown }).slot);
        resume(Effect.succeed({ slot, release: end }));
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        resume(Effect.fail(new WorkflowSlotError({ message: String(error) })));
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        resume(
          Effect.fail(
            new WorkflowSlotError({
              message: `the slot holder exited (${code ?? signal}) before it held a slot: ${stderr}`,
            }),
          ),
        );
      });
      return end;
    }),
});

/** Provides slot holders spawned with the supplied Node and script. */
export const layer = (options: SlotsOptions) => Layer.succeed(WorkflowSlots, make(options));
