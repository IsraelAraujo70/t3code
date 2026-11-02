/** The closed registry of block kinds: a fifth block is one more case here. */
import type { WorkflowBlockView, WorkflowNode } from "@t3tools/contracts";
import type { CompiledGraph, CompiledWorkflow } from "@t3tools/shared/workflows";

import type { RunState } from "../state.ts";
import { arena } from "./arena.ts";
import { graph } from "./graph.ts";
import { hillclimb } from "./hillclimb.ts";
import { interrogate } from "./interrogate.ts";
import { blockReader } from "./reader.ts";
import { type BlockHost, runBlock } from "./run.ts";
import type { BlockNode } from "./types.ts";

export const runBlockNode = (
  node: BlockNode,
  step: string,
  attempt: number,
  host: BlockHost,
): void => {
  switch (node.kind) {
    case "hillclimb":
      return runBlock(hillclimb, node, step, attempt, host);
    case "arena":
      return runBlock(arena, node, step, attempt, host);
    case "graph":
      return runBlock(graph, node, step, attempt, host);
    case "interrogate":
      return runBlock(interrogate, node, step, attempt, host);
  }
};

/** The block's live sub-state for the run screen, from the folded run alone. */
export const blockView = (
  node: BlockNode,
  state: RunState,
  step: string,
  attempt: number,
  now: number,
): WorkflowBlockView => {
  const reader = blockReader(state, step, attempt, now);
  switch (node.kind) {
    case "hillclimb":
      return hillclimb.view(node, hillclimb.derive(node, reader));
    case "arena":
      return arena.view(node, arena.derive(node, reader));
    case "graph":
      return graph.view(node, graph.derive(node, reader));
    case "interrogate":
      return interrogate.view(node, interrogate.derive(node, reader));
  }
};

/** The node a block step names, walking map and loop bodies (`each[2]/climb` → `climb`). */
const blockNodeAt = (compiled: CompiledWorkflow, step: string): BlockNode | null => {
  let graph: CompiledGraph | null = compiled.root;
  let node: WorkflowNode | null = null;
  for (const segment of step.split("/")) {
    if (graph === null) return null;
    const found = graph.nodes.get(segment.replace(/\[\d+\]$/, ""));
    if (found === undefined) {
      if (node !== null && /^r\d+(\[\d+\])?$/.test(segment)) continue;
      return null;
    }
    node = found.node;
    graph = found.body;
  }
  return node !== null && BLOCK_KINDS.has(node.kind) ? (node as BlockNode) : null;
};
const BLOCK_KINDS = new Set<string>(["hillclimb", "arena", "graph", "interrogate"]);

/**
 * Every block the run started, for the run screen; with `afterSeq`, only the blocks whose events
 * or children changed after it (a delta).
 */
export const blockViews = (
  compiled: CompiledWorkflow,
  state: RunState,
  afterSeq = 0,
): ReadonlyArray<WorkflowBlockView> =>
  [...state.blocks.keys()].flatMap((scope) => {
    const retried = /^(.*)\/a(\d+)$/.exec(scope);
    const step = retried?.[1] ?? scope;
    const attempt = retried ? Number(retried[2]) : 1;
    const node = blockNodeAt(compiled, step);
    if (node === null) return [];
    const changed =
      (state.blocks.get(scope) ?? []).some((e) => e.seq > afterSeq) ||
      [...state.attempts].some(
        ([s, attempts]) => s.startsWith(`${scope}/`) && attempts.some((a) => a.lastSeq > afterSeq),
      );
    // Views never read active time, so the clock is not needed here.
    return changed ? [blockView(node, state, step, attempt, 0)] : [];
  });
