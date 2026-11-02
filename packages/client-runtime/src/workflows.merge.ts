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
