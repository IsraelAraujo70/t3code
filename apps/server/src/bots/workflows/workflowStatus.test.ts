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
    ["no Toggled yet", [], { enabled: false, suspended: false }],
    ["turned on", [on], { enabled: true, suspended: false }],
    ["turned on, then off", [on, off], { enabled: false, suspended: false }],
    ["suspended by fatigue", [on, suspended], { enabled: true, suspended: true }],
    ["unsuspended", [on, suspended, unsuspended], { enabled: true, suspended: false }],
  ] as const)("%s", (_case, facts, expected) => {
    expect(workflowStatus(stored(facts))).toEqual(expected);
  });
});
