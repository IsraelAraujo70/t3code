import { AsyncResult } from "effect/reactivity";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  EnvironmentId,
  WorkflowId,
  WorkflowDocRevision,
  type WorkflowDocument,
} from "@t3tools/contracts";
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: vi.fn(() => vi.fn(async () => ({ _tag: "Success", value: {} }))),
}));
import { defaultNodeConfig } from "@t3tools/client-runtime/workflows";
import { WorkflowNode, type WorkflowDefinition, type WorkflowNodeKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../../test/render";
import { Inspector } from "./Inspector";

const decodeNode = Schema.decodeOption(WorkflowNode);

const decodeEnvironmentId = Schema.decodeSync(EnvironmentId);
const decodeWorkflowId = Schema.decodeSync(WorkflowId);
const decodeRevision = Schema.decodeSync(WorkflowDocRevision);

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

it("edits a cron trigger through the trigger schema", async () => {
  const onChange = vi.fn();
  const definition = {
    ...fixture(),
    triggers: { clock: { kind: "cron" as const, expr: "0 * * * *", tz: "UTC" } },
  };
  await using screen = await render(
    <Inspector
      definition={definition}
      selected="clock"
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={vi.fn()}
    />,
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "expr", exact: true }), "0 2 * * *");
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      triggers: { clock: { kind: "cron", expr: "0 2 * * *", tz: "UTC" } },
    }),
  );
});

it("hides the switch for manual triggers", async () => {
  await using screen = await render(
    <Inspector
      definition={{ ...fixture(), triggers: { manual: { kind: "manual" } } }}
      selected="manual"
      diagnostics={[]}
      readOnly={false}
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  expect(screen.getByRole("switch").elements()).toHaveLength(0);
  await expect.element(screen.getByText(/Run now opens the form/)).toBeVisible();
});

it("shows a saved webhook URL, edits its title and switches that trigger immediately", async () => {
  const command = vi.fn(async () => AsyncResult.success(undefined));
  vi.mocked(useAtomCommand).mockReturnValue(command);
  const onChange = vi.fn();
  const environmentId = decodeEnvironmentId("host");
  const document: WorkflowDocument = {
    workflowId: decodeWorkflowId("demo"),
    source: "",
    definition: { ...fixture(), triggers: { hook: { kind: "webhook" } } },
    revision: decodeRevision("a".repeat(40)),
    headCommit: null,
    hash: null,
    valid: true,
    dirty: false,
    diagnostics: [],
    enabled: true,
    suspended: false,
    updatedBy: null,
    updatedAt: null,
    triggers: [
      {
        id: "hook",
        kind: "webhook",
        title: null,
        label: "Webhook",
        webhookUrl: "https://example.test/hook",
        enabled: true,
        lastFiredAt: null,
      },
    ],
  };
  if (!document.definition) throw new Error("Missing definition");
  await using screen = await render(
    <Inspector
      environmentId={environmentId}
      document={document}
      definition={document.definition}
      selected="hook"
      diagnostics={[]}
      readOnly={false}
      onChange={onChange}
      onSelect={vi.fn()}
    />,
  );
  await expect
    .element(screen.getByText("https://example.test/hook", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "replayKey", exact: true }))
    .toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "title", exact: true }), "Issue event");
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ triggers: { hook: { kind: "webhook", title: "Issue event" } } }),
  );
  screen.getByRole("switch", { name: "On", exact: true }).element().focus();
  await userEvent.keyboard(" ");
  expect(command).toHaveBeenCalledWith({
    environmentId,
    input: {
      workflowId: document.workflowId,
      triggerId: "hook",
      enabled: false,
      clientRequestId: expect.any(String),
    },
  });
});
