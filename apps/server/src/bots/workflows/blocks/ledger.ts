/**
 * The experiment ledger (§4.1, §4.5): one `ledger:<id>` stream shared by every run, so no key and
 * no tree is ever measured twice. Pure: the engine reads the streams and folds them here.
 */
import type { Json } from "effect/Schema";

import type { CompiledWorkflow } from "@t3tools/shared/workflows";

import type { StoredFact } from "../facts.ts";

export type LedgerVerdict =
  | "kept"
  | "validated"
  | "rejected"
  | "invalid"
  | "duplicate"
  | "abandoned";

export interface LedgerEntry {
  readonly key: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly step: string;
  readonly hypothesis: string;
  readonly barHash: string;
  readonly registeredAt: string;
  readonly seq: number;
  /** `validated` once an output promoted a `kept` entry; null while unresolved. */
  readonly verdict: LedgerVerdict | null;
  readonly before: Json;
  readonly after: Json;
  readonly sha: string | null;
  readonly note: string | null;
  /** Seq of the EntryValidated fact, for ordering bases. */
  readonly validatedSeq: number | null;
}

export interface LedgerState {
  readonly id: string;
  /** By key, in registration order when iterated. */
  readonly entries: ReadonlyMap<string, LedgerEntry>;
  /** Tree hash → the entry key and run that claimed it first. */
  readonly trees: ReadonlyMap<string, { readonly entryKey: string; readonly runId: string }>;
}

export const emptyLedger = (id: string): LedgerState => ({
  id,
  entries: new Map(),
  trees: new Map(),
});

/** Folds one `ledger:<id>` stream; facts of other streams are ignored. */
export const foldLedger = (id: string, facts: ReadonlyArray<StoredFact>): LedgerState => {
  const entries = new Map<string, LedgerEntry>();
  const trees = new Map<string, { readonly entryKey: string; readonly runId: string }>();
  for (const stored of facts) {
    if (stored.stream !== `ledger:${id}`) continue;
    const fact = stored.fact;
    switch (fact._tag) {
      case "EntryRegistered":
        if (!entries.has(fact.key)) {
          entries.set(fact.key, {
            key: fact.key,
            workflowId: fact.workflowId,
            runId: fact.runId,
            step: fact.step,
            hypothesis: fact.hypothesis,
            barHash: fact.barHash,
            registeredAt: fact.at,
            seq: stored.seq,
            verdict: null,
            before: null,
            after: null,
            sha: null,
            note: null,
            validatedSeq: null,
          });
        }
        break;
      case "TreeSeen":
        if (!trees.has(fact.treeHash)) {
          trees.set(fact.treeHash, { entryKey: fact.entryKey, runId: fact.runId });
        }
        break;
      case "EntryResolved": {
        const entry = entries.get(fact.key);
        if (entry && entry.verdict === null) {
          entries.set(fact.key, {
            ...entry,
            verdict: fact.verdict,
            before: fact.before,
            after: fact.after,
            sha: fact.sha,
            note: fact.note,
          });
        }
        break;
      }
      case "EntryValidated": {
        const entry = entries.get(fact.key);
        if (entry?.verdict === "kept") {
          entries.set(fact.key, { ...entry, verdict: "validated", validatedSeq: stored.seq });
        }
        break;
      }
    }
  }
  return { id, entries, trees };
};

/** Sha of the most recently validated entry, or null. Kept-only entries never count. */
export const ledgerBest = (ledger: LedgerState): string | null => {
  let best: LedgerEntry | null = null;
  for (const entry of ledger.entries.values()) {
    if (
      entry.verdict === "validated" &&
      entry.sha !== null &&
      entry.validatedSeq !== null &&
      (best === null || entry.validatedSeq > (best.validatedSeq ?? -Infinity))
    )
      best = entry;
  }
  return best?.sha ?? null;
};

/** The prompt summary: every key, and the last 50 entries with verdict, before and after. */
export const ledgerDigest = (ledger: LedgerState): string => {
  const entries = [...ledger.entries.values()];
  if (entries.length === 0) return "Keys tried: none\nNothing has been tried.";
  return [
    `Keys tried: ${entries.map((entry) => entry.key).join(", ")}`,
    ...entries
      .slice(-50)
      .map(
        (entry) =>
          `${entry.key}: ${entry.verdict ?? "pending"} | ${entry.hypothesis.slice(0, 200).replace(/\s/g, " ")} | before=${JSON.stringify(entry.before)} | after=${JSON.stringify(entry.after)}`,
      ),
  ].join("\n");
};

/** Every ledger id the definition reads or writes: blocks, `once`, `promote`, `ledgerBest/Digest('…')`. */
export const ledgerIdsOf = (compiled: CompiledWorkflow): ReadonlyArray<string> => {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\bledger(?:Best|Digest)\s*\(\s*(['"])(.*?)\1\s*\)/g)) {
        if (match[2] !== undefined) ids.add(match[2]);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      if (
        "kind" in value &&
        value.kind === "hillclimb" &&
        "ledger" in value &&
        typeof value.ledger === "string"
      )
        ids.add(value.ledger);
      for (const [key, child] of Object.entries(value)) {
        if (
          (key === "once" || key === "promote") &&
          child !== null &&
          typeof child === "object" &&
          "ledger" in child &&
          typeof child.ledger === "string"
        )
          ids.add(child.ledger);
        visit(child);
      }
    }
  };
  visit(compiled.definition);
  return [...ids].sort();
};
