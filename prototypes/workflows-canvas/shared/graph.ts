// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
export type Kind = "agent" | "check" | "gate" | "hillclimb" | "arena" | "trigger" | "output";
export type Graph = {
  nodes: { id: string; kind: Kind; label: string; position?: { x: number; y: number } }[];
  edges: { id: string; from: string; to: string; label?: string }[];
};
export const kinds = ["agent", "check", "gate", "hillclimb", "arena", "trigger", "output"];
export const colors = {
  agent: "#dbeafe",
  check: "#dcfce7",
  gate: "#fef3c7",
  hillclimb: "#fce7f3",
  arena: "#ede9fe",
  trigger: "#cffafe",
  output: "#ffedd5",
};
export const sample: Graph = {
  nodes: [
    "cron",
    "detect new tag",
    "merge in worktree",
    "seams",
    "fork tests",
    "theme check",
    "Israel approves",
    "open PR",
  ].map((label, i) => ({
    id: String(i),
    kind: (["trigger", "agent", "agent", "check", "check", "check", "gate", "output"] as Kind[])[i],
    label,
  })),
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [2, 4],
    [2, 5],
    [3, 6],
    [4, 6],
    [5, 6],
    [6, 7],
  ].map(([a, b]) => ({
    id: `${a}-${b}`,
    from: String(a),
    to: String(b),
    ...(a === 3 ? { label: "on conflict" } : {}),
  })),
};
export function layout(g: Graph): Graph {
  const depth = new Map<string, number>();
  for (let i = 0; i < g.nodes.length; i++)
    for (const n of g.nodes) {
      const parents = g.edges.filter((e) => e.to === n.id);
      depth.set(
        n.id,
        Math.min(g.nodes.length, Math.max(0, ...parents.map((e) => (depth.get(e.from) ?? -1) + 1))),
      );
    }
  const rows: Record<number, number> = {};
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const d = depth.get(n.id) ?? 0;
      const row = rows[d] ?? 0;
      rows[d] = row + 1;
      return { ...n, position: n.position ?? { x: d * 240, y: row * 130 } };
    }),
  };
}
export function validate(g: Graph) {
  const errors: string[] = [];
  for (const n of g.nodes) if (!kinds.includes(n.kind)) errors.push(`Unknown kind: ${n.id}`);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges)
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`Arrow ${e.id} not bound to two boxes`);
  const visit = (id: string, path: Set<string>): boolean =>
    path.has(id) ||
    g.edges
      .filter((e) => e.from === id && ids.has(e.to))
      .some((e) => visit(e.to, new Set([...path, id])));
  if (g.nodes.some((n) => visit(n.id, new Set()))) errors.push("Cycle");
  return errors;
}
export function canonical(g: Graph) {
  return JSON.stringify({
    nodes: g.nodes.map(({ position, ...n }) => n).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export function patch(g: Graph): Graph {
  if (g.nodes.some((n) => n.id === "review")) return g;
  return layout({
    nodes: [
      ...g.nodes.map((n) =>
        ["6", "7"].includes(n.id)
          ? { ...n, position: { x: (n.position?.x ?? 0) + 240, y: n.position?.y ?? 0 } }
          : n,
      ),
      { id: "review", kind: "agent", label: "interrogate review" },
    ],
    edges: [
      ...g.edges.filter((e) => e.to !== "6"),
      ...g.edges.filter((e) => e.to === "6").map((e) => ({ ...e, to: "review" })),
      { id: "review-gate", from: "review", to: "6" },
    ],
  });
}
