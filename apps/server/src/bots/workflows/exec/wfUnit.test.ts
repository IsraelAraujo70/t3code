// @effect-diagnostics nodeBuiltinImport:off - subprocess fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import { it, expect } from "@effect/vitest";

it.live.each([
  ["json", "console.log(JSON.stringify({ok:true}))", 0, null],
  ["json-last-line", 'console.log("log"); console.log(JSON.stringify({ok:true}))', 0, null],
  ["json", 'console.log("bad")', 0, null],
  ["none", "process.exit(7)", 7, null],
  ["none", "setInterval(() => {}, 1000)", null, "TIMEOUT"],
  ["missing", "", 127, null],
  // A descendant that keeps stdout open must not hold the receipt: at timeout, or after an exit
  // in time whose drain runs past the deadline (timeout 300 ms, drain 600 ms).
  [
    "none",
    'require("child_process").spawn("sleep", ["300"], { stdio: "inherit" }); setInterval(() => {}, 1000)',
    null,
    "TIMEOUT",
  ],
  [
    "none",
    'require("child_process").spawn("sleep", ["300"], { stdio: "inherit" }).unref()',
    0,
    null,
    "300",
    "600",
  ],
] as const)("writes receipts for %s %s", ([parse, script, exit, signal, timeoutMs, drainMs]) =>
  Effect.promise(async () => {
    const dir = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/wf-unit-");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [
          new URL("./wfUnit.ts", import.meta.url).pathname,
          "--receipt",
          dir,
          "--cwd",
          dir,
          "--parse",
          parse === "missing" ? "none" : parse,
          "--timeout-ms",
          timeoutMs ?? (signal ? "100" : "5000"),
          "--drain-ms",
          drainMs ?? "100",
          "--",
          ...(parse === "missing"
            ? ["/nonexistent-wf-executable"]
            : [process.execPath, "-e", script]),
        ]);
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(String(code)))));
      });
      const receipt = JSON.parse(NodeFS.readFileSync(dir + "/exit.json", "utf8"));
      expect(receipt).toMatchObject({ exit, signal });
      if (script.includes("ok:true")) expect(receipt.out).toEqual({ ok: true });
      if (script.includes('"bad"')) expect(receipt.parseError).toBeTypeOf("string");
      expect(JSON.parse(NodeFS.readFileSync(dir + "/started.json", "utf8")).pid).toBeGreaterThan(0);
    } finally {
      NodeFS.rmSync(dir, { recursive: true });
    }
  }),
);
