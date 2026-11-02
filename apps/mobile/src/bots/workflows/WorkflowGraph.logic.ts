import type { CanvasModel } from "@t3tools/client-runtime/workflows";

/** Resolve nested body positions before drawing edges and calculating bounds. */
export function graphGeometry(model: CanvasModel, width: number) {
  const nodes = model.nodes.map((node) => ({ ...node }));
  for (const node of nodes) {
    const parent = nodes.find((candidate) => candidate.id === node.parent);
    if (parent) {
      node.x += parent.x;
      node.y += parent.y;
    }
  }
  const w = Math.max(1, ...nodes.map((node) => node.x + node.w + 24));
  const h = Math.max(1, ...nodes.map((node) => node.y + node.h + 24));
  return { nodes, w, h, scale: Math.min(1, Math.max(1, width) / w) };
}

/** A stable nonzero rough drawing seed for a node or edge. */
export function drawingSeed(id: string) {
  return [...id].reduce((seed, char) => (seed * 31 + char.charCodeAt(0)) >>> 0, 1) || 1;
}

/** Cubic edge and label coordinates between the source and target boxes. */
export function edgeGeometry(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; h: number },
) {
  const x = from.x + from.w;
  const y = from.y + from.h / 2;
  const tx = to.x;
  const ty = to.y + to.h / 2;
  return {
    path: `M ${x} ${y} C ${x + 50} ${y}, ${tx - 50} ${ty}, ${tx} ${ty}`,
    labelX: (x + tx) / 2,
    labelY: (y + ty) / 2 - 5,
  };
}
