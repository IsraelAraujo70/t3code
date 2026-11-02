import * as Schema from "effect/Schema";
import { WorkflowId, WorkflowDocRevision, EnvironmentId } from "@t3tools/contracts";
import {
  type WorkflowDefinition,
  type WorkflowDocument,
  type WorkflowSaveInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../../test/render";
import { WorkflowEditorView } from "./WorkflowEditorView";
const environmentId = Schema.decodeSync(EnvironmentId)("host");

const workflowId = Schema.decodeSync(WorkflowId)("demo");
const revision = Schema.decodeSync(WorkflowDocRevision);

function fixture(): WorkflowDocument {
  const definition: WorkflowDefinition = {
    schema: "t3.workflow/v1",
    id: "demo",
    title: "Demo",
    home: { project: "demo" },
    budget: { steps: 10, wall: "1h", tokens: 1000 },
    fatigue: { consecutiveFailures: 3 },
    nodes: {
      start: { kind: "gate", title: "Review", ask: "Continue?" },
      done: { kind: "output", status: "no_change", value: {} },
    },
    edges: ["start:approve -> done", "start:reject -> done"],
  };
  return {
    workflowId: workflowId,
    source: "schema: t3.workflow/v1",
    definition,
    revision: revision("a".repeat(40)),
    headCommit: null,
    hash: null,
    valid: true,
    dirty: false,
    diagnostics: [],
    enabled: true,
    suspended: false,
    updatedBy: null,
    updatedAt: null,
  };
}

it("merges the added gate with the remote title and saves against its revision", async () => {
  const document = fixture();
  if (!document.definition) throw new Error("Missing fixture definition");
  const current: WorkflowDocument = {
    ...document,
    revision: revision("b".repeat(40)),
    updatedBy: "Ralph",
    definition: {
      ...document.definition,
      nodes: {
        ...document.definition.nodes,
        start: { kind: "gate", title: "Remote review", ask: "Continue?" },
      },
    },
  };
  const save = vi.fn(async (_input: WorkflowSaveInput) => ({
    ok: true as const,
    result: { _tag: "Conflict" as const, workflowId: workflowId, base: null, current },
  }));
  await using screen = await render(
    <WorkflowEditorView environmentId={environmentId} document={document} save={save} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add gate", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await expect.element(screen.getByText("Changed by Ralph while you edited.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Merge", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await vi.waitFor(() => {
    expect(save).toHaveBeenCalledTimes(2);
    const input = save.mock.calls[1]?.[0];
    expect(input?.baseRevision).toBe(current.revision);
    expect(input && "definition" in input ? input.definition.nodes : null).toMatchObject({
      start: { title: "Remote review" },
      gate: { kind: "gate" },
    });
  });
});

it("overwrites an invalid file with the draft and the current disk revision", async () => {
  const document = fixture();
  const current: WorkflowDocument = {
    ...document,
    revision: revision("b".repeat(40)),
    definition: null,
    valid: false,
    dirty: true,
  };
  const save = vi.fn(async (_input: WorkflowSaveInput) => ({
    ok: true as const,
    result: { _tag: "Conflict" as const, workflowId: workflowId, base: null, current },
  }));
  await using screen = await render(
    <WorkflowEditorView environmentId={environmentId} document={document} save={save} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add gate", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await expect.element(screen.getByText(/The file on disk was changed by hand/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Overwrite", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await vi.waitFor(() => {
    expect(save).toHaveBeenCalledTimes(2);
    const input = save.mock.calls[1]?.[0];
    expect(input?.baseRevision).toBe(current.revision);
    const first = save.mock.calls[0]?.[0];
    expect(input && "definition" in input ? input.definition : null).toEqual(
      first && "definition" in first ? first.definition : null,
    );
    expect(input && "definition" in input ? input.definition.nodes.gate?.kind : null).toBe("gate");
  });
});

it("opening a workflow leaves nothing to save", async () => {
  const save = vi.fn();
  await using screen = await render(
    <div style={{ width: 1200, height: 800 }}>
      <WorkflowEditorView environmentId={environmentId} document={fixture()} save={save} />
    </div>,
  );
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(1),
  );
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(screen.getByText("Unsaved").elements()).toHaveLength(0);
});

it("keeps Source text across tabs and overwrites a changed file only when asked", async () => {
  const document = fixture();
  const current: WorkflowDocument = {
    ...document,
    revision: revision("c".repeat(40)),
    updatedBy: "Ralph",
  };
  const save = vi.fn(async (_input: WorkflowSaveInput) => ({
    ok: true as const,
    result: { _tag: "Conflict" as const, workflowId, base: null, current },
  }));
  await using screen = await render(
    <WorkflowEditorView environmentId={environmentId} document={document} save={save} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Source", exact: true }));
  await userEvent.fill(screen.getByRole("textbox", { name: "Workflow source" }), "title: Mine");
  await userEvent.click(screen.getByRole("button", { name: "Canvas", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Source", exact: true }));
  await expect
    .element(screen.getByRole("textbox", { name: "Workflow source" }))
    .toHaveValue("title: Mine");
  await userEvent.click(screen.getByRole("button", { name: "Save source" }));
  await expect.element(screen.getByText(/while you edited the source/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Overwrite", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Save source" }));
  await vi.waitFor(() => {
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      baseRevision: document.revision,
      source: "title: Mine",
    });
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      baseRevision: current.revision,
      source: "title: Mine",
    });
  });
});
