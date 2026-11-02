import type { WorkflowDefinition, WorkflowGraph, WorkflowNode } from "@t3tools/contracts";
import { parseEdge } from "@t3tools/shared/workflows";
import * as Result from "effect/Result";

export type EditFormat = "text" | "number" | "json" | "lines" | "commas" | "workspace";

/** Parses editor text without losing empty argv entries or whitespace inside arguments. */
export function parseFieldText(text: string, format: EditFormat): unknown {
  if (text === "") return undefined;
  switch (format) {
    case "json":
      return JSON.parse(text);
    case "number":
      return Number(text);
    case "lines":
      return text.split(/\r?\n/);
    case "commas":
      return text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    case "workspace":
      return text.trimStart().startsWith("{") ? JSON.parse(text) : text;
    case "text":
      return text;
  }
}

/** Serializes structured values to the field's editable representation. */
export function fieldText(value: unknown, format: EditFormat): string {
  if (value === undefined) return "";
  if (Array.isArray(value) && (format === "lines" || format === "commas")) {
    return value.join(format === "lines" ? "\n" : ", ");
  }
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

/** Reads a dotted field path in a node or workflow definition. */
export function fieldValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return Object.fromEntries(Object.entries(current))[key];
  }, value);
}

/** Empty text removes the field; callers decode the result before committing it. */
export function applyFieldEdit(
  value: object,
  path: string,
  text: string,
  format: EditFormat,
): object {
  const parsed = parseFieldText(text, format);
  const write = (current: unknown, parts: readonly string[]): object => {
    const result =
      current !== null && typeof current === "object"
        ? Object.fromEntries(Object.entries(current))
        : {};
    const [key, ...rest] = parts;
    if (key === undefined) return result;
    if (rest.length > 0) result[key] = write(result[key], rest);
    else if (parsed === undefined) delete result[key];
    else result[key] = parsed;
    return result;
  };
  return write(value, path.split("."));
}

/** Removes a node's subtree, incident edges at its level and attached layout metadata. */
export function deleteInspectorNode(
  definition: WorkflowDefinition,
  id: string,
): WorkflowDefinition {
  const removed = new Set<string>();
  const collect = (key: string, node: WorkflowNode): void => {
    removed.add(key);
    if (node.kind === "map" || node.kind === "loop") {
      for (const [child, config] of Object.entries(node.body.nodes)) collect(child, config);
    }
  };
  const visit = (graph: WorkflowGraph): WorkflowGraph => ({
    nodes: Object.fromEntries(
      Object.entries(graph.nodes).flatMap(([key, node]) => {
        if (key === id) {
          collect(key, node);
          return [];
        }
        return [
          [
            key,
            node.kind === "map" || node.kind === "loop"
              ? { ...node, body: visit(node.body) }
              : node,
          ],
        ];
      }),
    ),
    edges: graph.edges.filter((edge) => {
      const parsed = parseEdge(edge);
      return Result.isFailure(parsed) || (parsed.success.from !== id && parsed.success.to !== id);
    }),
  });
  const graph = visit(definition);
  return {
    ...definition,
    ...graph,
    ...(definition.canvas === undefined
      ? {}
      : {
          canvas: {
            ...definition.canvas,
            positions: Object.fromEntries(
              Object.entries(definition.canvas.positions).filter(([key]) => !removed.has(key)),
            ),
            annotations: definition.canvas.annotations.filter(
              (item) => !item.attachedTo || !removed.has(item.attachedTo),
            ),
          },
        }),
  };
}

/** Finds the diagnostic prefix of a node at any map/loop depth. */
export function inspectorNodePath(graph: WorkflowGraph, id: string, prefix = ""): string | null {
  for (const [key, node] of Object.entries(graph.nodes)) {
    const path = `${prefix}nodes.${key}`;
    if (key === id) return path;
    if (node.kind === "map" || node.kind === "loop") {
      const nested = inspectorNodePath(node.body, id, `${path}.body.`);
      if (nested) return nested;
    }
  }
  return null;
}
