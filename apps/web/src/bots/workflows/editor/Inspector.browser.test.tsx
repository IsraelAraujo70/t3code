import { defaultNodeConfig } from "@t3tools/client-runtime/workflows";
import {
  WorkflowDocRevision,
  WorkflowId,
  WorkflowNode,
  type WorkflowDefinition,
  type WorkflowNodeKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../../test/render";
import { Inspector } from "./Inspector";

const decodeNode = Schema.decodeOption(WorkflowNode);
const workflowId = Schema.decodeSync(WorkflowId)("demo");
const revision = Schema.decodeSync(WorkflowDocRevision);

function fixture(): WorkflowDefinition {
  return {
    schema: "t3.workflow/v1",
    id: "demo",
    title: "Demo",
    home: { project: "demo" },
    budget: { steps: 10, wall: "1h", tokens: 1000 },
    fatigue: { consecutiveFailures: 3 },
    nodes: {
      start: { kind: "command", argv: ["true"], cwd: "work" },
      done: { kind: "output", status: "no_change", value: {} },
    },
    edges: ["start -> done"],
  };
}

it("renames a node, rewrites edges and selects the new id only on commit", async () => {
  const onChange = vi.fn();
  const onSelect = vi.fn();
  await using screen = await render(
    <Inspector
      definition={fixture()}
      selected="start"
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={onSelect}
    />,
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "id", exact: true }), "build");
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      edges: ["build -> done"],
      nodes: { build: fixture().nodes.start, done: fixture().nodes.done },
    }),
  );
  expect(onSelect).toHaveBeenCalledWith("build");
});

it("rejects invalid JSON and invalid schema edits without changing the definition", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <Inspector
      definition={fixture()}
      selected="start"
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={vi.fn()}
    />,
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "env", exact: true }), "{");
  await userEvent.tab();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Invalid JSON for env.");
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.fill(screen.getByRole("textbox", { name: "env", exact: true }), '{"HOME": 2}');
  await userEvent.tab();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Invalid value for env. Check the node schema.");
  expect(onChange).not.toHaveBeenCalled();
});

it("commits command argv as separate arguments on blur", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <Inspector
      definition={fixture()}
      selected="start"
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={vi.fn()}
    />,
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "argv", exact: true }),
    "node\nscript.mjs\na b",
  );
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      nodes: expect.objectContaining({
        start: { ...fixture().nodes.start, argv: ["node", "script.mjs", "a b"] },
      }),
    }),
  );
});

it("rejects duplicate ids across nested levels and clears selection after delete", async () => {
  const definition = fixture();
  const onChange = vi.fn();
  const onSelect = vi.fn();
  const nested: WorkflowDefinition = {
    ...definition,
    nodes: {
      ...definition.nodes,
      loop: {
        kind: "loop",
        max: 1,
        until: "true",
        body: { nodes: { taken: { kind: "gate", ask: "Go?" } }, edges: [] },
      },
    },
  };
  await using screen = await render(
    <Inspector
      definition={nested}
      selected="start"
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={onSelect}
    />,
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "id", exact: true }), "taken");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("A node with this id already exists.");
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Delete node" }));
  expect(onChange.mock.calls[0]?.[0].edges).toEqual([]);
  expect(onChange.mock.calls[0]?.[0].nodes.start).toBeUndefined();
  expect(onSelect).toHaveBeenCalledWith(null);
});

it("validates workflow settings and disables node edits in read-only mode", async () => {
  const onChange = vi.fn();
  const definition = fixture();
  await using screen = await render(
    <Inspector
      definition={definition}
      selected={null}
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={vi.fn()}
    />,
  );
  await userEvent.fill(screen.getByRole("spinbutton", { name: "budget.steps" }), "0");
  await userEvent.tab();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Invalid value for budget.steps. Check the workflow schema.");
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.fill(screen.getByRole("textbox", { name: "home.project" }), "other");
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith({ ...definition, home: { project: "other" } });
  await screen.rerender(
    <Inspector
      definition={definition}
      selected="start"
      diagnostics={[]}
      readOnly={true}
      onChange={onChange}
      onSelect={vi.fn()}
    />,
  );
  await expect.element(screen.getByRole("textbox", { name: "argv", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Delete node" })).toBeDisabled();
});

it("renders every node kind with a schema-valid default and nested diagnostics", async () => {
  const kinds: readonly WorkflowNodeKind[] = [
    "agent",
    "command",
    "gate",
    "branch",
    "output",
    "call",
    "map",
    "loop",
    "hillclimb",
    "arena",
    "graph",
    "interrogate",
  ];
  const definition = fixture();
  await using screen = await render(
    <Inspector
      definition={definition}
      selected="start"
      diagnostics={[]}
      readOnly={false}
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  for (const kind of kinds) {
    const node = defaultNodeConfig(kind);
    expect(Option.isSome(decodeNode(node))).toBe(true);
    await screen.rerender(
      <Inspector
        definition={{ ...definition, nodes: { start: node } }}
        selected="start"
        diagnostics={[]}
        readOnly={false}
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await expect.element(screen.getByRole("heading", { name: `${kind} · start` })).toBeVisible();
  }
  await screen.rerender(
    <Inspector
      definition={{
        ...definition,
        nodes: {
          outer: {
            kind: "loop",
            max: 1,
            until: "true",
            body: { nodes: definition.nodes, edges: definition.edges },
          },
        },
      }}
      selected="start"
      diagnostics={[
        { path: "nodes.outer.body.nodes.start.argv", code: "schema", message: "Nested issue" },
        { path: "nodes.start_other.argv", code: "schema", message: "Other issue" },
      ]}
      readOnly={false}
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  await expect.element(screen.getByText(/Nested issue/)).toBeVisible();
  await expect.element(screen.getByText(/Other issue/)).not.toBeInTheDocument();
});

it("keeps disk source separate from canvas edits and saves edited text with its message", async () => {
  const { SourceTab } = await import("./SourceTab");
  const document = {
    workflowId,
    revision: revision("a".repeat(40)),
    source: "title: Disk",
    definition: fixture(),
    headCommit: null,
    hash: null,
    valid: false,
    dirty: true,
    diagnostics: [{ path: "title", code: "schema" as const, message: "Disk issue" }],
    enabled: true,
    suspended: false,
    updatedBy: null,
    updatedAt: null,
  };
  const onSave = vi.fn();
  await using screen = await render(
    <SourceTab document={document} hasDraft={true} saving={false} onSave={onSave} />,
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Workflow source" }))
    .toHaveValue("title: Disk");
  await expect.element(screen.getByRole("button", { name: "Save source" })).toBeDisabled();
  await expect
    .element(
      screen.getByText("Your canvas edits are not in this text; save or discard them first."),
    )
    .toBeVisible();
  await screen.rerender(
    <SourceTab document={document} hasDraft={false} saving={false} onSave={onSave} />,
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "Workflow source" }), "title: Fixed");
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Source commit message" }),
    "Fix source",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save source" }));
  expect(onSave).toHaveBeenCalledWith("title: Fixed", "Fix source");
});
