import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { CanvasModel } from "@t3tools/client-runtime/workflows";
import { render } from "../../../../test/render";
import { LazyWorkflowCanvas as WorkflowCanvas } from "./LazyWorkflowCanvas";

function fixture(): CanvasModel {
  return {
    nodes: [0, 1, 2].map((n) => ({
      id: `n${n}`,
      kind: "agent",
      label: `Node ${n}`,
      subtitle: "",
      x: n * 280,
      y: 40 + n * 60,
      w: 200,
      h: 64,
      parent: null,
      ports: ["ok"],
    })),
    edges: [
      { id: "first", from: "n0", port: "ok", to: "n1" },
      { id: "second", from: "n1", port: "ok", to: "n2" },
    ],
    annotations: [
      { id: "a", kind: "note", text: "Remember", x: 0, y: 180, w: 180, h: 100, attachedTo: "n0" },
    ],
  };
}
function Harness({ changed }: { changed: (model: CanvasModel) => void }) {
  const [model, setModel] = useState(fixture);
  return (
    <div style={{ width: 900, height: 500 }}>
      <WorkflowCanvas
        model={model}
        mode="edit"
        onChange={(next) => {
          setModel(next);
          changed(next);
        }}
      />
    </div>
  );
}
it("preserves note attachment when editing text", async () => {
  const changed = vi.fn();
  await using screen = await render(<Harness changed={changed} />);
  await userEvent.dblClick(screen.getByText("Remember"));
  const text = screen.getByRole("textbox", { name: "Note text" });
  await userEvent.fill(text, "Updated");
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(changed.mock.lastCall?.[0].annotations).toEqual([
      { ...fixture().annotations[0], text: "Updated" },
    ]),
  );
});
it.each(["keyboard", "menu"] as const)(
  "deletes only the selected connection by %s",
  async (method) => {
    const changed = vi.fn();
    await using screen = await render(<Harness changed={changed} />);
    await expect.element(screen.getByText("Node 0")).toBeVisible();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-id="first"] .react-flow__edge-interaction'),
      ).not.toBeNull(),
    );
    const path = document.querySelector('[data-id="first"] .react-flow__edge-interaction');
    expect(path).not.toBeNull();
    if (!path) throw new Error("Missing connection interaction path");
    if (method === "keyboard") {
      await userEvent.click(path);
      await userEvent.keyboard("{Delete}");
    } else {
      await userEvent.click(path, { button: "right" });
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete connection" }));
    }
    await vi.waitFor(() =>
      expect(changed.mock.lastCall?.[0].edges.map((e: { id: string }) => e.id)).toEqual(["second"]),
    );
  },
);

it("deletes a node by keyboard with its connections in one change", async () => {
  const changed = vi.fn();
  await using screen = await render(<Harness changed={changed} />);
  await userEvent.click(screen.getByText("Node 1"));
  await userEvent.keyboard("{Delete}");
  await vi.waitFor(() => {
    const model: CanvasModel | undefined = changed.mock.lastCall?.[0];
    expect(model?.nodes.map((n) => n.id)).toEqual(["n0", "n2"]);
    expect(model?.edges).toEqual([]);
    expect(model?.annotations).toEqual(fixture().annotations);
  });
});

it("keeps the clicked node selected when the parent re-renders with a new model", async () => {
  const changed = vi.fn();
  function Reselecting() {
    const [selected, setSelected] = useState<string | null>(null);
    const [model, setModel] = useState(fixture);
    return (
      <div style={{ width: 900, height: 500 }} data-selected={selected ?? ""}>
        <WorkflowCanvas
          // Selecting hands the canvas a new, equal model, as an unmemoized parent would.
          model={selected === null ? model : { ...model }}
          mode="edit"
          onSelectNode={setSelected}
          onChange={(next) => {
            setModel(next);
            changed(next);
          }}
        />
      </div>
    );
  }
  await using screen = await render(<Reselecting />);
  await userEvent.click(screen.getByText("Node 1"));
  await vi.waitFor(() => expect(document.querySelector('[data-selected="n1"]')).not.toBeNull());
  await userEvent.keyboard("{Delete}");
  await vi.waitFor(() =>
    expect(changed.mock.lastCall?.[0].nodes.map((n: { id: string }) => n.id)).toEqual(["n0", "n2"]),
  );
});
it("shows run badges and preserves rough strokes across status changes", async () => {
  const base = fixture();
  const model: CanvasModel = {
    ...base,
    nodes: [...base.nodes, { ...base.nodes[0]!, id: "pending", x: 840 }].map((node, i) => ({
      ...node,
      status: (["succeeded", "waiting_gate", "failed", "pending"] as const)[i]!,
    })),
  };
  await using screen = await render(<WorkflowCanvas model={model} mode="run" />);
  await expect.element(screen.getByRole("img", { name: "Succeeded" })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Waiting for you" })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Failed" })).toBeVisible();
  expect(document.querySelectorAll(".wf-badge")).toHaveLength(3);
  const path = document.querySelector('[data-id="n0"] svg path:last-child')?.getAttribute("d");
  await screen.rerender(
    <WorkflowCanvas
      model={{ ...model, nodes: model.nodes.map((node) => ({ ...node, status: "running" })) }}
      mode="run"
    />,
  );
  expect(document.querySelector('[data-id="n0"] svg path:last-child')?.getAttribute("d")).toBe(
    path,
  );
  await expect.element(screen.getByText("ok").first()).toBeVisible();
});
it("draws map and loop frames dashed", async () => {
  const base = fixture();
  const model: CanvasModel = {
    ...base,
    nodes: [{ ...base.nodes[0]!, id: "each", kind: "map", w: 300, h: 160 }],
    edges: [],
    annotations: [],
  };
  await using screen = await render(<WorkflowCanvas model={model} mode="edit" />);
  await expect.element(screen.getByText("Node 0")).toBeVisible();
  const dashed = document.querySelectorAll('[data-id="each"] svg path[stroke-dasharray="8 6"]');
  expect(dashed.length).toBeGreaterThan(0);
});
