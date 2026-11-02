import type { Node, Edge } from "@xyflow/react";
import type {
  CanvasTrigger,
  CanvasAdapter,
  CanvasModel,
  CanvasNode,
  CanvasAnnotation,
} from "@t3tools/client-runtime/workflows";

export type WorkflowFlowNode = Node<
  { model: CanvasNode } | { annotation: CanvasAnnotation } | { trigger: CanvasTrigger }
>;
export type ReactFlowScene = {
  nodes: WorkflowFlowNode[];
  edges: Edge[];
  viewport?: CanvasModel["viewport"];
};

/** Keeps domain metadata intact while React Flow owns positions and selection. */
export const reactFlowAdapter: CanvasAdapter<ReactFlowScene> = {
  fromModel: (model, mode) => ({
    ...(model.viewport ? { viewport: model.viewport } : {}),
    nodes: [
      ...model.triggers.map((trigger): WorkflowFlowNode => ({
        id: trigger.id,
        type: "workflow",
        position: { x: trigger.x, y: trigger.y },
        width: trigger.w,
        height: trigger.h,
        data: { trigger },
        draggable: mode === "edit",
        connectable: false,
        deletable: mode === "edit",
      })),
      ...model.nodes.map((node): WorkflowFlowNode => ({
        id: node.id,
        type: "workflow",
        position: { x: node.x, y: node.y },
        width: node.w,
        height: node.h,
        style: { width: node.w, height: node.h },
        ...(node.parent === null ? {} : { parentId: node.parent, extent: "parent" }),
        data: { ...node, model: node },
        draggable: mode === "edit",
      })),
      ...model.annotations.map((annotation): WorkflowFlowNode => ({
        id: `${annotation.kind}:${annotation.id}`,
        type: annotation.kind,
        position: { x: annotation.x, y: annotation.y },
        width: annotation.w,
        height: annotation.h,
        style: { width: annotation.w, height: annotation.h },
        data: { ...annotation, annotation },
        draggable: mode === "edit",
        connectable: false,
      })),
    ],
    edges: [
      ...model.entries.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "rough",
        selectable: false,
        deletable: false,
        data: { entry: true },
      })),
      ...model.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.port,
        type: "rough",
        ...(edge.port === null ? {} : { label: edge.port }),
      })),
    ],
  }),
  toModel: (scene): CanvasModel => ({
    ...(scene.viewport ? { viewport: scene.viewport } : {}),
    triggers: scene.nodes.flatMap((node) =>
      "trigger" in node.data
        ? [
            {
              ...node.data.trigger,
              x: node.position.x,
              y: node.position.y,
              w: node.width ?? node.data.trigger.w,
              h: node.height ?? node.data.trigger.h,
            },
          ]
        : [],
    ),
    entries: scene.edges
      .filter((edge) => edge.data?.entry === true)
      .map((edge) => ({ id: edge.id, from: edge.source, to: edge.target })),
    nodes: scene.nodes.flatMap((node) =>
      "model" in node.data
        ? [
            {
              ...node.data.model,
              x: node.position.x,
              y: node.position.y,
              w: node.width ?? node.data.model.w,
              h: node.height ?? node.data.model.h,
            },
          ]
        : [],
    ),
    annotations: scene.nodes.flatMap((node) =>
      "annotation" in node.data
        ? [
            {
              ...node.data.annotation,
              x: node.position.x,
              y: node.position.y,
              w: node.width ?? node.data.annotation.w,
              h: node.height ?? node.data.annotation.h,
            },
          ]
        : [],
    ),
    edges: scene.edges
      .filter((edge) => edge.data?.entry !== true)
      .map((edge) => ({
        id: edge.id,
        from: edge.source,
        to: edge.target,
        port: edge.sourceHandle ?? null,
      })),
  }),
};
