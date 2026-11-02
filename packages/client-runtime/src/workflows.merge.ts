/**
 * Three-way merge of workflow definitions for the editor's conflict banner (friend fork). `base` is
 * the document the editor loaded, `mine` the local edit, `theirs` the `Conflict.current` definition.
 * Design: docs/friend/workflows-design.md §7.3.
 */
import type { WorkflowDefinition } from "@t3tools/contracts";

export interface MergeResult {
  readonly merged: WorkflowDefinition;
  /**
   * Items both sides changed differently, where `merged` kept `mine`: `title`, `budget`,
   * `nodes.<id>`, `canvas.positions.<id>`, `canvas.annotations.<id>`; sorted.
   */
  readonly conflicts: ReadonlyArray<string>;
}

/** The function this module exports: `export const mergeDocuments: WorkflowMergeApi["mergeDocuments"]`. */
export interface WorkflowMergeApi {
  /**
   * Merges by item: top-level fields by key, nodes by id at every level (a `map`/`loop` body merges
   * recursively, its other fields as one item), each level's edges as a set, positions and
   * annotations by id. A side that left an item as in `base` takes the other side's version.
   * Edges whose endpoints no longer exist at their level are dropped.
   */
  readonly mergeDocuments: (
    base: WorkflowDefinition,
    mine: WorkflowDefinition,
    theirs: WorkflowDefinition,
  ) => MergeResult;
}

import { formatEdge, parseEdge } from "@t3tools/shared/workflows";
import * as Result from "effect/Result";

type Item = Record<string, unknown>;
const record = (value: unknown): Item =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Item) : {};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record(value)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export const mergeDocuments: WorkflowMergeApi["mergeDocuments"] = (base, mine, theirs) => {
  const conflicts = new Set<string>();
  const choose = (b: unknown, m: unknown, t: unknown, path: string): unknown => {
    if (canonical(m) === canonical(b)) return t;
    if (canonical(t) === canonical(b) || canonical(m) === canonical(t)) return m;
    conflicts.add(path);
    return m;
  };
  const items = (b: Item, m: Item, t: Item, prefix: string): Item =>
    Object.fromEntries(
      [...new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])].flatMap((key) => {
        const value = choose(b[key], m[key], t[key], `${prefix}${key}`);
        return value === undefined ? [] : [[key, value]];
      }),
    );
  const graph = (b: Item, m: Item, t: Item): Item => {
    const strip = (v: Item) =>
      Object.fromEntries(
        Object.entries(v).filter(([key]) => !["nodes", "edges", "canvas"].includes(key)),
      );
    const merged = items(strip(b), strip(m), strip(t), "");
    const bn = record(b.nodes),
      mn = record(m.nodes),
      tn = record(t.nodes);
    const nodes: Item = {};
    for (const id of new Set([...Object.keys(bn), ...Object.keys(mn), ...Object.keys(tn)])) {
      const versions = [bn[id], mn[id], tn[id]];
      const recursive = versions.every(
        (v) => v !== undefined && ["map", "loop"].includes(String(record(v).kind)),
      );
      const withoutBody = (v: unknown) =>
        Object.fromEntries(Object.entries(record(v)).filter(([key]) => key !== "body"));
      const node = choose(
        recursive ? withoutBody(bn[id]) : bn[id],
        recursive ? withoutBody(mn[id]) : mn[id],
        recursive ? withoutBody(tn[id]) : tn[id],
        `nodes.${id}`,
      );
      if (node !== undefined)
        nodes[id] = recursive
          ? {
              ...record(node),
              body: graph(
                record(record(bn[id]).body),
                record(record(mn[id]).body),
                record(record(tn[id]).body),
              ),
            }
          : node;
    }
    const edges = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .filter((e): e is string => typeof e === "string")
            .map((e) => {
              const parsed = parseEdge(e);
              return Result.isSuccess(parsed) ? formatEdge(parsed.success) : e;
            })
        : [];
    const be = new Set(edges(b.edges)),
      me = edges(m.edges),
      te = edges(t.edges);
    const selected = [...new Set([...me, ...te])]
      .filter((e) => (new Set(me).has(e) !== be.has(e) ? new Set(me).has(e) : new Set(te).has(e)))
      .filter((e) => {
        const parsed = parseEdge(e);
        return (
          !Result.isSuccess(parsed) ||
          (Object.hasOwn(nodes, parsed.success.from) && Object.hasOwn(nodes, parsed.success.to))
        );
      });
    return { ...merged, nodes, edges: selected };
  };
  const merged = graph(record(base), record(mine), record(theirs));
  if (base.canvas !== undefined || mine.canvas !== undefined || theirs.canvas !== undefined) {
    const annotations = (v: WorkflowDefinition) =>
      Object.fromEntries((v.canvas?.annotations ?? []).map((a) => [a.id, a]));
    const positions = items(
      record(base.canvas?.positions),
      record(mine.canvas?.positions),
      record(theirs.canvas?.positions),
      "canvas.positions.",
    );
    const ids = new Set<string>();
    const collect = (g: Item): void => {
      for (const [id, node] of Object.entries(record(g.nodes))) {
        ids.add(id);
        if (record(node).body !== undefined) collect(record(record(node).body));
      }
    };
    collect(merged);
    merged.canvas = {
      positions: Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id))),
      annotations: Object.values(
        items(annotations(base), annotations(mine), annotations(theirs), "canvas.annotations."),
      ),
      ...(mine.canvas?.viewport === undefined ? {} : { viewport: mine.canvas.viewport }),
    };
  }
  return {
    merged: merged as WorkflowDefinition,
    conflicts: [...conflicts].sort(),
  };
};
