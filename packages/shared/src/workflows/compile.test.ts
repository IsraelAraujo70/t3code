import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { WORKFLOW_DIAGNOSTIC_CODES, type WorkflowDiagnosticCode } from "@t3tools/contracts";

import { compileWorkflow } from "./compile.ts";
import { DEFAULT_HOST_LIMITS, type HostLimits } from "./types.ts";

const HOST: HostLimits = DEFAULT_HOST_LIMITS;

// The compiler takes unknown JSON; fixtures mutate it freely, invalid shapes included.
type Json = Record<string, any>;

/** A small valid workflow: an agent plans, a command checks, two honest ends. */
const base = (): Json => ({
  schema: "t3.workflow/v1",
  id: "demo",
  title: "Demo",
  home: { project: "t3code" },
  params: {
    base: { type: "string", default: "friend/main", pattern: "^[A-Za-z0-9._/-]+$" },
    note: { type: "string" },
  },
  budget: { steps: 10, wall: "2h", tokens: 100_000 },
  fatigue: { consecutiveFailures: 2 },
  models: {
    lead: { provider: "claude", model: "claude-opus-5-5" },
    sol: { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
  },
  workspaces: {
    integ: { project: "t3code", base: "{{params.base}}", branch: "wf/demo-{{run.id}}" },
  },
  nodes: {
    plan: {
      kind: "agent",
      model: "$lead",
      prompt: "Plan {{params.note}}",
      workspace: "integ",
      access: "write",
      output: { tag: { type: "string", pattern: "^v\\d+$" }, notes: { type: "string" } },
    },
    test: {
      kind: "command",
      argv: ["node", "scripts/check.ts", "{{nodes.plan.output.tag}}"],
      cwd: "integ",
      check: "exit == 0",
    },
    done: {
      kind: "output",
      status: "ready_for_review",
      value: { tag: "{{nodes.plan.output.tag}}" },
    },
    stuck: { kind: "output", status: "blocked", value: {} },
  },
  edges: ["plan -> test", "test:pass -> done", "test:fail -> stuck"],
});

const compile = (input: Json, host: HostLimits = HOST) => compileWorkflow(input, host);

const diagnosticsOf = (input: Json, host?: HostLimits) => {
  const result = compile(input, host);
  return Result.isFailure(result) ? result.failure : [];
};

interface FailingCase {
  readonly name: string;
  readonly code: WorkflowDiagnosticCode;
  readonly path: string;
  readonly change: (def: Json) => void;
  readonly host?: HostLimits;
}

const FAILING: ReadonlyArray<FailingCase> = [
  {
    name: "duplicate manual triggers",
    code: "trigger",
    path: "triggers.second",
    change: (def) => {
      def.triggers = { first: { kind: "manual" }, second: { kind: "manual" } };
    },
  },
  {
    name: "trigger collides with node",
    code: "trigger",
    path: "triggers.plan",
    change: (def) => {
      def.triggers = { plan: { kind: "manual" } };
    },
  },
  {
    name: "blank bot description",
    code: "trigger",
    path: "triggers.bot.description",
    change: (def) => {
      def.triggers = { bot: { kind: "bot", description: "   " } };
    },
  },
  {
    name: "callee has no call trigger",
    code: "trigger",
    path: "nodes.plan.workflow",
    host: { ...HOST, callTargets: new Map() },
    change: (def) => {
      def.nodes.plan = { kind: "call", workflow: "other", params: {} };
    },
  },
  {
    name: "callee refuses caller",
    code: "trigger",
    path: "nodes.plan.workflow",
    host: { ...HOST, callTargets: new Map([["other", { from: ["allowed"] }]]) },
    change: (def) => {
      def.nodes.plan = { kind: "call", workflow: "other", params: {} };
    },
  },
  {
    name: "a field of the wrong type",
    code: "schema",
    path: "nodes.plan.prompt",
    change: (d) => (d.nodes.plan.prompt = 3),
  },
  {
    name: "a field the schema does not have",
    code: "schema",
    path: "nodes.test.replay_mode",
    change: (d) => (d.nodes.test.replay_mode = "safe"),
  },
  {
    name: "a node id outside the pattern",
    code: "schema",
    path: "nodes.Plan2",
    change: (d) => (d.nodes.Plan2 = { kind: "gate", ask: "ok?" }),
  },
  {
    name: "an edge to a missing node",
    code: "unknown-node",
    path: "edges[3]",
    change: (d) => d.edges.push("done2 -> stuck"),
  },
  {
    name: "a workspace nobody declared",
    code: "unknown-node",
    path: "nodes.test.cwd",
    change: (d) => (d.nodes.test.cwd = "elsewhere"),
  },
  {
    name: "a loop back to an earlier node",
    code: "cycle",
    path: "edges",
    change: (d) => (d.edges = ["plan -> test", "test:pass -> done", "test:fail -> plan"]),
  },
  {
    name: "an output no edge reaches",
    code: "unreachable",
    path: "nodes.stuck",
    change: (d) => (d.edges = ["plan -> test", "test:pass -> done"]),
  },
  {
    name: "a port the node does not have",
    code: "port",
    path: "edges[1]",
    change: (d) => (d.edges[1] = "test:ok -> done"),
  },
  {
    name: "a gate expiring to a decision it does not offer",
    code: "port",
    path: "nodes.ask.expires.decision",
    change: (d) => {
      d.nodes.ask = { kind: "gate", ask: "go?", expires: { after: "1h", decision: "maybe" } };
      d.edges.push("test:fail -> ask");
    },
  },
  {
    name: "a check that does not parse",
    code: "expr",
    path: "nodes.test.check",
    change: (d) => (d.nodes.test.check = "exit =="),
  },
  {
    name: "a template that does not parse",
    code: "expr",
    path: "nodes.plan.prompt",
    change: (d) => (d.nodes.plan.prompt = "Plan {{ params.note "),
  },
  {
    name: "a hillclimb root outside a hillclimb",
    code: "template-root",
    path: "nodes.done.value.tag",
    change: (d) => (d.nodes.done.value.tag = "{{m.bench.ratio}}"),
  },
  {
    name: "a node that has not run yet",
    code: "template-root",
    path: "nodes.plan.prompt",
    change: (d) => (d.nodes.plan.prompt = "Plan after {{nodes.test.output}}"),
  },
  {
    name: "an undeclared param",
    code: "template-root",
    path: "nodes.plan.prompt",
    change: (d) => (d.nodes.plan.prompt = "{{params.missing}}"),
  },
  {
    name: "an agent output field without a pattern in argv",
    code: "untrusted-in-argv",
    path: "nodes.test.argv[3]",
    change: (d) => d.nodes.test.argv.push("{{nodes.plan.output.notes}}"),
  },
  {
    name: "a string param without a pattern in argv",
    code: "untrusted-in-argv",
    path: "nodes.test.argv[3]",
    change: (d) => d.nodes.test.argv.push("--note={{params.note}}"),
  },
  {
    name: "trigger data in a branch name",
    code: "untrusted-in-argv",
    path: "workspaces.integ.branch",
    change: (d) => (d.workspaces.integ.branch = "wf/{{trigger.text}}"),
  },
  {
    name: "privilege escalation",
    code: "forbidden-command",
    path: "nodes.test.argv",
    change: (d) => (d.nodes.test.argv = ["sudo", "systemctl", "restart", "t3-friend"]),
  },
  {
    name: "inline shell",
    code: "forbidden-command",
    path: "nodes.test.argv",
    change: (d) => (d.nodes.test.argv = ["bash", "-c", "echo hi"]),
  },
  {
    name: "an env name that changes how programs load",
    code: "forbidden-command",
    path: "nodes.test.env.LD_PRELOAD",
    change: (d) => (d.nodes.test.env = { LD_PRELOAD: "/tmp/x.so" }),
  },
  {
    name: "heavy around a command that calls heavy.sh",
    code: "heavy-nesting",
    path: "nodes.test.argv",
    change: (d) => {
      d.nodes.test.heavy = true;
      d.nodes.test.argv = ["/home/israel/.cache/t3-testdata/heavy.sh", "vp", "test"];
    },
  },
  {
    name: "heavy on a self-serializing command",
    code: "heavy-nesting",
    path: "nodes.test.argv",
    change: (d) => Object.assign(d.nodes.test, { heavy: true, selfSerializing: true }),
  },
  {
    name: "a family alias",
    code: "model-alias",
    path: "models.lead.model",
    change: (d) => (d.models.lead.model = "opus"),
  },
  {
    name: "a $model that only an object prototype has",
    code: "model-alias",
    path: "nodes.plan.model",
    change: (d) => (d.nodes.plan.model = "$constructor"),
  },
  {
    name: "a param that only an object prototype has",
    code: "template-root",
    path: "nodes.plan.prompt",
    change: (d) => (d.nodes.plan.prompt = "{{params.constructor}}"),
  },
  {
    name: "an unresolved $model",
    code: "model-alias",
    path: "nodes.plan.model",
    change: (d) => (d.nodes.plan.model = "$nobody"),
  },
  {
    name: "an arena judged by the lead's family",
    code: "judge-family",
    path: "nodes.duel.judge",
    change: (d) => {
      d.nodes.duel = {
        kind: "arena",
        task: "Propose",
        artifact: "proposal.md",
        runners: ["$lead", "$sol"],
        minCandidates: 1,
        judge: "$lead",
        rubric: ["smallest diff"],
        lead: "$lead",
        maxReruns: 0,
        workspace: { project: "t3code", base: "friend/main" },
      };
      d.edges.push("test:pass -> duel");
    },
  },
  {
    name: "more steps than the host allows",
    code: "budget-ceiling",
    path: "budget.steps",
    change: (d) => (d.budget.steps = 501),
  },
  {
    name: "tokensFrom without a reservation",
    code: "budget-ceiling",
    path: "nodes.test.tokenReservation",
    change: (d) => (d.nodes.test.tokensFrom = "usage.total"),
  },
  {
    name: "a timeout longer than the run",
    code: "budget-ceiling",
    path: "nodes.test.timeout",
    change: (d) => (d.nodes.test.timeout = "3h"),
  },
  {
    name: "a cron expression that does not parse",
    code: "trigger",
    path: "triggers.nightly.expr",
    change: (d) => (d.triggers = { nightly: { kind: "cron", expr: "61 * * * *", tz: "UTC" } }),
  },
  {
    name: "an unknown time zone",
    code: "trigger",
    path: "triggers.nightly.expr",
    change: (d) =>
      (d.triggers = { nightly: { kind: "cron", expr: "0 3 * * *", tz: "Mars/Olympus" } }),
  },
  {
    name: "a trigger id that is not a node-style id",
    code: "schema",
    path: "triggers.Go",
    change: (d) => (d.triggers = { Go: { kind: "cron", expr: "0 3 * * *", tz: "UTC" } }),
  },
  {
    name: "a workflow calling itself",
    code: "call-cycle",
    path: "nodes.again.workflow",
    change: (d) => {
      d.nodes.again = { kind: "call", workflow: "demo", params: {} };
      d.edges.push("test:fail -> again");
    },
  },
  {
    name: "a workflow called back by its callee",
    code: "call-cycle",
    path: "nodes.again.workflow",
    host: { ...HOST, callGraph: new Map([["other", ["demo"]]]) },
    change: (d) => {
      d.nodes.again = { kind: "call", workflow: "other", params: {} };
      d.edges.push("test:fail -> again");
    },
  },
  {
    name: "a card on a Linear project",
    code: "card-linear",
    path: "card.project",
    host: { ...HOST, linearLinkedProjects: new Set(["t3code"]) },
    change: (d) => (d.card = { project: "t3code" }),
  },
  {
    name: "a pattern on a json output field, which checkOutput would not enforce",
    code: "schema",
    path: "nodes.plan.output.data.pattern",
    change: (d) => {
      d.nodes.plan.output.data = { type: "json", pattern: "^v[0-9]+$" };
    },
  },
  {
    name: "a node named judge, which step keys reserve for acceptance",
    code: "schema",
    path: "nodes.judge",
    change: (d) => {
      d.nodes.judge = { kind: "output", status: "blocked", value: {} };
      d.edges.push("test:fail -> judge");
    },
  },
  {
    name: "a continuation that switches model",
    code: "thread-continue",
    path: "nodes.fixup.thread",
    change: (d) => {
      d.nodes.fixup = {
        kind: "agent",
        model: "$sol",
        prompt: "Fix it",
        workspace: "integ",
        access: "write",
        thread: "continue:plan",
      };
      d.edges.push("test:fail -> fixup");
    },
  },
  {
    name: "a continuation that switches access",
    code: "thread-continue",
    path: "nodes.fixup.thread",
    change: (d) => {
      d.nodes.fixup = {
        kind: "agent",
        model: "$lead",
        prompt: "Fix it",
        workspace: "integ",
        thread: "continue:plan",
      };
      d.edges.push("test:fail -> fixup");
    },
  },
  {
    name: "a post to the bot in a workflow that works for no bot",
    code: "bot",
    path: "nodes.done.postToBot",
    change: (d) => {
      d.nodes.done.report = "{{nodes.plan.output.notes}}";
      d.nodes.done.postToBot = true;
    },
  },
  {
    name: "a post to the bot from a map body, once per item",
    code: "bot",
    path: "nodes.each.body.nodes.say.postToBot",
    change: (d) => {
      d.bot = "b_trader";
      d.nodes.each = {
        kind: "map",
        items: "[1, 2]",
        maxItems: 2,
        concurrency: 1,
        body: {
          nodes: {
            say: {
              kind: "output",
              status: "no_change",
              value: {},
              report: "item",
              postToBot: true,
            },
          },
          edges: [],
        },
      };
      d.edges.push("test:fail -> each");
    },
  },
];

describe("compileWorkflow", () => {
  it("compiles a valid definition and hashes it", () => {
    const result = compile(base());
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.success.root.order).toEqual(["plan", "test", "done", "stuck"]);
    }
  });

  it("covers every diagnostic code with a failing case", () => {
    expect(new Set(FAILING.map((c) => c.code))).toEqual(new Set(WORKFLOW_DIAGNOSTIC_CODES));
  });

  it.each(FAILING)("refuses $name with $code at $path", ({ code, path, change, host }) => {
    const def = base();
    change(def);
    expect(diagnosticsOf(def, host)).toContainEqual(expect.objectContaining({ code, path }));
  });

  it("accepts a protected command: the engine gates it on Israel's approval when it runs", () => {
    const def = base();
    def.nodes.test.argv = ["git", "push", "origin", "HEAD:friend/main"];
    expect(diagnosticsOf(def)).toEqual([]);
  });

  it("keeps an outer map's taint when a nested map rebinds item", () => {
    const def = base();
    def.nodes.outer = {
      kind: "map",
      items: "trigger.data",
      as: "external",
      maxItems: 2,
      concurrency: 1,
      body: {
        nodes: {
          inner: {
            kind: "map",
            items: "nodes.test.output",
            maxItems: 2,
            concurrency: 1,
            body: {
              nodes: {
                run: {
                  kind: "command",
                  argv: ["node", "x.ts", "{{external.script}}"],
                  cwd: "integ",
                },
              },
              edges: [],
            },
          },
        },
        edges: [],
      },
    };
    def.edges.push("test:pass -> outer");
    expect(diagnosticsOf(def)).toContainEqual(
      expect.objectContaining({
        code: "untrusted-in-argv",
        path: "nodes.outer.body.nodes.inner.body.nodes.run.argv[2]",
      }),
    );
  });

  it("hashes an own __proto__ key like any other key", () => {
    const plain = base();
    const withProto = base();
    withProto.nodes.done.value = JSON.parse('{"__proto__": "changed"}');
    const a = compile(plain);
    const b = compile(withProto);
    expect(Result.isSuccess(a) && Result.isSuccess(b) && a.success.hash !== b.success.hash).toBe(
      true,
    );
  });

  it("keeps the hash when only the layout or the edge spacing changes", () => {
    const plain = compile(base());
    const laidOut = base();
    laidOut.canvas = { positions: { plan: { x: 10, y: 20 } }, annotations: [] };
    laidOut.edges = ["plan->test", "test : pass -> done", "test:fail->stuck"];
    const moved = compile(laidOut);
    expect(Result.isSuccess(plain) && Result.isSuccess(moved)).toBe(true);
    if (Result.isSuccess(plain) && Result.isSuccess(moved)) {
      expect(moved.success.hash).toBe(plain.success.hash);
      expect(moved.success.definition.edges).toEqual(base().edges);
    }
  });

  it("changes the hash when a semantic field changes", () => {
    const changed = base();
    changed.nodes.test.argv.push("--strict");
    const a = compile(base());
    const b = compile(changed);
    expect(Result.isSuccess(a) && Result.isSuccess(b) && a.success.hash !== b.success.hash).toBe(
      true,
    );
  });

  it("lets a map body read its item and the outer nodes, and taints argv through the item", () => {
    const def = base();
    def.nodes.each = {
      kind: "map",
      items: "nodes.plan.output.notes",
      maxItems: 3,
      concurrency: 1,
      body: {
        nodes: {
          note: {
            kind: "agent",
            model: "$sol",
            prompt: "{{item}} after {{nodes.plan.output.tag}}",
            workspace: "integ",
          },
          echo: { kind: "command", argv: ["node", "scripts/echo.ts", "{{item}}"], cwd: "integ" },
        },
        edges: ["note -> echo"],
      },
      collect: { said: "{{nodes.note.output}}" },
    };
    def.edges.push("test:pass -> each");
    expect(diagnosticsOf(def)).toEqual([
      expect.objectContaining({
        code: "untrusted-in-argv",
        path: "nodes.each.body.nodes.echo.argv[2]",
      }),
    ]);
  });
});
