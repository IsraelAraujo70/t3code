// @effect-diagnostics nodeBuiltinImport:off - shared by wfUnit and wfSlot, standalone Node processes.
// @effect-diagnostics globalTimers:off - standalone Node process has no Effect runtime.
/**
 * Slots of a resource are flock files, `<dir>/<resource>-<i>.lock`, so a manual
 * `flock <file> <command>` takes the same slot the engine does. A slot belongs to an open file of
 * this process: it is released when the process exits or dies, whatever kills it. A waiter for one
 * recorded slot holds `<resource>-<i>.claim`, which keeps waiters for any free slot off that one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** flock(1)'s exit code when another holder has the lock (`-E`). */
const BUSY = 75;
/** How often a waiter tries again: a flock(1) per slot, so not much faster. */
const POLL_MS = 1000;

/** The lock file of one slot. */
export const slotFile = (dir: string, resource: string, slot: number): string =>
  NodePath.join(dir, `${resource}-${slot}.lock`);
const claimFile = (dir: string, resource: string, slot: number): string =>
  NodePath.join(dir, `${resource}-${slot}.claim`);

/**
 * Locks `path` without waiting, or returns null when another holder has it. Node has no flock, so
 * flock(1) locks our descriptor as its fd 3: the lock is on the shared open file and stays with
 * this process after flock(1) exits.
 */
export const tryLock = (path: string): number | null => {
  const fd = NodeFS.openSync(path, "a");
  const result = NodeChildProcess.spawnSync("flock", ["-n", "-E", String(BUSY), "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  if (result.status === 0) return fd;
  NodeFS.closeSync(fd);
  if (result.status === BUSY) return null;
  throw new Error(`flock ${path} failed: ${String(result.error ?? result.stderr)}`);
};

const pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));

/**
 * Takes a slot and returns its number; this process holds it until it exits. Without `slot`, the
 * first free slot nobody claimed, trying again every second while none is. With `slot`, exactly
 * that one: its claim is held while waiting, so no waiter for a free slot gets it in between.
 */
export const acquireSlot = async (input: {
  readonly dir: string;
  readonly resource: string;
  readonly slots: number;
  readonly slot?: number | undefined;
}): Promise<number> => {
  NodeFS.mkdirSync(input.dir, { recursive: true });
  const wanted = input.slot;
  if (wanted !== undefined) {
    let claim = tryLock(claimFile(input.dir, input.resource, wanted));
    while (claim === null) {
      await pause();
      claim = tryLock(claimFile(input.dir, input.resource, wanted));
    }
    while (tryLock(slotFile(input.dir, input.resource, wanted)) === null) await pause();
    NodeFS.closeSync(claim);
    return wanted;
  }
  for (;;) {
    for (let slot = 0; slot < input.slots; slot++) {
      const claim = tryLock(claimFile(input.dir, input.resource, slot));
      if (claim === null) continue;
      const held = tryLock(slotFile(input.dir, input.resource, slot));
      NodeFS.closeSync(claim);
      if (held !== null) return slot;
    }
    await pause();
  }
};
