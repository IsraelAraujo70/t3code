import { describe, expect, it } from "vite-plus/test";

import type { Fact, StoredFact } from "./facts.ts";
import { workflowStatus } from "./workflowStatus.ts";

const stored = (facts: ReadonlyArray<Fact>): ReadonlyArray<StoredFact> =>
  facts.map((fact, index) => ({
    stream: "workflow:demo",
    seq: index + 1,
    key: `k${index}`,
    fact,
    at: "t",
  }));
const on: Fact = { _tag: "Toggled", enabled: true, by: "israel", at: "t" };
const off: Fact = { _tag: "Toggled", enabled: false, by: "israel", at: "t" };
const suspended: Fact = { _tag: "Suspended", reason: "fatigue", at: "t" };
const unsuspended: Fact = { _tag: "Unsuspended", by: "israel", at: "t" };

describe("workflowStatus", () => {
  it.each([
    ["no Toggled yet", [], { enabled: false, suspended: false, toggledSeq: 0 }],
    ["turned on", [on], { enabled: true, suspended: false, toggledSeq: 1 }],
    ["turned on, then off", [on, off], { enabled: false, suspended: false, toggledSeq: 2 }],
    ["suspended by fatigue", [on, suspended], { enabled: true, suspended: true, toggledSeq: 1 }],
    [
      "unsuspended",
      [on, suspended, unsuspended],
      { enabled: true, suspended: false, toggledSeq: 1 },
    ],
  ] as const)("%s", (_case, facts, expected) => {
    expect(workflowStatus(stored(facts))).toEqual({ ...expected, off: new Set() });
  });
});

it("folds independent trigger switches without changing them on workflow toggles", () => {
  const toggle = (triggerId: string, enabled: boolean): Fact => ({
    _tag: "TriggerToggled",
    triggerId,
    enabled,
    by: "israel",
    at: "t",
  });
  expect(workflowStatus(stored([toggle("a", false)])).off).toEqual(new Set(["a"]));
  expect(
    workflowStatus(stored([toggle("a", false), toggle("b", false), toggle("a", true), off])).off,
  ).toEqual(new Set(["b"]));
});
