import { lazy, Suspense } from "react";
import type { WorkflowCanvasProps } from "./WorkflowCanvas";
const Canvas = lazy(() => import("./WorkflowCanvas"));
export type { WorkflowCanvasProps } from "./WorkflowCanvas";
/** Loads the graph renderer only when a workflow route mounts it. */
export function LazyWorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <Suspense fallback={<div role="status">Loading canvas…</div>}>
      <Canvas {...props} />
    </Suspense>
  );
}
