// @effect-diagnostics nodeBuiltinImport:off - runs alone inside a systemd unit.
// @effect-diagnostics globalDate:off globalTimers:off - standalone Node process has no Effect runtime.
/**
 * Holds one slot of a resource for an agent turn, in its own unit so it outlives a server restart:
 * `node wfSlot.ts --slot-dir <dir> --resource <name> --slots <n> [--slot <i>] --receipt <dir>`
 * writes `held.json` (`{ slot }`, atomic rename) once it holds a slot, then holds it until the unit
 * stops. With `--slot` it waits for exactly that slot, the one a turn recorded.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { acquireSlot } from "./slotLock.ts";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const receipt = option("--receipt")!;

process.on("SIGTERM", () => process.exit(0));

const wanted = option("--slot");
const slot = await acquireSlot({
  dir: option("--slot-dir")!,
  resource: option("--resource")!,
  slots: Number(option("--slots")),
  slot: wanted === undefined ? undefined : Number(wanted),
});
NodeFS.mkdirSync(receipt, { recursive: true });
const temp = NodePath.join(receipt, "held.json.tmp");
NodeFS.writeFileSync(temp, JSON.stringify({ slot, at: new Date().toISOString() }));
NodeFS.renameSync(temp, NodePath.join(receipt, "held.json"));
// The slot is this process's open file: it stays held while the process lives.
setInterval(() => {}, 1 << 30);
