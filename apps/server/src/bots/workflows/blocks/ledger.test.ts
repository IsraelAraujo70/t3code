import { describe, expect, it } from "vite-plus/test";
import type { LedgerFact, StoredFact } from "../facts.ts";
import { compile } from "../testkit/decideHarness.ts";
import { foldLedger, ledgerBest, ledgerDigest, ledgerIdsOf } from "./ledger.ts";

const registered = (key: string, runId = "first"): LedgerFact => ({
  _tag: "EntryRegistered",
  key,
  runId,
  workflowId: "demo",
  step: "step",
  hypothesis: "h".repeat(250),
  barHash: "bar",
  at: "now",
});
const resolved = (
  key: string,
  verdict: "kept" | "rejected" = "kept",
  sha: string | null = key,
): LedgerFact => ({
  _tag: "EntryResolved",
  key,
  verdict,
  before: { score: 1 },
  after: { score: 2 },
  sha,
  note: "note",
  at: "now",
});
const validated = (key: string): LedgerFact => ({
  _tag: "EntryValidated",
  key,
  runId: "first",
  at: "now",
});
const fold = (facts: LedgerFact[]) =>
  foldLedger(
    "test",
    facts.map((fact, seq): StoredFact => ({
      stream: "ledger:test",
      seq,
      key: String(seq),
      fact,
      at: "now",
    })),
  );

describe("ledger", () => {
  it("keeps the first registration and tree claim and ignores foreign streams", () => {
    const ledger = fold([
      registered("a"),
      registered("a", "second"),
      { _tag: "TreeSeen", treeHash: "tree", entryKey: "a", runId: "first" },
      { _tag: "TreeSeen", treeHash: "tree", entryKey: "b", runId: "second" },
    ]);
    expect(ledger.entries.get("a")?.runId).toBe("first");
    expect(ledger.trees.get("tree")).toEqual({ entryKey: "a", runId: "first" });
    expect(
      foldLedger("test", [
        { stream: "ledger:other", seq: 1, key: "entry:a", fact: registered("a"), at: "now" },
      ]).entries.size,
    ).toBe(0);
  });

  it.each([
    { name: "empty", facts: [], best: null },
    { name: "kept only", facts: [registered("a"), resolved("a")], best: null },
    { name: "validated", facts: [registered("a"), resolved("a"), validated("a")], best: "a" },
    {
      name: "rejected",
      facts: [registered("a"), resolved("a", "rejected"), validated("a")],
      best: null,
    },
    {
      name: "null sha",
      facts: [registered("a"), resolved("a", "kept", null), validated("a")],
      best: null,
    },
    {
      name: "validation order",
      facts: [
        registered("a"),
        registered("b"),
        resolved("a"),
        resolved("b"),
        validated("b"),
        validated("a"),
      ],
      best: "a",
    },
  ])("selects best: $name", ({ facts, best }) => {
    const ledger = fold(facts);
    expect(ledgerBest(ledger)).toBe(best);
    if (facts.some((fact) => fact._tag === "EntryResolved" && fact.verdict === "rejected")) {
      expect(ledger.entries.get("a")?.verdict).toBe("rejected");
    }
  });

  it("preserves first resolution and validation sequence", () => {
    const ledger = fold([
      resolved("missing"),
      validated("missing"),
      registered("a"),
      validated("a"),
      resolved("a"),
      validated("a"),
      resolved("a", "rejected"),
      validated("a"),
    ]);
    expect(ledger.entries.size).toBe(1);
    expect(ledger.entries.get("a")).toMatchObject({
      verdict: "validated",
      validatedSeq: 5,
      before: { score: 1 },
      after: { score: 2 },
      sha: "a",
      note: "note",
    });
  });

  it("lists every key and only the last 50 clipped entries", () => {
    const keys = Array.from({ length: 55 }, (_, i) => `key${i}`);
    const digest = ledgerDigest(fold(keys.map((key) => registered(key))));
    const lines = digest.split("\n");
    expect(lines[0]).toBe(`Keys tried: ${keys.join(", ")}`);
    expect(lines).toHaveLength(51);
    expect(lines[1]).toBe(`key5: pending | ${"h".repeat(200)} | before=null | after=null`);
    expect(lines[50]).toContain("key54: pending");
    expect(ledgerDigest(fold([]))).toContain("Keys tried: none");
    expect(ledgerDigest(fold([registered("a"), resolved("a")]))).toContain(
      'before={"score":1} | after={"score":2}',
    );
  });

  it("discovers block, nested once, promote and literal expression ledgers", () => {
    const compiled = compile({
      nodes: {
        climb: {
          kind: "hillclimb",
          ledger: "argo35-throughput",
          workspace: { project: "t3code", base: "main" },
          generator: {
            model: "$lead",
            workspace: { project: "t3code", readOnly: true },
            prompt: "{{ledgerDigest('argo35-throughput')}}",
          },
          build: { argv: ["build"], cwd: "attempt", artifact: "bin" },
          measure: { bench: { argv: ["bench"], cwd: "attempt", parse: "json" } },
          objective: { expr: "m.bench.score", direction: "max" },
          keep: "true",
          target: "false",
          plateau: { rounds: 2 },
          budget: { iterations: 3, wall: "1h", tokens: 1000 },
        },
      },
      edges: [],
    });
    const definition = {
      ...compiled.definition,
      edges: [...compiled.definition.edges, "climb:target -> nested"],
      workspaces: {
        integ: { project: "t3code", branch: "wf/demo", base: '{{ledgerBest("base")}}' },
      },
      nodes: {
        ...compiled.definition.nodes,
        nested: {
          kind: "map",
          items: "trigger.items",
          maxItems: 1,
          concurrency: 1,
          body: {
            nodes: {
              child: {
                kind: "output",
                status: "no_change",
                value: {},
                once: { ledger: "once", key: "key" },
                promote: { ledger: "promoted", sha: "abc" },
              },
            },
            edges: [],
          },
        },
      },
    };
    expect(ledgerIdsOf(compile(definition))).toEqual([
      "argo35-throughput",
      "base",
      "once",
      "promoted",
    ]);
  });
});
