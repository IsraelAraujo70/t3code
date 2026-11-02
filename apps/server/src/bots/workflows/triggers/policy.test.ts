import { expect, it } from "vite-plus/test";
import { originOf, resolveTrigger, triggerBlock, type TriggerBlockInput } from "./policy.ts";

const base: TriggerBlockInput = {
  trigger: { id: "run", kind: "manual" },
  firedKind: "manual",
  origin: "event",
  status: { enabled: true, suspended: false, off: new Set() },
  caller: null,
};
it.each([
  ["missing", { trigger: undefined }, "invalid"],
  ["mismatch", { firedKind: "bot" }, "invalid"],
  [
    "bot denied",
    {
      trigger: { id: "ask", kind: "bot", description: "test", bots: ["a"] },
      firedKind: "bot",
      caller: "b",
    },
    "invalid",
  ],
  [
    "bot open",
    { trigger: { id: "ask", kind: "bot", description: "test" }, firedKind: "bot" },
    null,
  ],
  [
    "call denied",
    { trigger: { id: "parent", kind: "call", from: ["a"] }, firedKind: "call", caller: "b" },
    "invalid",
  ],
  [
    "suspended owner",
    { origin: "owner", status: { ...base.status, suspended: true } },
    "suspended",
  ],
  ["owner off", { origin: "owner", status: { ...base.status, enabled: false } }, null],
  ["workflow off", { status: { ...base.status, enabled: false } }, "disabled"],
  ["trigger off", { status: { ...base.status, off: new Set(["run"]) } }, "disabled"],
  ["allowed", {}, null],
] satisfies Array<[string, Partial<TriggerBlockInput>, string | null]>)(
  "%s",
  (_, patch, expected) => {
    expect(triggerBlock({ ...base, ...patch })).toBe(expected);
  },
);
it.each([
  ["manual:x", "owner"],
  ["test:x:y", "owner"],
  ["bot:x", "bot"],
  ["child:x", "workflow"],
  ["run-failed:x", "workflow"],
  ["cron:x", "event"],
])("origin %s", (key, expected) => expect(originOf(key)).toBe(expected));
it("resolves ids and only falls back for on-demand kinds", () => {
  const triggers = { run: { kind: "manual" }, parent: { kind: "call" } } as const;
  expect(resolveTrigger(triggers, "run", "manual")?.id).toBe("run");
  expect(resolveTrigger(triggers, "call", "call")?.id).toBe("parent");
  expect(resolveTrigger(triggers, "missing", "cron")).toBeUndefined();
  // A manual trigger named "call" does not swallow a child run's placeholder id.
  expect(
    resolveTrigger({ call: { kind: "manual" }, parent: { kind: "call" } }, "call", "call")?.id,
  ).toBe("parent");
});
