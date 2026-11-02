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
