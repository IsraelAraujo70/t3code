/**
 * Holds one slot of a resource for an agent turn, which is not a process of the engine:
 * `node wfSlot.ts --slot-dir <dir> --resource <name> --slots <n>` prints `{"slot":i}` once it
 * holds one, then holds it until its stdin closes (released, or the server died) or a signal ends it.
 */
import { acquireSlot } from "./slotLock.ts";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1]!;

// Registered before the wait, so a server that dies while this waits ends it too.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));

const slot = await acquireSlot({
  dir: option("--slot-dir"),
  resource: option("--resource"),
  slots: Number(option("--slots")),
});
process.stdout.write(`${JSON.stringify({ slot })}\n`);
