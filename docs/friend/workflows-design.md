# Workflows no fork friend: desenho

Status: proposta para o Israel aprovar. Nada da feature foi implementado. Esta branch tem só este documento e os protótipos descartáveis do canvas em [`prototypes/workflows-canvas/`](../../prototypes/workflows-canvas/RESULTS.md).

Um workflow é um processo de agentes com vários passos que roda sozinho, disparado por horário, webhook, pedido de bot ou evento interno. Ele serve sobretudo às rotinas de auto-melhoria (RSI) da madrugada: merge do upstream, hillclimb do computer use, corte de tokens dos MCPs e qualidade a partir das correções do Israel.

Os caminhos de código citados são relativos à raiz do repositório, no commit `80da99c43`.

---

## 0. Decisões que sustentam o desenho

1. **Uma tabela é a verdade.** Cada execução é um journal só de inserção em `bots.sqlite` (`workflow_facts`, com `UNIQUE(stream, key)`). Gravar o mesmo fato duas vezes não faz nada. Listas e telas leem caches reconstruíveis a partir do journal.
2. **A decisão é uma função pura.** `decide(workflow, estado, contexto) -> Intent[]` não faz I/O, como o `Orchestrator` do upstream. Um interpretador fino executa cada intent com uma chave determinística: o `commandId` do `ThreadLaunchService`, o nome da unit do systemd, o compare-and-swap de uma ref git. A retomada depois de um restart cabe numa frase: dobrar o journal, reexecutar os intents gravados sem resultado, religar os sensores e decidir de novo.
3. **Cada passo de agente é uma thread T3 comum**, lançada com `ThreadLaunchService.launch` (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:838`). Ela acompanha a continuação de restart que o upstream já faz (`ThreadManagementService.ts:845-894`). O motor nunca manda o próprio "continue".
4. **hillclimb, arena, graph e interrogate são tipos nativos de nó**, cada um com sub-estado tipado e sub-decisor puro. Todos executam pelos mesmos três executores (turno de agente, comando, operação git), então o crash e a retomada são os mesmos para tudo.
5. **O arquivo é a fonte da verdade.** Cada workflow é um `<id>.workflow.yaml` num repositório git do host de bots. Canvas, bot (MCP) e edição à mão passam pelo mesmo compilador e viram commit. Uma edição à mão aparece no canvas aberto. Cada execução fixa o commit e o hash semântico da versão.
6. **Ação proibida não é questão de prompt.** Cada sessão de provider e cada comando roda num container Docker, no molde do sandbox que o fork já usa em produção para os bots de guest. O container não vê nada do host, fica numa rede interna cuja única saída é um proxy que aceita só endereço público e põe as credenciais dos providers, então ele não tem segredo nenhum. O host nunca vê os dados de um passo: o caminho que o servidor usa como cwd é um diretório vazio e imutável, e o container monta um volume nesse mesmo caminho. Código entra e sai só por bundle git verificado. Só o motor empurra uma branch `wf/…` e abre o PR em rascunho. Merge na `friend/main`, deploy, restart e force push não existem como ação do motor. A comparação com a alternativa de usuário Unix próprio com `bwrap` está na §9.6.
7. **Gatilhos reaproveitam o que existe.** O webhook vira uma `ScheduledTask` (URL, HMAC, filtros, dedupe e URL pública prontos). O cron com fuso usa o `Scheduler` compartilhado com `effect/Cron`. A `ScheduledTask` não tem cron nem fuso.
8. **Poucas seams.** São nove arquivos do upstream e sete deles já são seams hoje. A única lógica de servidor nova num arquivo do upstream é o gancho e o guard das tasks de webhook no `ScheduledTaskService`.
9. **Canvas: React Flow com traço desenhado à mão via roughjs.** Os dois são MIT. O pedaço preguiçoso tem 65 KiB gzip, contra 2,4 MiB do Excalidraw. A biblioteca já impede seta solta. O tldraw ficou de fora pela licença.

### 0.1 Como se usa

> **Workflows** rodam no host de bots. Cada workflow é um arquivo YAML num repositório git do host (Settings → Bots → Workflows mostra o caminho). Abra **Workflows** na barra lateral para desenhar um no canvas, comece de um modelo pronto (merge do upstream, hillclimb do computer use, corte de tokens MCP, correções viram enforcement) ou peça a um bot: "monta um workflow que…". Cada save vira commit, e cada execução usa a versão exata com que começou. A tela da execução mostra cada passo ao vivo: thread, tokens, custo estimado e, nos blocos, o estado deles (rodada do hillclimb, melhor métrica, rodadas sem ganho). Portões mandam push para o celular e são aprovados na tela da execução. Bots criam, editam, validam, rodam e listam workflows, mas nunca aprovam portão. Workflows nunca mergeiam na `friend/main`, nunca fazem force push, deploy ou restart. Eles terminam num PR em rascunho ou num relatório, mais o comando que você roda.

Três chamadas reais:

```ts
// 1. Um bot rascunha e roda (ferramentas MCP, §6)
workflow_save({ source: yaml, dryRun: true });
// → { ok: false, diagnostics: [{ path: "nodes.climb.measure.bench.argv", code: "heavy-nesting",
//      message: "run.py já usa heavy.sh por episódio; troque heavy por selfSerializing" }] }
workflow_save({ source: fixedYaml, message: "hillclimb noturno do argo35" });
// → { ok: true, workflowId: "argo35-hillclimb", revision: "4be1…", commit: "9f3c…", diagnostics: [] }
workflow_run({ workflowId: "argo35-hillclimb", params: { reps: 3 }, clientRequestId: "try-1" });
// → { runId: "wfr_5c1e…", status: "running", link: "t3-workflow-run://v1/wfr_5c1e…" }

// 2. O canvas salva uma edição (web/desktop)
const doc = useAtomValue(workflowDocumentAtom({ environmentId, workflowId })); // stream
const edited = fromCanvasModel(adapter.toModel(scene), doc.definition); // grafo estrito + diagnósticos
const r = await save({
  workflowId,
  baseRevision: doc.revision,
  definition: edited.definition,
  canvas: edited.canvas,
  message: "seams antes dos testes",
});
if (r._tag === "Conflict") openMerge(mergeDocuments(r.base, edited, r.current));

// 3. O motor depois de um restart do t3-friend.service (camada do fork, só no host de bots)
const start = Effect.gen(function* () {
  const scheduler = yield* Scheduler;
  yield* scheduler.register("workflows", engine.tick); // só ativa depois da recuperação do upstream
  // tick: promove TriggerFired órfãos e, por execução viva, RunActor.start(runId), que dobra o journal,
  // reexecuta intents pendentes com as mesmas chaves, liga os sensores (waitForThread, exit.json)
  // e volta ao laço decide → gravar → executar.
});
```

---

## 1. Tipos e contrato

Arquivos novos do fork: `packages/contracts/src/workflows.ts` (schemas, RPCs e escopos), reexportado por `packages/contracts/src/bots.ts`, que já é do fork (o `index.ts` já exporta `bots`), e `packages/shared/src/workflows/` (compilador puro: expressões, templates, grafo, `classifyCommand`), atrás do export `@t3tools/shared/workflows`. Servidor, canvas e Android precisam validar exatamente igual, e uma segunda cópia seria uma lista sincronizada à mão. O compilador fica em `shared` e não em `contracts` porque o AGENTS.md reserva `contracts` para schemas.

### 1.1 Identidades

```ts
import * as Schema from "effect/Schema";

const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
export const WorkflowId = Schema.String.check(Schema.isPattern(SLUG)).pipe(
  Schema.brand("WorkflowId"),
);
export const NodeId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,40}$/)).pipe(
  Schema.brand("WorkflowNodeId"),
);
export const RunId = Schema.String.check(Schema.isPattern(/^wfr_[a-f0-9]{20}$/)).pipe(
  Schema.brand("WorkflowRunId"),
);
/** sha256 do JSON canônico da definição sem `canvas`. É o que decide se a execução muda. */
export const SemanticHash = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)).pipe(
  Schema.brand("WorkflowHash"),
);
/** sha do blob git do arquivo inteiro, layout incluído. É a pré-condição de cada save. */
export const DocRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)).pipe(
  Schema.brand("WorkflowDocRevision"),
);
/** Caminho de uma instância de passo: `merge`, `each[2]/design`, `climb/r4/generate`. Entra em toda chave de idempotência. */
export const StepKey = Schema.String.check(Schema.isPattern(/^[a-z0-9_\[\]\/]{1,200}$/)).pipe(
  Schema.brand("WorkflowStepKey"),
);
/** O motor só cria ou move branches `wf/…`. `friend/main` não decodifica. */
export const WfBranch = Schema.String.check(Schema.isPattern(/^wf\/[A-Za-z0-9._\/-]{1,120}$/)).pipe(
  Schema.brand("WfBranch"),
);
export const LedgerId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9\-\/]{0,80}$/)).pipe(
  Schema.brand("WorkflowLedgerId"),
);
export const DurationText = Schema.String.check(Schema.isPattern(/^\d+(s|m|h)$/));
/** `{{ expr }}` dentro de texto. Compilado para AST, nunca `eval`. */
export const Template = Schema.String.check(Schema.isMaxLength(40_000));
export const ExprText = Schema.String.check(Schema.isMaxLength(2_000));
```

### 1.2 Definição (o que o YAML decodifica)

````ts
/** A definição escolhe provider e modelo, nunca a instância. O servidor resolve para a instância
 *  do perfil de execução (§9.5). Assim nenhuma definição consegue um agente sem sandbox. */
export const ModelRef = Schema.Struct({
  provider: Schema.Literals(["codex", "claude"]),
  model: TrimmedNonEmptyString, // id exato: gpt-6.1-sol, claude-opus-5-5, claude-haiku-5-5
  effort: Schema.optional(Schema.Literals(["low", "medium", "high", "xhigh", "max"])),
});
export const ModelUse = Schema.Union([
  ModelRef,
  Schema.String.check(Schema.isPattern(/^\$[a-z_]+$/)),
]); // `$lead` → models.lead

export const FieldSpec = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean", "string[]", "number[]", "json"]),
  pattern: Schema.optional(Schema.String), // campo com pattern é "seguro" para argv
  optional: Schema.optional(Schema.Boolean),
});
/** Saída estruturada: o agente termina com um bloco ```json; o comando imprime JSON. */
export const OutputShape = Schema.Record(Schema.String, FieldSpec);

export const ParamSpec = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean"]),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  pattern: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

/** Checkout que o motor cria (único jeito de ganhar um): worktree do clone da execução em
 *  no volume de execuções, no caminho do placeholder `~/.t3/workflows/cwd/<runId>/<nome>` (§9.5); a branch renderiza para `wf/…`. */
export const WorkspaceDecl = Schema.Struct({
  project: Template,
  base: Template, // ref, ou "workspace:<nome>" para partir do HEAD de outro
  branch: Template,
  // o que sobra quando a execução acaba; depois, a árvore toda sai em 7 dias, menos `always` e worktree com PR aberto
  retain: Schema.optional(Schema.Literals(["always", "on_failure", "never"])), // padrão on_failure
});
export const WorkspaceUse = Schema.Union([
  Schema.String, // nome em `workspaces` ou exportado por bloco (`climb.best`)
  // checkout destacado e descartável do clone da execução, no sha fixado do projeto; o que for escrito nele se perde
  Schema.Struct({ project: Template, readOnly: Schema.Literal(true) }),
]);

/** Check de aceitação de um passo de agente. Quem roda é o motor, nunca o próprio agente:
 *  um comando no perfil, na worktree do passo, ou um turno de juiz (thread nova, só leitura). */
export const AcceptSpec = Schema.Union([
  Schema.Struct({
    argv: Schema.NonEmptyArray(Template),
    check: ExprText,
    heavy: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ judge: ModelUse, criterion: Template }), // saída do juiz: { pass: boolean, reason: string }
]);

export const RetryPolicy = Schema.Struct({
  max: NonNegativeInt,
  on: Schema.Array(Schema.Literals(["failed", "lost", "timed_out"])),
  backoff: Schema.optional(DurationText),
});
/** Dedupe entre execuções: o passo é pulado se `key` já está no ledger. */
export const OnceSpec = Schema.Struct({ ledger: LedgerId, key: Template });

const NodeCommon = {
  title: Schema.optional(Schema.String),
  timeout: Schema.optional(DurationText),
  retry: Schema.optional(RetryPolicy),
  join: Schema.optional(Schema.Literals(["all", "any"])), // fan-in; padrão all
  when: Schema.optional(ExprText), // guarda; falso → skipped
  once: Schema.optional(OnceSpec),
  continueOnFail: Schema.optional(Schema.Boolean),
};

export const AgentNode = Schema.Struct({
  kind: Schema.Literal("agent"),
  ...NodeCommon,
  model: ModelUse,
  prompt: Template,
  workspace: WorkspaceUse,
  // "new" (padrão) ou "continue:<nodeId>". Uma thread tem um só acesso e uma só worktree a vida toda:
  // o compilador só aceita continue com o mesmo workspace e o mesmo access.
  thread: Schema.optional(Schema.String),
  access: Schema.optional(Schema.Literals(["read", "write"])), // read = worktree descartável; padrão read
  output: Schema.optional(OutputShape),
  accept: Schema.optional(AcceptSpec), // portas pass/fail; a evidência é o que o motor rodou
  tokenReservation: Schema.optional(PositiveInt), // reserva de orçamento (§9.1)
  askIsrael: Schema.optional(Schema.Boolean), // pergunta do agente vira portão; senão é recusada com instrução
});

export const CommandNode = Schema.Struct({
  kind: Schema.Literal("command"),
  ...NodeCommon,
  argv: Schema.NonEmptyArray(Template), // sem shell
  cwd: WorkspaceUse,
  heavy: Schema.optional(Schema.Boolean), // embrulha em heavy.sh
  selfSerializing: Schema.optional(Schema.Boolean), // o comando chama heavy.sh sozinho (run.py do bench)
  replay: Schema.optional(Schema.Literals(["safe", "never"])), // padrão never (§3.4)
  parse: Schema.optional(Schema.Literals(["none", "json", "json-last-line"])),
  output: Schema.optional(OutputShape),
  check: Schema.optional(ExprText), // vira check: portas pass/fail por predicado sobre {exit, out}
  tokensFrom: Schema.optional(Schema.String), // caminho JSON em `out` que cobra o orçamento (evals pagos)
  tokenReservation: Schema.optional(PositiveInt), // obrigatório com tokensFrom; vai para WF_TOKEN_BUDGET
  env: Schema.optional(Schema.Record(Schema.String, Template)), // só nomes permitidos
});

/** Tarefa do host, fora do sandbox: só um nome do registro fechado em apps/server/src/bots/workflows/hostTasks/.
 *  Sem argv nem cwd: o código é o do próprio servidor (§9.5). */
export const HostTaskNode = Schema.Struct({
  kind: Schema.Literal("host"),
  ...NodeCommon,
  task: Schema.Literals(["extract-corrections"]),
  output: Schema.optional(OutputShape),
});

export const GateNode = Schema.Struct({
  kind: Schema.Literal("gate"),
  ...NodeCommon,
  ask: Template,
  options: Schema.optional(Schema.Array(Schema.String)), // padrão ["approve", "reject"]
  expires: Schema.optional(Schema.Struct({ after: DurationText, decision: Schema.String })),
});

export const BranchNode = Schema.Struct({
  kind: Schema.Literal("branch"),
  ...NodeCommon,
  cases: Schema.Array(Schema.Struct({ port: NodeId, when: ExprText })), // primeiro que casa
  else: Schema.optional(NodeId),
});

/** Fim honesto: o status diz o que aconteceu. `pullRequest` é a única publicação que existe.
 *  No nível de cima, termina a execução. Dentro do corpo de um `map` ou `loop`, termina só aquela
 *  instância do corpo: o valor vira o resultado do item e o PR, se houver, é aberto. */
export const OutputNode = Schema.Struct({
  kind: Schema.Literal("output"),
  ...NodeCommon,
  status: Schema.Literals([
    "no_change",
    "ready_for_review",
    "no_gain",
    "rejected",
    "checks_failed",
    "blocked",
    "proposals",
  ]),
  value: Schema.Record(Schema.String, Template),
  report: Schema.optional(Template), // markdown mostrado na execução e no push
  pullRequest: Schema.optional(
    Schema.Struct({
      // o motor empurra a WfBranch (sem force) e abre PR em rascunho
      workspace: Schema.String,
      base: Template,
      title: Template,
      body: Template,
    }),
  ),
  handoff: Schema.optional(Template), // o comando que o Israel roda (merge, deploy, restart)
  promote: Schema.optional(Schema.Struct({ ledger: LedgerId, sha: Template })), // marca a entrada desse sha como validated
  notify: Schema.optional(Schema.Boolean),
});

export const CallNode = Schema.Struct({
  kind: Schema.Literal("call"),
  ...NodeCommon,
  workflow: WorkflowId, // fixado no hash da versão quando a execução pai começa
  params: Schema.Record(Schema.String, Template),
});

export interface WorkflowGraph {
  readonly nodes: Readonly<Record<string, WorkflowNode>>;
  /** "a -> b", "check:fail -> fix", "route:conflicts -> repair". */
  readonly edges: ReadonlyArray<string>;
}
export const MapNode = Schema.Struct({
  kind: Schema.Literal("map"),
  ...NodeCommon,
  items: ExprText,
  as: NodeId,
  maxItems: PositiveInt,
  concurrency: PositiveInt,
  body: WorkflowGraph,
  collect: Schema.optional(Schema.Record(Schema.String, Template)),
});
export const LoopNode = Schema.Struct({
  kind: Schema.Literal("loop"),
  ...NodeCommon,
  body: WorkflowGraph,
  until: ExprText,
  max: PositiveInt, // max obrigatório
});
````

Os blocos de primeira classe (detalhe em §4):

```ts
/** Os filhos de um bloco usam os mesmos campos dos nós comuns, sem os de grafo. */
const AgentSpec = AgentNode.mapFields(
  ({ kind, when, once, join, continueOnFail, ...rest }) => rest,
);
const CommandSpec = CommandNode.mapFields(
  ({ kind, when, once, join, continueOnFail, ...rest }) => rest,
);
const BlockBudget = Schema.Struct({
  iterations: Schema.optional(PositiveInt),
  wall: Schema.optional(DurationText),
  tokens: Schema.optional(PositiveInt),
});

export const HillclimbNode = Schema.Struct({
  kind: Schema.Literal("hillclimb"),
  ...NodeCommon,
  workspace: Schema.Struct({ project: Template, base: Template }), // branches: wf/<run>/<node>/…
  ledger: LedgerId, // sobrevive entre execuções: nenhuma tentativa se repete
  generator: AgentSpec, // turno 1 propõe {key, mechanism, rationale}; turno 2 implementa e commita
  build: Schema.optional(CommandSpec.mapFields((f) => ({ ...f, artifact: Template }))),
  measure: Schema.Record(Schema.String, CommandSpec), // cada um imprime JSON com números; saídas em `m.<nome>`
  objective: Schema.Struct({ expr: ExprText, direction: Schema.Literals(["max", "min"]) }),
  keep: ExprText, // aceita o candidato sobre o melhor atual
  target: ExprText, // barra pré-registrada, avaliada só numa medição de confirmação contra a origem
  confirmWhen: Schema.optional(ExprText),
  plateau: Schema.Struct({ rounds: PositiveInt }),
  budget: BlockBudget,
});

export const ArenaNode = Schema.Struct({
  kind: Schema.Literal("arena"),
  ...NodeCommon,
  task: Template,
  artifact: Template,
  runners: Schema.NonEmptyArray(ModelUse), // N = tamanho
  minCandidates: PositiveInt,
  judge: ModelUse, // compilador: família(judge) ≠ família(lead)
  rubric: Schema.NonEmptyArray(Schema.String), // 3 a 6 critérios; só o juiz vê
  lead: ModelUse,
  verify: Schema.optional(CommandSpec),
  maxReruns: NonNegativeInt,
  workspace: Schema.Struct({ project: Template, base: Template }),
});

export const GraphNode = Schema.Struct({
  kind: Schema.Literal("graph"),
  ...NodeCommon,
  goal: Template,
  lead: ModelUse,
  leaf: ModelUse,
  workspace: Schema.Struct({ project: Template, base: Template }),
  finalChecks: Schema.Array(CommandSpec),
  reworkCap: PositiveInt,
  maxLeaves: PositiveInt,
  maxParallel: PositiveInt,
});

export const InterrogateNode = Schema.Struct({
  kind: Schema.Literal("interrogate"),
  ...NodeCommon,
  target: Schema.Struct({ workspace: Schema.String, baseRef: Template }),
  intent: Template,
  mode: Schema.Literals(["loop", "panel"]),
  reviewers: Schema.NonEmptyArray(ModelUse), // loop: [sol@high]; painel: [sol@high, opus]
  lead: ModelUse,
  checks: Schema.Array(CommandSpec),
  rounds: PositiveInt, // 3; 5 só quando declarado
});

export const WorkflowNode = Schema.Union([
  AgentNode,
  CommandNode,
  HostTaskNode,
  GateNode,
  BranchNode,
  OutputNode,
  CallNode,
  MapNode,
  LoopNode,
  HillclimbNode,
  ArenaNode,
  GraphNode,
  InterrogateNode,
]);
```

Gatilhos, orçamento, layout e a definição inteira:

```ts
const TriggerCommon = {
  id: NodeId,
  params: Schema.optional(Schema.Record(Schema.String, Template)),
};
export const WorkflowTrigger = Schema.Union([
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("cron"),
    expr: Schema.String,
    tz: Schema.String,
    misfire: Schema.optional(
      Schema.Struct({ mode: Schema.Literals(["latest", "skip"]), grace: DurationText }),
    ),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("webhook"),
    signature: Schema.optional(ScheduledTaskWebhookSignature),
    filters: Schema.optional(ScheduledTaskWebhookFilters),
    replayKey: Schema.optional(Schema.String),
    template: Schema.optional(Template),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("upstreamTag"),
    remote: Schema.String,
    pattern: Schema.String,
    pollMinutes: PositiveInt,
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("prMerged"),
    scope: Schema.Literals(["linked", "repo"]),
    repo: Schema.String,
    base: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("threadSettled"),
    projectId: Schema.optional(ProjectId),
    botId: Schema.optional(Schema.String),
    titlePrefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("workflowFailed"),
    workflow: Schema.optional(WorkflowId),
  }),
]);
// "Rodar agora" na UI e `workflow_run` de um bot são gatilhos manuais implícitos.

export const RunBudget = Schema.Struct({
  steps: PositiveInt,
  wall: DurationText,
  tokens: PositiveInt,
  usd: Schema.optional(Schema.Number), // estimativa; vale só quando todo passo tem preço conhecido
});

/** Fora do hash semântico: mover uma caixa não muda a versão que executa. */
export const CanvasLayout = Schema.Struct({
  positions: Schema.Record(
    Schema.String,
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      w: Schema.optional(Schema.Number),
      h: Schema.optional(Schema.Number),
    }),
  ),
  annotations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["note", "frame"]),
      text: Schema.String,
      x: Schema.Number,
      y: Schema.Number,
      w: Schema.Number,
      h: Schema.Number,
      attachedTo: Schema.optional(Schema.String),
    }),
  ),
  viewport: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number }),
  ),
});

export const WorkflowDefinition = Schema.Struct({
  schema: Schema.Literal("t3.workflow/v1"),
  id: WorkflowId,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  home: Schema.Struct({ project: Schema.String }), // projeto das threads e das tasks de webhook
  params: Schema.optional(Schema.Record(Schema.String, ParamSpec)),
  triggers: Schema.optional(Schema.Array(WorkflowTrigger)),
  concurrency: Schema.optional(Schema.Literals(["single", "queue", "parallel"])), // padrão single
  budget: RunBudget,
  fatigue: Schema.Struct({ consecutiveFailures: PositiveInt }),
  protect: Schema.optional(Schema.Array(Schema.String)), // soma refs protegidas; a lista do host sempre vale
  models: Schema.optional(Schema.Record(Schema.String, ModelRef)),
  workspaces: Schema.optional(Schema.Record(Schema.String, WorkspaceDecl)),
  card: Schema.optional(Schema.Struct({ project: Schema.String })), // quadro local do kanban; projeto ligado ao Linear é recusado
  nodes: Schema.Record(Schema.String, WorkflowNode),
  edges: Schema.Array(Schema.String),
  canvas: Schema.optional(CanvasLayout),
});
```

### 1.3 Expressões e compilador

Uma gramática só serve `when`, `until`, `check`, `keep`, `target`, `items` e `{{ }}`. Ela é compilada para AST e nunca passa por `eval`.

```
expr := or ;  or := and ('||' and)* ;  and := not ('&&' not)* ;  not := '!' not | cmp
cmp  := sum (('=='|'!='|'<'|'<='|'>'|'>=') sum)? ;  sum := term (('+'|'-') term)* ;  term := atom (('*'|'/') atom)*
atom := number | string | true | false | null | path | fn '(' args ')' | '(' expr ')'
fn   := len | any | all | contains | startsWith | min | max | coalesce
      | ledgerDigest(<id>) | ledgerBest(<id>)          -- id do ledger como string: ledgerBest("argo35-throughput")
raízes em todo lugar:  params trigger nodes.<id>.{output,status,port,thread} workspaces.<n>.{branch,head,path}
                       run.{id,dir} step.dir
dentro de map/loop:    item iteration
dentro de command:     exit out                 (em `check`)
dentro de hillclimb:   m best origin candidate  (em keep, target, confirmWhen, argv de measure)
```

```ts
/** Puro. O mesmo no servidor (autoritativo), no canvas e no Android. */
export const compileWorkflow = (
  input: unknown,
  host: HostLimits,
): Result<CompiledWorkflow, ReadonlyArray<Diagnostic>> => {
  // TODO 1. Schema.decodeUnknown(WorkflowDefinition) → diagnósticos com caminho
  // TODO 2. resolver edges "a:porta -> b"; portas: agent/command ok|fail, check pass|fail, gate <options>,
  //         branch <portas>|else, blocos ok|fail|<saídas nomeadas>; desconhecida → "port"
  // TODO 3. acíclico em cada nível (map/loop são nós; seus corpos são grafos à parte); call sem ciclo
  // TODO 4. parsear toda Expr/Template; raiz legal no contexto (m/best/origin/candidate só em hillclimb)
  // TODO 5. contaminação: trigger.* e saídas de agente sem `pattern` não entram em argv, env nem branch
  // TODO 6. classifyCommand(argv) em todo comando: Forbidden → erro; shell inline (`bash -c`, `node -e`) → erro
  // TODO 7. heavy && (selfSerializing || argv cita heavy.sh) → "heavy-nesting"
  // TODO 8. modelos: sem apelidos (opus|sonnet|haiku), $refs resolvem; arena: família(judge) ≠ família(lead)
  // TODO 9. orçamentos ≤ teto do host; loop.max e map.maxItems presentes; tokensFrom exige tokenReservation
  // TODO 9b. thread "continue:<nó>" só com o mesmo workspace e o mesmo access do nó continuado
  // TODO 10. hash = sha256(JSON canônico sem canvas)
  throw new Error("not implemented");
};

export type DiagnosticCode =
  | "schema"
  | "unknown-node"
  | "cycle"
  | "unreachable"
  | "port"
  | "expr"
  | "template-root"
  | "untrusted-in-argv"
  | "forbidden-command"
  | "heavy-nesting"
  | "model-alias"
  | "judge-family"
  | "budget-ceiling"
  | "trigger"
  | "call-cycle"
  | "card-linear"
  | "thread-continue";
```

`classifyCommand` é um lint. Ele pega no editor, cedo, um `git push`, `systemctl`, `gh pr merge`, `pkill` ou um script de deploy. A barreira de verdade é o perfil de execução (§9.5).

### 1.4 Visões (o que o cliente lê; derivadas, nunca gravadas)

```ts
export const StepStatus = Schema.Literals([
  "pending",
  "dispatched",
  "running",
  "waiting_gate",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "lost",
  "timed_out",
  "ambiguous",
]);
export const StepCost = Schema.Struct({
  billable: NonNegativeInt, // (entrada − leitura de cache) + saída: o que o orçamento conta (§9.1)
  input: NonNegativeInt, // inclui leituras e escritas de cache, como TurnTokenUsage
  output: NonNegativeInt, // inclui reasoning
  cacheRead: NonNegativeInt,
  usage: Schema.Literals(["complete", "partial", "unavailable"]), // semântica de TurnTokenUsage.usageStatus
  usdEstimate: Schema.NullOr(Schema.Number), // null = desconhecido, nunca 0
});
export const StepAttemptView = Schema.Struct({
  key: StepKey,
  node: NodeId,
  kind: Schema.String,
  attempt: PositiveInt,
  status: StepStatus,
  threadId: Schema.NullOr(ThreadId),
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  queuedMs: Schema.NullOr(NonNegativeInt), // espera do heavy.sh, separada do tempo de execução
  port: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String), // 500 caracteres
  cost: Schema.NullOr(StepCost),
  evidence: Schema.NullOr(Schema.String), // caminho do log/artefato
});
export const GateView = Schema.Struct({
  key: Schema.String,
  step: StepKey,
  ask: Schema.String,
  options: Schema.Array(Schema.String),
  openedAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  decision: Schema.NullOr(
    Schema.Struct({ option: Schema.String, note: Schema.NullOr(Schema.String), at: IsoDateTime }),
  ),
});
export const LedgerEntry = Schema.Struct({
  ledger: LedgerId,
  key: Schema.String,
  workflowId: WorkflowId,
  runId: RunId,
  step: StepKey,
  hypothesis: Schema.String,
  barHash: Schema.String,
  registeredAt: IsoDateTime,
  verdict: Schema.NullOr(
    // validated = mantido e depois aprovado pela validação final do workflow (holdout, Sol); só esse vira base
    Schema.Literals(["kept", "validated", "rejected", "invalid", "duplicate", "abandoned"]),
  ),
  before: Schema.NullOr(MetricReading),
  after: Schema.NullOr(MetricReading),
  sha: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});
export const BlockView = Schema.Union([
  /* hillclimb: rodada, origem, melhor, rodadas sem ganho, tentativas;
  arena: candidatos com nota, base, enxertos; graph: folhas com dono, deps, retrabalho, sha;
  interrogate: rodada, veredito, achados com estado */
]);
export const RunStatus = Schema.Literals([
  "queued", // TriggerFired aceito, execução ainda não criada
  "skipped", // TriggerSkipped; o motivo vem em pausedFor/reason
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "violation",
]);
export const RunSummary = Schema.Struct({
  runId: RunId,
  workflowId: WorkflowId,
  title: Schema.String,
  hash: SemanticHash,
  commit: Schema.String,
  status: RunStatus,
  pausedFor: Schema.NullOr(Schema.Literals(["fatigue", "sentinel", "ambiguous", "user"])),
  trigger: Schema.Struct({ kind: Schema.String, label: Schema.String }),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  outputStatus: Schema.NullOr(Schema.String),
  stepsUsed: NonNegativeInt,
  cost: StepCost,
  reservedTokens: NonNegativeInt,
  openGates: NonNegativeInt,
  pullRequest: Schema.NullOr(Schema.String),
});
/** O que o stream de execução manda: só o que mudou depois de `afterSeq`. */
export const RunDelta = Schema.Struct({
  runId: RunId,
  seq: NonNegativeInt,
  summary: RunSummary,
  steps: Schema.Array(StepAttemptView),
  blocks: Schema.Array(BlockView),
  gates: Schema.Array(GateView),
});
```

### 1.5 Grupo RPC (espalhado em `BOTS_RPCS`, como `KANBAN_RPCS`)

| Método (`bots.workflows.*`)         | Entrada                                                                                 | Saída                                                                   | Escopo                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `subscribe` (stream)                | `{}`                                                                                    | `{ workflows: WorkflowSummary[], templates }`                           | read                                    |
| `document.subscribe` (stream)       | `{ workflowId }`                                                                        | `WorkflowDocument` (fonte, definição, layout, revisão, diagnósticos)    | read                                    |
| `validate`                          | `{ source } \| { definition }`                                                          | `{ diagnostics, normalizedSource, semanticHash }`                       | read                                    |
| `save`                              | `{ workflowId?, baseRevision?, message, source \| definition+canvas }`                  | `Saved{revision, commit, hash, diagnostics} \| Conflict{base, current}` | operate                                 |
| `fromTemplate`                      | `{ templateId, workflowId, params }`                                                    | `Saved`                                                                 | operate                                 |
| `setEnabled` / `delete` / `restore` | `{ workflowId, … }`                                                                     | `WorkflowSummary`                                                       | operate                                 |
| `history`                           | `{ workflowId, cursor? }`                                                               | versões (commit, revisão, hash, autor, mensagem)                        | read                                    |
| `run.start`                         | `{ workflowId, params, clientRequestId }`                                               | `RunSummary`                                                            | operate                                 |
| `runs.list`                         | `{ workflowId?, status?, cursor? }`                                                     | página de `RunSummary`                                                  | read                                    |
| `run.get`                           | `{ runId, stepsCursor? }`                                                               | `RunView` (definição fixada + passos paginados)                         | read                                    |
| `run.subscribe` (stream)            | `{ runId, afterSeq }`                                                                   | `RunDelta`                                                              | read                                    |
| `run.step`                          | `{ runId, step, attempt }`                                                              | saída completa, texto, caudas de log                                    | read                                    |
| `run.control`                       | `{ runId, control: cancel\|pause\|resume\|retry\|amendBudget, step?, clientRequestId }` | `RunSummary`                                                            | operate                                 |
| `gate.decide`                       | `{ runId, gateKey, option, note? }`                                                     | `GateView`                                                              | operate, sessão de usuário; sem par MCP |
| `metrics`                           | `{ workflowId, since? }`                                                                | `WorkflowMetrics`                                                       | read                                    |
| `ledger`                            | `{ ledger?, workflowId?, cursor? }`                                                     | página de `LedgerEntry`                                                 | read                                    |

Um `runId` devolvido como `accepted` pode ainda não ter execução (fila, motor subindo) ou nunca ter (pulado). `run.get`, `run.subscribe` e `workflow_run_status` resolvem esse caso pelo stream do workflow e devolvem `RunSummary` com status `queued` ou `skipped` e o motivo (`busy`, `disabled`, `suspended`, `invalid`), nunca "não encontrado".

`run.subscribe` manda deltas: os passos, blocos e portões que mudaram depois de `afterSeq`. A definição vai uma vez, em `run.get`. Assim uma execução com mil passos não reenvia a árvore inteira a cada evento, o que importa para o celular e para o relay. Os três streams entram em `EnvironmentSubscriptionRpcTag` (`packages/client-runtime/src/rpc/client.ts:52`, seam existente).

---

## 2. Modelo de dados

Migração do fork `apps/server/src/bots/migrations/014_Workflows.ts`, chave `14_Workflows` em `BotsDb.ts:28`. Nenhuma tabela do upstream muda. Ids de thread ficam sem chave estrangeira entre bancos, como em `thread_watches` (`migrations/002_ThreadWatches.ts:8`). Os arquivos ficam em dois lados (§9.5): definições, recibos, segredos, placeholders e o repositório que publica em `~/.t3/workflows/`, do Israel; clones, worktrees, saídas e caches em volumes Docker que o Israel não lê.

```sql
-- A verdade. Três tipos de stream: 'run:<runId>', 'workflow:<id>', 'ledger:<ledgerId>'.
CREATE TABLE workflow_facts (
  stream TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (stream, seq), UNIQUE (stream, key)
);
CREATE INDEX workflow_facts_kind ON workflow_facts (kind, stream);

-- Uma linha por commit que mudou o arquivo. A execução fixa (workflow_id, commit_sha);
-- sobrevive a delete e a reescrita do histórico do repositório.
CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL, commit_sha TEXT NOT NULL, revision TEXT NOT NULL,   -- sha do blob
  semantic_hash TEXT NOT NULL, source TEXT NOT NULL, definition_json TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, commit_sha)
);
CREATE INDEX workflow_versions_hash ON workflow_versions (semantic_hash);

-- Caches. rebuildProjections() apaga e refaz a partir de workflow_facts e do repositório.
CREATE TABLE workflow_index (workflow_id TEXT PRIMARY KEY, path TEXT NOT NULL, head_commit TEXT, revision TEXT,
  title TEXT NOT NULL, valid INTEGER NOT NULL, dirty INTEGER NOT NULL, diagnostics_json TEXT NOT NULL,
  triggers_json TEXT NOT NULL, scanned_at TEXT NOT NULL);
CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, commit_sha TEXT NOT NULL, hash TEXT NOT NULL,
  status TEXT NOT NULL, trigger_kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, output_status TEXT,
  steps_used INTEGER NOT NULL, tokens_billable INTEGER NOT NULL, tokens_cache_read INTEGER NOT NULL,
  tokens_reserved INTEGER NOT NULL, usd_estimate REAL, active_ms INTEGER NOT NULL, open_gates INTEGER NOT NULL,
  pending_intents INTEGER NOT NULL, last_seq INTEGER NOT NULL, parent_run_id TEXT, card_ticket_id TEXT,
  pull_request_url TEXT);
CREATE INDEX workflow_runs_live ON workflow_runs (status, pending_intents);
CREATE INDEX workflow_runs_by_workflow ON workflow_runs (workflow_id, started_at DESC);
CREATE TABLE workflow_step_threads (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL, attempt INTEGER NOT NULL);

-- Operacional, não é verdade: perder um cursor só relê eventos cujas chaves deduplicam.
CREATE TABLE workflow_cursors (source TEXT PRIMARY KEY, position TEXT NOT NULL);
```

A única escrita de fatos é `Journal.append(batch)`, uma transação `BEGIN IMMEDIATE` que pode tocar vários streams. Para cada fato:

```sql
INSERT INTO workflow_facts (stream, seq, key, kind, payload_json, at)
VALUES ($stream,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM workflow_facts WHERE stream = $stream),
        $key, $kind, $payload, $at)
ON CONFLICT (stream, key) DO NOTHING
RETURNING seq;          -- vazio ⇒ o fato já estava gravado ⇒ quem chamou relê o existente
```

O `BEGIN IMMEDIATE` pega o lock de escrita no começo, então o `MAX(seq) + 1` de dentro da transação não disputa com outra. Só existe um escritor: os fatos são gravados pelo motor, num processo só, no host de bots. Cada `stateDir` tem um único servidor com `T3CODE_BOTS_HOST=1` (`BotsHost.ts:15`), e os servidores de dev usam o `.t3` da própria worktree. Por isso não há lease nem época.

O tamanho de cada fato tem teto: 16 KiB de texto do assistente, 64 KiB de saída de métrica e 8 KiB de cauda de log. Logs completos ficam em `~/.t3/workflows/receipts/<runId>/<passo>@<n>/`, e a transcrição fica na thread.

O `bots.sqlite` usa WAL com `synchronous = NORMAL` (`BotsDb.ts:49-55`). Um crash do processo não perde transação confirmada. Uma queda de energia pode perder as últimas. Mesmo nesse caso nada se duplica: os recibos do upstream e os recibos em arquivo do `wfUnit` (com fsync) continuam valendo, e um passo pode ser refeito ou ficar `ambiguous`.

---

## 3. Máquina de estados, retomada e idempotência

### 3.1 Fatos, dobra e decisão

```ts
export type RunFact =
  | {
      _tag: "RunStarted";
      workflowId;
      commit;
      hash;
      params;
      trigger: TriggerRef;
      budget: ResolvedBudget;
      callPins: Record<NodeId, { commit; hash }>;
      parent: { runId; step: StepKey } | null;
      causalDepth: number;
      protectedBaseline: ProtectedSnapshot;
    }
  // decisões (só o ator da execução)
  | { _tag: "IntentRecorded"; intent: Intent } // chave = intent.key
  | { _tag: "StepSkipped"; step; reason: "guard" | "dead-path" | "once" }
  | { _tag: "BranchTaken"; step; port }
  | { _tag: "MapExpanded"; step; items }
  | { _tag: "IterationStarted"; step; index }
  | { _tag: "BlockAdvanced"; step; event: BlockEvent }
  | {
      _tag: "StepResolved";
      step;
      attempt;
      status: "succeeded" | "failed" | "lost" | "timed_out" | "cancelled" | "ambiguous";
      port;
    }
  | { _tag: "OutputSet"; status; value; report; handoff }
  | { _tag: "RunPaused"; reason: "fatigue" | "sentinel" | "ambiguous" | "user"; detail }
  | { _tag: "RunResumed" }
  | { _tag: "RunEnded"; status: RunStatus }
  // resultados de intents (interpretador), chave = "result:" + intent.key
  | { _tag: "TurnStarted"; threadId; messageId; upstreamRunId: string | null }
  | { _tag: "UnitSpawned"; unit; dir }
  | { _tag: "WorkspaceReady"; name; path; branch: WfBranch; headSha }
  | { _tag: "GitOpDone"; op; sha }
  | { _tag: "GateOpened"; gateKey }
  | { _tag: "Notified"; channel }
  | { _tag: "PullRequestOpened"; url; branch: WfBranch }
  | { _tag: "ChildRunStarted"; childRunId }
  | { _tag: "IntentFailed"; error; retryable }
  // observações (sensores, RPC), cada uma com chave natural
  | {
      _tag: "TurnSettled";
      step;
      attempt;
      upstreamStatus;
      text;
      output;
      outputError;
      cost: StepCost;
    } // "settled:<step>@<n>"
  | {
      _tag: "UnitExited";
      step;
      attempt;
      exit;
      signal;
      queuedMs;
      out;
      tails;
      lost: boolean;
      started: boolean;
    } // "exited:<step>@<n>"
  | { _tag: "RuntimeRequest"; step; threadId; requestId; requestKind; text } // "request:<requestId>"
  | { _tag: "GateDecided"; gateKey; option; note; by: "user" | "expiry" } // "gate:<gateKey>", o primeiro vence
  | { _tag: "ControlRequested"; control; step: StepKey | null; by } // "control:<clientRequestId>"
  | { _tag: "ChildRunEnded"; childRunId; status; output; cost } // "child:<childRunId>"
  | { _tag: "SentinelTripped"; what: "protected-ref" | "service-identity"; before; after };

export type WorkflowFact = // stream workflow:<id>
  | { _tag: "TriggerFired"; triggerId; occurrence; payload; causalDepth } // chave = occurrence
  | { _tag: "RunCreated"; runId }
  | { _tag: "TriggerSkipped"; triggerId; occurrence; reason }
  | { _tag: "Toggled"; enabled; by }
  | { _tag: "Suspended"; reason: "fatigue" }
  | { _tag: "Unsuspended"; by }
  | { _tag: "RunOutcome"; runId; status }; // "outcome:<runId>"

export type LedgerFact = // stream ledger:<id>
  | { _tag: "EntryRegistered"; key; workflowId; runId; step; hypothesis; barHash } // "entry:<key>": unicidade global
  | { _tag: "TreeSeen"; treeHash; entryKey } // "tree:<treeHash>"
  | { _tag: "EntryResolved"; key; verdict; before; after; sha; note }; // "resolved:<key>"
```

Orçamento, fadiga e reserva saem da dobra (`TurnSettled.cost`, `UnitExited.out[tokensFrom]`, `IntentRecorded(StartTurn).reservation`). Não existe fato `BudgetCharged`, porque seria uma segunda cópia que poderia discordar.

```ts
export type Intent =
  | {
      _tag: "StartTurn";
      key;
      step;
      attempt;
      thread: { new: LaunchPlan } | { continue: ThreadId };
      prompt: string;
      model: ResolvedModel;
      access: "read" | "write";
      reservation: number;
    }
  | {
      _tag: "StartUnit";
      key;
      step;
      attempt;
      argv: string[];
      cwd: string;
      heavy: boolean;
      replay: "safe" | "never";
      profile: ProfileRef;
      timeoutMs: number;
      env: Record<string, string>;
    }
  | {
      _tag: "PrepareWorkspace";
      key;
      name;
      project: ProjectId;
      baseRef: string;
      branch: WfBranch;
      path: string;
    }
  | {
      _tag: "GitOp";
      key;
      workspace;
      op:
        | { kind: "advance"; branch: WfBranch; to: string; from: string }
        | { kind: "mergeLocal"; from: string; expectHead: string };
    }
  | { _tag: "RemoveWorkspace"; key; name }
  | { _tag: "Interrupt"; key; step; target: { threadId } | { unit } }
  | { _tag: "AnswerRequest"; key; threadId; requestId; answer: "decline" | { text: string } }
  | { _tag: "OpenGate"; key; step; gateKey; ask; options; expiresAt }
  | { _tag: "Notify"; key; channel: "push" | { thread: ThreadId }; title; body; path }
  | {
      _tag: "UpsertCard";
      key;
      column: "todo" | "in_progress" | "in_review" | "done";
      title;
      threadIds;
    }
  | { _tag: "OpenPullRequest"; key; workspace; branch: WfBranch; base: string; title; body }
  | {
      _tag: "StartChildRun";
      key;
      step;
      workflowId;
      commit;
      hash;
      params;
      reservation: ResolvedBudget;
    }
  | { _tag: "RegisterLedger"; key; ledger; entry; tree?: string }
  | { _tag: "ResolveLedger"; key; ledger; entry }
  | { _tag: "ProbeProtected"; key }
  | { _tag: "ArchiveThread"; key; threadId }
  | { _tag: "Record"; facts: ReadonlyArray<StreamFact> }; // decisão pura, sem execução
// A união é fechada: não existe intent de merge em ref protegida, deploy, restart ou push forçado.

/**
 * Puro. Ordem: 1 terminal? → [] · 2 controles · 3 sentinela · 4 orçamento · 5 fadiga
 * 6 pedidos de runtime → AnswerRequest ou OpenGate · 7 assentar passos com resultado
 * 8 avançar o grafo (primitivo → intents; bloco → blockDeciders[kind].decide)
 * 9 timeouts e expiração de portão por ctx.now · 10 nada vivo e nada pronto → OutputSet + RunEnded
 * Nunca reemite intent cuja chave está pendente ou já tem resultado.
 */
export const decide = (
  wf: CompiledWorkflow,
  s: RunState,
  ctx: DecideContext,
): ReadonlyArray<Intent> => {
  throw new Error("not implemented");
};
export const nextDeadline = (wf: CompiledWorkflow, s: RunState): Date | null => {
  throw new Error("not implemented");
};
```

O ator de cada execução (`RunActor`, uma fibra por execução viva num `FiberMap`) faz: dobrar, reexecutar intents pendentes com as mesmas chaves, ligar sensores e repetir `decide → gravar → executar` até o fim. Cada append publica `(stream, seq)` num `PubSub`. O ator acorda com fato novo no seu stream ou no prazo de `nextDeadline`. Os próprios fatos são a caixa de entrada, e nenhuma fila em memória pode perder mensagem.

### 3.2 Execução

```
      TriggerFired (gatilho | manual | bot | filho | rotina falhou)
                       │ decisor do workflow: txn RunCreated (workflow:) + RunStarted (run:) + cache
                       ▼
     ┌──────────► running ── pause / fadiga / sentinela / ambíguo ──► paused
     │              │  │                                                │
     │  resume ◄───────┼────────────────────────────────────────────────┘
     │              │  └─ orçamento estourado ─► Interrupt dos vivos ─► budget_exhausted
     │              ├─ cancel ─► Interrupt dos vivos ─► cancelled
     │              ├─ sentinela recusada no portão "foi você?" ─► violation
     │              └─ nada vivo e nada pronto ─► OutputSet ─► succeeded | failed
     └── retry de um passo numa execução failed ─► running (tentativa + 1)
```

**Do gatilho à execução.** Todo pedido de execução é primeiro um `TriggerFired` no stream do workflow, com chave = ocorrência. Quem cria a execução é o **decisor do workflow**, outra função pura (`decideWorkflow(workflowState, ctx) -> WorkflowIntent[]`) que o motor roda no tick e logo depois de cada `TriggerFired`. Para cada `TriggerFired` sem `RunCreated` nem `TriggerSkipped`, ele decide entre:

- criar a execução (`RunCreated` + `RunStarted`, uma transação);
- pular, com `TriggerSkipped{disabled | suspended | invalid}`;
- esperar: `concurrency: queue` com execução viva deixa o fato pendente até ela acabar, e `single` grava `TriggerSkipped{busy}`.

O `runId` é derivado da ocorrência, então `start`, `run.start` e `workflow_run` devolvem o `runId` na hora, com status `accepted`, mesmo que o motor ainda esteja subindo ou a execução esteja na fila. Promover duas vezes bate na mesma chave.

O fim é atômico. Num único append vão `OutputSet` e `RunEnded` em `run:<id>`, `RunOutcome` em `workflow:<id>` e, se a execução falhou, os `TriggerFired` dos workflows que assinam `workflowFailed`. Notificações e cartões do fim são intents gravados nesse mesmo batch. Na partida, o motor carrega as execuções vivas e também as terminadas com `pending_intents > 0`. Assim nenhuma consequência some entre duas gravações.

O caminho de volta: `failed` aceita `retry` de um passo, `paused` aceita `resume`, `budget_exhausted` aceita `amendBudget` (registrado como `ControlRequested`, com o novo teto) seguido de `resume`, e um workflow suspenso por fadiga aceita `Unsuspended`. Uma nova versão roda numa execução nova.

### 3.3 Passo

```
pending ─(deps resolvidas, join ok)─► guarda falsa ─► skipped (caminho morto se propaga)
   │                                 once no ledger ─► skipped(once)
   ▼ guarda verdadeira, orçamento reservado
dispatched (IntentRecorded StartTurn|StartUnit)
   ▼ fato de resultado
running (TurnStarted | UnitSpawned) ── RuntimeRequest ──► AnswerRequest (segue) | OpenGate ──► waiting_gate
   ▼ observação (TurnSettled | UnitExited)
StepResolved: succeeded | failed | lost | timed_out | cancelled | ambiguous
   ├─ retry casa e há tentativas ─► dispatched (tentativa + 1, chaves novas)
   └─ ambiguous ─► RunPaused(ambiguous) + portão "rodar de novo / marcar falho / cancelar"
```

Saída de agente: o motor lê `subagentResultForRun` (`packages/provider-core/src/server/subagentProjection.ts:168`) e procura o último bloco ```json. Se `output` foi declarado e o JSON falta ou não decodifica, o motor manda um turno de cobrança na mesma thread ("termine com o JSON no formato X"). Se faltar de novo, o passo falha. O texto padrão "completed without an assistant result" nunca passa como saída.

### 3.4 Tabela de crash: o processo morre entre duas linhas quaisquer

| Janela                                                              | Estado durável                                                               | O que a partida faz                                                                                                                                                                                                  | Por que não duplica                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decide` voltou, nada gravado                                       | nada                                                                         | decide de novo                                                                                                                                                                                                       | nada externo aconteceu                                                                                                                                                                              |
| `TriggerFired` gravado, `RunCreated` não                            | fato órfão no stream do workflow                                             | o decisor do workflow (§3.2) promove: cria a execução, pula ou enfileira                                                                                                                                             | `runId` é derivado da ocorrência; promover duas vezes bate na mesma chave                                                                                                                           |
| `StartTurn` gravado, `launch` não chamado                           | intent pendente                                                              | `launch` com `threadId = wf:<runId>:<sha(key)>` e `commandId = wf:<sha(key)>`                                                                                                                                        | primeira chamada de fato                                                                                                                                                                            |
| `launch` confirmou no upstream, `TurnStarted` não gravado           | intent + thread no upstream                                                  | `launch` de novo com a mesma entrada: o recibo devolve a mesma thread (`ThreadLaunchService.ts:838-858`); `messageId` derivado da chave (`:945-971`)                                                                 | recibo do upstream                                                                                                                                                                                  |
| `StartTurn{continue}` gravado, `sendToThread` sem resultado gravado | intent pendente                                                              | `sendToThread` de novo com o mesmo `commandId`, `messageId` derivado e `mode: "queue"` (`ThreadManagementService.ts:761-800`)                                                                                        | recibo do upstream; `queue` nunca vira steer de uma continuação de restart                                                                                                                          |
| turno rodando, servidor reinicia                                    | passo running                                                                | sensor chama `waitForThread(untilDelegatedWorkSettled)`, que segue `restartContinuationOfRunId` e espera efeitos de restart pendentes (`ThreadManagementService.ts:873-894`)                                         | o motor não manda "continue"                                                                                                                                                                        |
| upstream cancelou o turno por não poder retomar                     | passo running                                                                | `TurnSettled{cancelled}` → `lost` → retry. Com `access: write`, a nova tentativa abre thread nova **na mesma worktree**, avisada de que a anterior foi interrompida                                                  | nova tentativa é decisão gravada, com chave nova                                                                                                                                                    |
| `StartUnit` gravado, unit não criada                                | intent pendente                                                              | `exit.json` existe? adota. Unit `wf-<k>` ativa? observa. `started.json` existe? perdido (abaixo). Nada? cria a unit                                                                                                  | `started.json` é gravado com fsync antes do argv; sem ele, o comando não começou. `systemd-run --unit` recusa nome repetido enquanto a unit vive, e `--collect` limpa a que falhou antes de começar |
| unit rodando, servidor reinicia                                     | passo running                                                                | a unit sobrevive (é do gerenciador do usuário, fora do cgroup do `t3-friend.service`); o sensor vê `exit.json` depois                                                                                                | ninguém mata a unit                                                                                                                                                                                 |
| `started.json` sem `exit.json`, unit sumiu (OOM, reboot)            | passo running                                                                | `replay: safe` → nova tentativa; `replay: never` → `ambiguous`, a execução pausa com portão "rodar de novo / marcar falho / cancelar"                                                                                | nunca conclui "não rodou" só porque falta o recibo                                                                                                                                                  |
| `PrepareWorkspace` interrompido                                     | intent pendente                                                              | o motor recria o placeholder se faltar (`mkdir` idempotente); `wf-git prepare` (`replay: safe`) roda `git worktree prune`, adota a worktree que já existe no caminho com a branch esperada, ou apaga o resto e refaz | caminho e branch derivados da chave                                                                                                                                                                 |
| `GitOp advance` feito, resultado não gravado                        | intent pendente                                                              | comando do sandbox `wf-git advance` faz `update-ref refs/heads/wf/… <to> <from>` no clone da execução; se a ref já é `<to>`, conta como feito. O motor guarda o sha no journal e não depende da ref                  | compare-and-swap na ref                                                                                                                                                                             |
| `GitOp mergeLocal` interrompido                                     | intent pendente                                                              | comando do sandbox `wf-git merge`: se `HEAD` já contém `from` (`merge-base --is-ancestor`), feito; se há `MERGE_HEAD`, `merge --abort` e refaz                                                                       | worktree é só da execução                                                                                                                                                                           |
| `OpenPullRequest` interrompido                                      | intent pendente                                                              | refaz: o bundle sai de novo pelo stdout do sandbox; importar em `publish/` o que já está lá é no-op; push do mesmo sha é no-op; `gh pr list --head <branch>` acha o PR e grava                                       | o PR é achado pela branch                                                                                                                                                                           |
| `Notify(push)` enviado, `Notified` não gravado                      | intent pendente                                                              | reenvia                                                                                                                                                                                                              | entrega pelo menos uma vez; o Android deduplica por `alert_id = key` (`AgentNotifications.kt:146`)                                                                                                  |
| portão decidido duas vezes ou de dois aparelhos                     | `GateDecided` com chave `gate:<key>`                                         | nada                                                                                                                                                                                                                 | o primeiro vence; o segundo recebe a decisão existente                                                                                                                                              |
| tick do cron roda duas vezes na mesma ocorrência                    | `TriggerFired` com chave da ocorrência                                       | nada                                                                                                                                                                                                                 | chave única                                                                                                                                                                                         |
| `RunEnded` gravado com obrigações                                   | mesmo batch que `RunOutcome`, `TriggerFired` dos assinantes e intents de fim | partida carrega terminadas com `pending_intents > 0`                                                                                                                                                                 | o fim é atômico                                                                                                                                                                                     |
| save de definição interrompido                                      | arquivo escrito, commit ou versão faltando                                   | a varredura de partida trata como edição à mão (§7.3) e completa commit, versão e tasks de webhook                                                                                                                   | cada passo do save é idempotente                                                                                                                                                                    |

A ordem da partida é: o motor registra no `Scheduler` compartilhado, que só ativa depois da recuperação do upstream (`apps/server/src/scheduling/Scheduler.ts:51-57`), e só no host de bots (`bots/layer.ts:255-273`). Enquanto o motor não está pronto, `run.start`, `workflow_run` e o gancho do webhook gravam o `TriggerFired` no journal e respondem "aceito". A execução nasce quando o motor fica pronto. Nada cai num lançamento comum de thread.

### 3.5 Mapa de módulos

Todos os caminhos são novos e do fork.

```
packages/contracts/src/workflows.ts           §1: schemas, RPCs, WORKFLOWS_WS_METHODS, escopos
packages/shared/src/workflows/                compileWorkflow, parseExpr, evalExpr, renderTemplate, classifyCommand, modelFamily (export ./workflows)
packages/contracts/src/bots.ts (do fork)      + export * from "./workflows.ts"; ...WORKFLOWS_RPCS em BOTS_RPCS; escopos

apps/server/src/bots/workflows/
  facts.ts  fold.ts  decide.ts  view.ts       fatos como Schema, dobra, decisão pura, visões
  blocks/{hillclimb,arena,graph,interrogate}.ts   um BlockDecider cada
  Journal.ts            append(batch) em BEGIN IMMEDIATE, read, liveRuns, changes (PubSub), rebuildProjections
  Interpreter.ts        execute(runId, intent) → fatos de resultado
  RunActor.ts           laço por execução; supervisor FiberMap
  WorkflowEngine.ts     serviço público: start, control, decideGate, runView, subscribeRun, listRuns, metrics, ledger, isStepThread
  sensors/turns.ts      waitForThread por turno vivo; pedidos de runtime; saída e custo
  sensors/units.ts      exit.json no tick do Scheduler
  exec/CommandRunner.ts uma unit systemd-run por comando, que roda o wfUnit e o container; o lock fica no container (wf-run); adoção e cancelamento
  exec/wfUnit.ts        roda na unit, FORA do container: docker run → espera WF-LOCKED → started.json (fsync) → GO → exit.json (rename atômico)
  exec/HeavyBroker.ts   socket do shim de heavy.sh; atribui o pedido ao passo dono do cwd (§9.3)
  sandbox/Dockerfile    imagem t3-workflow-sandbox (ferramentas, claude, codex, X para bench e computer use)
  sandbox/wf-claude  sandbox/wf-codex      wrappers no molde de t3-guest-claude: docker run com as flags do guest
  sandbox/wf-git  sandbox/heavy-shim     ferramentas de dentro da imagem
  sandbox/infra.ts      cria de forma idempotente imagem, rede interna, proxy e volumes (como ensure_infra do guest)
  sandbox/writer.ts     container escritor: grava bundles, artefatos e o JSONL de correções nos volumes só leitura
  sandbox/homes.ts      volumes de home dos providers: sem MCP, hooks, notify nem skills; placeholders de credencial
  egress/openai-forward.mjs   forwarder do OpenAI no container do proxy (o do Anthropic é o do guest)
  sandbox/selfTest.ts   autoteste do perfil na partida
  sentinel.ts           refs protegidas no repositório de produção e no remoto
  git/engineGit.ts      única porta do motor para o git; só aceita o repositório de produção e publish/; sem hooks
  git/Bundles.ts        bundles de entrada (produção → inbox) e importação verificada da cópia que o wfUnit gravou em publish/
  hostTasks/            registro fechado de tarefas do host (extract-corrections)
  runs/Placeholders.ts  cria e apaga os placeholders vazios (0555) que o servidor usa como cwd
  egress/               proxy só para endereço público e forwarders Anthropic/OpenAI (reaproveitam os do guest)
  definitions/WorkflowRepo.ts          git do repositório de workflows (ler HEAD, commit, log, restaurar)
  definitions/yamlCodec.ts             YAML ⇄ definição, ordem canônica
  definitions/WorkflowDefinitions.ts   serviço público: list, document, subscribe*, save, validate, setEnabled, delete, restore, history
  library/*.workflow.yaml              modelos prontos (§11)
  triggers/WorkflowTriggers.ts         cron, poll de tag, cursores de evento, reconciliação das tasks de webhook
  triggers/hook.ts                     WorkflowTriggerHook (registro no layerCore), lido pela seam da STS
  notify.ts  card.ts                   construtores puros de push e de cartão
  mcp/tools.ts  mcp/handlers.ts        WorkflowToolkit
  rpc.ts                               handlers juntados ao grupo de bots/rpcHandlers.ts
apps/server/src/bots/migrations/014_Workflows.ts
apps/server/src/bots/layer.ts (do fork)   + WorkflowTriggerHook no layerCore; WorkflowEngine no layerService

packages/client-runtime/src/workflows.ts      toCanvasModel, fromCanvasModel, mergeDocuments, autoLayout, mergeRunDelta, statusTone
packages/client-runtime/src/state/bots.ts     + átomos de workflows (comandos e assinaturas)
apps/web/src/bots/workflows/                  WorkflowsPage, WorkflowEditor (CanvasHost, Inspector, SourceTab, MergeDialog),
                                              RunView, MetricsPanel, LedgerView, canvas/reactFlowAdapter.tsx, canvas/roughSkin.tsx
apps/web/src/routes/_chat.workflows*.tsx      lista, editor, execução (declarados do fork)
apps/mobile/src/bots/workflows/               WorkflowsScreen, WorkflowScreen, RunScreen (grafo em react-native-svg), GateSheet, LightEditScreen
scripts/friend/wf/                            CLIs JSON das rotinas (§11)
```

Superfície pública do servidor: **dois serviços**, `WorkflowDefinitions` e `WorkflowEngine`. RPC, MCP, gatilhos e telas chamam só esses dois.

---

## 4. Blocos de primeira classe e a RSI

**Por que nativos e não expandidos.** O graph recebe seu DAG em tempo de execução. A arena depende de quantos candidatos sobraram. O hillclimb mexe num ponteiro de melhor resultado e num ledger entre execuções. Expandir isso em `loop`, `branch` e `map` exigiria uma linguagem de script no YAML ou estado escondido fora da expansão. O canvas mostraria a expansão, e o Israel quer ver "rodada 7, melhor +23%, 2 rodadas sem ganho". Cada bloco é `{ init, apply, decide, view }` sobre sub-estado tipado e usa só os executores comuns (turno, unit, git). Um quinto bloco é uma entrada num registro fechado.

```ts
export interface BlockDecider<Cfg, St, Ev> {
  readonly init: (cfg: Cfg) => St;
  readonly apply: (st: St, ev: Ev | ChildResult) => St;
  readonly decide: (cfg: Cfg, st: St, io: BlockIO) => ReadonlyArray<Intent>; // filhos com chave sob o StepKey do bloco
  readonly view: (cfg: Cfg, st: St) => BlockView;
}
export const blockDeciders = { hillclimb, arena, graph, interrogate } as const satisfies Record<
  BlockKind,
  BlockDecider<any, any, any>
>;
```

### 4.1 Hillclimb

Sub-estado: fase (`origin | proposing | implementing | building | measuring | confirming | ended`), origem (sha, artefato, leitura), melhor (sha, artefato, leitura), rodada, rodadas sem ganho, tentativa atual (chave, thread, sha, hash da árvore), gasto do bloco e motivo do fim.

Rodada (chaves dos filhos `<hc>/r<n>/<filho>`):

1. **Origem**, uma vez por execução. Prepara `wf/<run>/<node>` em `workspace.base`, roda `build` (heavy) e todo `measure` contra ela mesma, e grava a leitura da origem. Execuções noturnas sobem a partir do último candidato **validado**: `base: "{{coalesce(ledgerBest('argo35-throughput'), params.from)}}"`, e `ledgerBest` só devolve entradas `validated` (mantidas e depois aprovadas pela validação final do workflow). Um candidato só mantido no treino não vira base.
2. **Propor.** Turno do gerador (thread nova, leitura) com o resumo do ledger: últimas 50 entradas com veredito e todas as chaves. A saída é `{ key, mechanism, rationale }` ou `{ exhausted: true }`. O sub-decisor confere `key ∉ ledger` e `RegisterLedger` grava `entry:<key>` com o hash da barra. Conflito com outra execução vira `DuplicateRejected` e o gerador é chamado mais uma vez. **O registro vem antes de qualquer código**: isso é a pré-registração.
3. **Implementar.** Thread **nova**, com escrita, numa worktree `wf/<run>/<node>/r<n>` a partir de `best.sha`, com a proposta registrada no prompt, terminando em "commite e devolva {sha}". Não é a thread do passo 2, porque uma thread tem um só acesso e uma só worktree (§9.5). O motor lê o `HEAD` sozinho, sem confiar no relato. Calcula o hash da árvore e grava `tree:<hash>`. Árvore já vista é `DuplicateRejected{tree}`. O que o ledger garante: **a mesma chave ou a mesma árvore nunca é medida duas vezes**. Uma ideia reescrita com outra chave passa por ele; contra isso o gerador lê o resumo do ledger, e um turno curto de juiz (Haiku) compara a proposta com o resumo antes do registro e recusa repetição óbvia.
4. **Build.** Comando heavy. O artefato sai do container pelo stdout de `wf-git export-artifact` e o escritor do motor o grava no volume `t3-wf-artifacts`, que os passos montam só leitura, antes de medir (§9.5).
5. **Medir.** Cada `measure.<nome>` recebe `{{best.artifact}}`, `{{candidate.artifact}}` e `{{step.dir}}` e escreve em `m.<nome>`. Métrica incompleta (`complete == false`, JSON quebrado, campo faltando) é **inválida**, não rejeitada. Inválida conta para fadiga e orçamento, não para platô.
6. **Julgar.** `keep(m, best, origin)` dá `kept` ou `rejected`. Mantido: `GitOp advance wf/<run>/<node>/best` (CAS), o melhor avança e as rodadas sem ganho zeram. Rejeitado: `RemoveWorkspace` da tentativa e +1 rodada sem ganho. Nos dois casos, `ResolveLedger` grava veredito, leitura antes e depois e sha. **Reverter é descartar a worktree da tentativa**, nunca dar reset numa worktree compartilhada.
7. **Confirmar.** Quando `confirmWhen` vale, roda `measure` com base = artefato da **origem**. A barra pré-registrada `target` só é avaliada aqui. Atingiu: fim `target`.
8. **Parar.** Platô (`roundsSinceGain ≥ plateau.rounds`), orçamento do bloco (iterações, tempo, tokens), gerador esgotado duas vezes, ou origem que não builda (`blocked`). **Platô nunca é sucesso e nunca afrouxa a barra.** `keep` e `target` fazem parte do hash fixado, então não mudam no meio da execução.

Portas de saída: `target`, `no_gain` (platô ou esgotado), `budget`, `blocked`. Valores: `{ endedBy, bestSha, bestBranch, origin, best, attempts }`, e a worktree `best` é exportada como `<nó>.best` para os nós seguintes.

### 4.2 Arena

Fases: `running → judging → grafting → verifying → ended`.

1. `cand[i]`: um turno por runner, cada um numa worktree própria `wf/<run>/<node>/c<i>`, mesma tarefa e mesmo contrato de artefato.
2. Drenar: com todos assentados, ou no timeout do nó, confere `≥ minCandidates`. Menos que isso vai para a porta `insufficient`.
3. `judge`: turno de leitura em thread nova. Vê os artefatos e a **rubrica**, que os candidatos nunca viram. Saída `{ scores, base, graft: [{ from, idea }] }`. Regra do compilador: família do juiz ≠ família do lead. Se candidatos dividem família com o juiz, a visão mostra isso. Sem modelo da outra família no catálogo vivo, o passo falha com `model_unavailable` e nada é trocado.
4. `graft`: turno do lead em thread nova, com escrita, numa worktree nova a partir do sha do candidato base, com o veredito no prompt. A evidência original dos candidatos fica intacta.
5. `verify` (comando opcional): falhou e `reruns < maxReruns` → `graft` de novo; senão, porta `fail`.

### 4.3 Graph

Fases: `contract → planning → leaves → final → ended`.

1. `lead/contract`: o lead escreve tipos e contratos na worktree de integração `wf/<run>/<node>`, commita e passa `finalChecks[0]`. Esse sha é o **sha do contrato**.
2. `lead/plan`: mesma thread. Saída `GraphPlan = { leaves: [{ id, goal, owns: glob[], deps: id[], accept: argv, model? }] }`. `validateGraphPlan` (puro) exige grafo acíclico, `≤ maxLeaves`, `owns` disjuntos entre folhas que podem correr juntas, `accept` limpo no `classifyCommand` e modelos existentes. Plano inválido volta para a thread com os diagnósticos, no máximo duas vezes, e depois a porta `blocked`.
3. Folhas: folha pronta (deps **integradas**, `≤ maxParallel` vivas) ganha turno do modelo `leaf` numa worktree própria a partir do **sha integrado atual**, para enxergar o que as dependências já entregaram. Ao assentar, o motor roda `git diff --name-only` (tem que caber em `owns`, senão `out-of-scope`), roda `accept` (exit 0) e faz `GitOp mergeLocal` na integração (conflito → o lead resolve na thread dele, que já tem escrita na integração). Rejeitada com `rework < reworkCap` → o motivo volta para a thread da folha. Depois disso, o lead implementa aquela folha. Folha que reporta `{ blocked: "contract" }` volta para o lead e nunca edita o contrato.
4. Final: `finalChecks` passam, porta `ok` com o sha. Worktrees das folhas são removidas; a de integração fica.

### 4.4 Interrogate

Rodadas `r1..rN`:

1. Revisores em **threads novas a cada rodada**, só leitura, cada um numa worktree descartável no sha congelado da worktree alvo, com o diff `baseRef..HEAD` e o diff desde a rodada anterior. No modo loop há um revisor. No painel, todos na r1 e, depois, só os que têm achado aberto. Saída `{ verdict: APPROVE|CHANGES, findings: [{ id, severity: blocker|should|nit, file, line, claim, evidence }] }`.
2. O lead (uma thread de escrita na worktree alvo, que continua de rodada em rodada) só começa quando os revisores terminam. Verifica cada achado, corrige ou discorda com evidência e devolve `{ resolutions: [{ id, state: fixed|disagree|declined }] }`.
3. `checks` rodam.
4. Fim: APPROVE sem blocker ou should aberto → `approve`. Só nits → para cedo. Teto de rodadas, ou o mesmo achado disputado duas vezes → porta `stuck`, que costuma ir para um portão. Erro ou timeout de revisor nunca conta como aprovação.

### 4.5 A RSI cabe nos blocos

A rotina de qualidade (§11.4) faz: `snapshot` → `extract` → `map` sobre classes de erro (com `once` num ledger, para nunca repropor uma classe) → `arena` de propostas de enforcement estrutural → portão em que o Israel escolhe → `graph` para implementar numa branch `wf/` com teste que falha antes → `interrogate` → PR em rascunho. Medições de tokens ou throughput entram como `hillclimb`. O **ledger da RSI** no painel é a união dos streams `ledger:*`: toda tentativa de melhoria, em qualquer rotina, com hipótese, barra, antes, depois, veredito e sha. Nenhuma rodada repete uma tentativa que já falhou, porque a chave da hipótese e o hash da árvore são únicos no ledger.

---

## 5. Gatilhos

Todo gatilho termina em `WorkflowEngine.start({ workflowId, request: { kind, occurrence, payload, causalDepth } })`, que só grava `TriggerFired` (chave = ocorrência) em `workflow:<id>` e devolve `runId = "wfr_" + sha256(workflowId + occurrence)[0..20]` com status `accepted`. O decisor do workflow (§3.2) transforma o fato em execução, pulo ou fila. Ocorrência repetida devolve o mesmo `runId`. `concurrency: single` pula com `busy` se há execução viva; `queue` espera; `parallel` sobrepõe.

| Gatilho                  | Fonte                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Ocorrência                      | Observações                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cron com fuso**        | do fork: `Cron.parse(expr, tz)` (`.repos/effect-smol/packages/effect/src/Cron.ts:545`) avaliado no tick do `Scheduler` compartilhado. `occ = Cron.prev(cron, now)`; dispara se `occ > última ocorrência` e está dentro do `misfire.grace` (padrão `latest` e 1 h). Ativar grava a marca d'água, então nada é recuperado do passado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `cron:<trigger>:<occ ISO UTC>`  | A `ScheduledTask` só tem intervalo e hora fixa no fuso do host (`Schedule.ts:12-37`) e sua chave de disparo não identifica a ocorrência (`ScheduledTaskService.ts:807-812`). Horário duplicado no fim do horário de verão tem duas chaves UTC distintas                                                                                                                                                                                                                                                                                                                |
| **webhook**              | **reaproveita a `ScheduledTask`**. `reconcileWebhooks` (no save e em todo tick) faz `upsert`, dentro do escopo do motor, da task `wf-hook:<workflowId>:<trigger>` com `schedule: {type: "webhook", signature, filters, dedupe: { replayKey, coalesceKey: "{{request}}", coalesceWindowSeconds: 10 }}`, `prompt: template ?? "{{request}}"` e `projectId: home`. Tirar o gatilho apaga a task. O segredo do HMAC fica em `~/.t3/workflows/secrets/` e vai como `secret` em cada recriação (um `secretRef` só vale uma vez, `ScheduledTaskService.ts:1104-1107`). A task aparece na tela de tarefas como "gerenciada pelo workflow X", e o guard da seam (§12) recusa editar, desligar, apagar ou "rodar agora" fora do motor. Se alguém apagar o banco por fora, o tick recria a task, e como o token da URL é novo, o motor avisa o Israel da URL nova | `webhook:<deliveryId>`          | O `coalesceKey` nunca vazio faz a entrega virar linha durável em `scheduled_task_webhook_pending` **antes** do 202 (`webhookDedupe.ts:85-90`). Sem ele, a entrega imediata fica só em memória até o despacho (`ScheduledTaskService.ts:1986-2034`). O custo é até 10 s de latência. O worker durável despacha por `runTask`, onde está o gancho (§12). HMAC, prova do relay, filtros, limites e URL pública (`webhookPublicBase.ts:54`) vêm de graça. O payload chega como texto renderizado e marcado como não confiável (`webhookTemplate.ts:148`) em `trigger.text` |
| **pedido de bot**        | MCP `workflow_run`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `bot:<botId>:<clientRequestId>` | No fim, um `Notify{thread}` acorda o bot com o link, como o `ThreadWatchReactor` (`ThreadWatchReactor.ts:45`)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **manual**               | RPC `run.start` (web, desktop, Android)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `manual:<clientRequestId>`      | O mesmo `clientRequestId` com parâmetros diferentes é erro, não a execução velha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **tag nova no upstream** | poller do fork no tick: `git ls-remote --tags --refs <remote>`, maior tag que casa com `pattern`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tag:<remote>:<tag>:<objeto>`   | Só leitura: não faz fetch nem mexe em ref local, então tag local perdida não ganha (`merge-upstream.ts:30-41` faz fetch e confia em tags locais). O sha do objeto entra na chave: tag movida é ocorrência nova e aparece como tal                                                                                                                                                                                                                                                                                                                                      |
| **PR mergeado**          | `scope: linked`: `streamStoredEventsFrom({ afterSequence: cursor, eventType: "thread.pull-request-link-updated" })` (`Orchestrator.ts:416-420`, evento em `contracts/orchestrationV2.ts:2728`) mais a cauda ao vivo. `scope: repo`: `gh api` de PRs fechados desde o cursor, a cada 10 min no mínimo, pelo motor fora do sandbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `pr:<repo>#<n>:<mergeSha>`      | `linked` cobre PRs ligados a threads T3; `repo` cobre o repositório inteiro, com custo de cota da API                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **thread terminou**      | cursor em `thread.settled` (`ThreadSettlementService.ts:603`), filtrado por projeto, bot ou prefixo de título; threads de passo de workflow ficam de fora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `settled:<threadId>:<seq>`      | "Terminou" é `thread.settled`, não um `run.updated` terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **rotina falhou**        | o próprio motor: no batch atômico do fim (§3.2), grava `TriggerFired` nos assinantes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `run-failed:<runId>`            | `causalDepth` do filho = pai + 1; dispara só se `< 2` e se o assinante ≠ origem. Não há laço infinito                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Os cursores (`workflow_cursors`) avançam só depois do `TriggerFired` gravado. Perder um cursor relê eventos, e as chaves deduplicam. Todas as fontes sobem só no host de bots.

Contaminação: valores de webhook, título de PR e texto de thread são **não confiáveis**. O compilador proíbe que entrem em argv, env ou nome de branch, a não ser por um parâmetro com `pattern`, decodificado nesse pattern na partida. Nos prompts eles entram com a moldura de dado não confiável.

---

## 6. Ferramentas MCP para bots

Toolkit do fork `WorkflowToolkit` (`apps/server/src/bots/workflows/mcp/tools.ts` e `handlers.ts`), registrado no hunk do fork que já existe em `McpHttpServer.ts:1174`.

| Ferramenta             | Parâmetros                                                 | Saída                                                               | Anotação                              |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `workflow_list`        | `{ includeTemplates? }`                                    | `{ workflows: [{ id, title, valid, enabled, triggers, lastRun }] }` | leitura                               |
| `workflow_get`         | `{ workflowId }`                                           | `{ source, revision, hash, diagnostics, enabled }`                  | leitura                               |
| `workflow_save`        | `{ workflowId?, source, baseRevision?, message, dryRun? }` | `{ ok, workflowId?, revision?, commit?, diagnostics, webhooks? }`   | escrita; `dryRun: true` é a validação |
| `workflow_set_enabled` | `{ workflowId, enabled }`                                  | `{ enabled }`                                                       | escrita                               |
| `workflow_run`         | `{ workflowId, params?, clientRequestId? }`                | `{ runId, status, link }`                                           | escrita                               |
| `workflow_runs`        | `{ workflowId?, status?, limit? }`                         | execuções recentes, resumidas                                       | leitura                               |
| `workflow_run_status`  | `{ runId }`                                                | `RunSummary` mais passos e blocos com texto truncado                | leitura                               |
| `workflow_run_cancel`  | `{ runId }`                                                | `{ status }`                                                        | escrita, destrutiva                   |
| `workflow_ledger`      | `{ ledger?, workflowId?, limit? }`                         | entradas com veredito e números                                     | leitura                               |

Regras:

- **Mesma validação.** Os handlers chamam `WorkflowDefinitions.save` e `WorkflowEngine.start`, os mesmos métodos das RPCs. A edição de um bot vira commit com autor `<nome do bot> (bot)`.
- **Quem pode.** Qualquer bot que não seja de guest pode ler, rascunhar e validar. Salvar com gatilhos ativos, ativar e rodar exigem `canManageBots` (`handlers.ts:123`). Workflow salvo por bot sem essa permissão fica desativado até o Israel ativar no app. Bot de guest não recebe estas ferramentas.
- **Sem portão.** Nenhuma ferramenta decide portão. Só a RPC `gate.decide`, com sessão de usuário, decide.
- **Sem autoedição.** Os handlers recusam quem chama de dentro de uma thread de passo (`WorkflowEngine.isStepThread`). Um workflow não edita, roda nem cancela workflows.
- **Eval.** O texto das ferramentas fala com modelos e precisa de caso em `evals/mcp-tool-use` antes de ir ao ar (AGENTS.md, "Evals"). Hoje o catálogo da eval não inclui toolkits do fork (`evals/mcp-tool-use/run.ts:303`). A fatia 9 inclui os toolkits do fork e casos para "valida com dryRun antes de salvar" e "não tenta aprovar portão".

---

## 7. Canvas: escolha com evidência e fronteira

### 7.1 Protótipos

Três apps Vite descartáveis, um por biblioteca, com o mesmo grafo (merge semanal com fan-out e fan-in), a mesma ida e volta grafo → cena → grafo, o mesmo "patch de bot" (insere "interrogate review" e religa as arestas), modo só leitura em 390×844 e pedaço preguiçoso via `React.lazy`. Builds via `heavy.sh`, um por vez. Prints e testes via Playwright headless, porque o preview do T3 não alcança o localhost desta VPS. Tudo está em [`prototypes/workflows-canvas/RESULTS.md`](../../prototypes/workflows-canvas/RESULTS.md), com os números brutos em `measurements.json` e `evidence.json`.

Versões: React 19.3.0, Vite 8.3.5, Excalidraw 0.18.1, React Flow (`@xyflow/react`) 12.12.0 com roughjs 4.6.6, tldraw 5.6.0.

|                                   |                                                                                Excalidraw |                                                                                               React Flow + roughjs |                                                                                                                                                                                                                       tldraw |
| --------------------------------- | ----------------------------------------------------------------------------------------: | -----------------------------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| Pedaço preguiçoso do canvas, gzip |                                                                     2.481.280 B (2,4 MiB) |                                                                                              **66.563 B (65 KiB)** |                                                                                                                                                                                                          528.916 B (517 KiB) |
| Mesmo pedaço, brotli              |                                                                               2.082.470 B |                                                                                                       **57.771 B** |                                                                                                                                                                                                                    426.181 B |
| CSS, gzip                         |                                                                                  22.724 B |                                                                                                            2.918 B |                                                                                                                                                                                                                     14.843 B |
| Rede em tempo de execução         |                   fonte em `esm.sh` (dá para hospedar com `window.EXCALIDRAW_ASSET_PATH`) |                                                                                                            nenhuma |                                                                                                                                                       ícones e assets em `cdn.tldraw.com` (dá para hospedar com `assetUrls`) |
| Licença                           |             MIT ([LICENSE](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)) |                                                MIT ([LICENSE](https://github.com/xyflow/xyflow/blob/main/LICENSE)) | licença tldraw: "will not work in production without a valid license key" ([tldraw.dev/community/license](https://tldraw.dev/community/license)); `LicenseProvider.tsx` esconde o editor depois de 5 s em produção sem chave |
| Grafo estrito                     |                                     setas podem ficar soltas; a validação precisa recusar |                                                        aresta só nasce entre duas alças; **seta solta não existe** |                                                                                                                                                                  bindings ficam em registros à parte; setas soltas possíveis |
| Ida e volta + patch de bot        |                                    ok (precisou de ids estáveis e `regenerateIds: false`) |                                                                                                                 ok |                                                                                                                                                                                     ok; rótulo de aresta exigiu código extra |
| Exportar SVG                      |                                                                             `exportToSvg` |                                                      não tem (desnecessário: o Android desenha o grafo nativo, §8) |                                                                                                                                                                                                               `getSvgString` |
| Estilo desenhado à mão            |                                                                                    nativo |                roughjs nas caixas e arestas ([print](../../prototypes/workflows-canvas/shots/reactflow-patch.png)) |                                                                                                                                                                                                                       nativo |
| Edição por script (Playwright)    | arrastar e conectar **falharam** (alvo só em canvas, sem calibrar); erro de seta solta ok | arrastar ok, conectar ok, seta solta impossível ok, nota livre ok; **apagar aresta pelo teclado falhou** no script |                                                                                                                                                           arrastar ok; conectar falhou (sem calibrar); erro de seta solta ok |
| Desenho livre (tinta)             |                                                                                       sim |                                                                                          não; notas e molduras sim |                                                                                                                                                                                                                          sim |

Prints: [Excalidraw](../../prototypes/workflows-canvas/shots/excalidraw-patch.png), [React Flow](../../prototypes/workflows-canvas/shots/reactflow-patch.png), [tldraw](../../prototypes/workflows-canvas/shots/tldraw-patch.png), [React Flow editado](../../prototypes/workflows-canvas/shots/reactflow-edited.png) e as versões só leitura `*-readonly.png` na mesma pasta.

**Escolha: React Flow + roughjs.**

- **Licença.** O tldraw sai: o fork é aberto e muita gente roda forks; um editor que some em produção sem chave paga quebra todos eles.
- **Tamanho.** O pedaço do canvas do React Flow é 37 vezes menor que o do Excalidraw (66.563 contra 2.481.280 bytes gzip). Desempenho é um dos inegociáveis do T3.
- **Grafo estrito.** No React Flow o grafo estrito é a forma nativa: nó com alças e aresta entre alças. No Excalidraw e no tldraw é preciso inferir o grafo a partir de desenho livre e recusar o que sobra.
- **Aparência.** O roughjs dá o traço desenhado à mão que o Israel pediu, nas caixas e nas setas.

O preço: sem tinta livre (há notas e molduras), e o atalho de apagar aresta falhou no script. As arestas entre caixas vizinhas são curtas, e o clique do Playwright provavelmente acertou a caixa; a biblioteca suporta seleção e `deleteElements`. A fatia 10 tem check de aceitação para apagar por teclado e por menu de contexto.

**Dependências novas, que precisam do ok do Israel:** `@xyflow/react` (MIT) no web e `roughjs` (MIT) no web e no mobile. Nenhuma outra. `yaml` já é dependência do servidor (`apps/server/package.json:70`), e o mobile já tem `react-native-svg`.

### 7.2 Fronteira do canvas

```ts
/** O que o canvas desenha e edita: grafo estrito + anotações. Em packages/client-runtime/src/workflows.ts. */
export interface CanvasModel {
  readonly nodes: ReadonlyArray<{
    id: string;
    kind: WorkflowNode["kind"];
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    parent: string | null;
    ports: ReadonlyArray<string>;
    status?: StepStatus;
  }>;
  readonly edges: ReadonlyArray<{ id: string; from: string; port: string | null; to: string }>;
  readonly annotations: CanvasLayout["annotations"];
}
export const toCanvasModel = (
  def: WorkflowDefinition,
  layout: CanvasLayout | undefined,
): CanvasModel => {
  throw new Error("not implemented");
}; // autoLayout preenche buracos
/** Nó vem da paleta já tipado (defaultNodeConfig(kind)). Nota vira bloco só por "Converter em bloco",
 *  que pede tipo e campos obrigatórios. Configuração de nó é editada no Inspector (formulário do Schema),
 *  nunca no canvas, então o canvas não produz configuração que o compilador não viu. */
export const fromCanvasModel = (
  m: CanvasModel,
  previous: WorkflowDefinition,
): {
  definition: WorkflowDefinition;
  canvas: CanvasLayout;
  diagnostics: ReadonlyArray<Diagnostic>;
} => {
  throw new Error("not implemented");
};
/** Merge de 3 vias por id de nó e aresta; conflito quando os dois lados mudaram o mesmo item. */
export const mergeDocuments = (
  base: Doc,
  mine: Doc,
  theirs: Doc,
): { merged: Doc; conflicts: ReadonlyArray<string> } => {
  throw new Error("not implemented");
};

export interface CanvasAdapter<Native> {
  readonly fromModel: (m: CanvasModel, mode: "edit" | "run") => Native;
  readonly toModel: (native: Native) => CanvasModel;
}
```

Só `apps/web/src/bots/workflows/canvas/reactFlowAdapter.tsx` conhece o React Flow. Trocar de biblioteca é trocar esse arquivo.

### 7.3 Arquivo, canvas e bot: uma fonte só

- **Onde mora.** Um repositório git em `~/.t3/workflows/definitions/` no host de bots, com um `<id>.workflow.yaml` por workflow. O host cria o repositório no primeiro uso. Só o motor e o Israel escrevem nele; ele nunca é montado num sandbox. Os modelos prontos ficam só leitura em `apps/server/src/bots/workflows/library/`, versionados com o fork; `fromTemplate` copia um deles para o repositório.
- **Revisão.** A revisão de um documento é o sha do blob do **arquivo como está no disco** (`git hash-object <arquivo>`), não o do `HEAD`. Ela cobre o arquivo inteiro, layout incluído.
- **Edição à mão** (o Israel no VS Code, um pull de outro lugar). Um watcher do repositório, mais o tick comparando `git status` e `git rev-parse HEAD`, **ingere** o arquivo mudado, dois segundos depois da última escrita. Se ele é válido, vira commit de autor "Israel (edição à mão)" e nova versão, e aparece no canvas aberto pelo `document.subscribe`. Se é inválido, não vira commit: o workflow fica `valid: false` e `dirty`, com diagnósticos, seus gatilhos gravam `TriggerSkipped{invalid}` e nenhuma versão velha roda no lugar.
- **Quem escreve.** `WorkflowDefinitions.save` é o único escritor do serviço e tem um semáforo **do repositório inteiro**, porque saves de arquivos diferentes mexem no mesmo índice e no mesmo `HEAD`. O save:
  1. ingere primeiro o arquivo do disco, se ele difere do `HEAD` (edição à mão ainda não ingerida e válida vira commit);
  2. dá `Conflict{base, current}` se `baseRevision` ≠ revisão atual do arquivo no disco. Isso vale também para arquivo sujo e inválido: quem chama recebe o texto quebrado como `current`, e um save com `baseRevision` igual à revisão dele substitui o arquivo quebrado. O canvas, a aba Fonte, o bot e o celular conseguem consertar um arquivo que alguém quebrou à mão;
  3. decodifica (YAML via `yaml`, ou definição estruturada), compila e roda as checagens do servidor: projetos existem, o catálogo vivo tem o modelo (indisponível é erro, nunca troca) e os scripts citados existem no projeto;
  4. serializa YAML canônico e reparseia, conferindo o mesmo hash;
  5. escreve com rename atômico, faz `git commit --author` (o Israel, ou `<nome do bot> (bot)`), insere `workflow_versions`, atualiza `workflow_index` e reconcilia as tasks de webhook.

  Entre o passo 2 e o 5, o VS Code ainda pode gravar. Logo antes do rename, o save relê a revisão do disco e volta ao passo 1 se ela mudou. Isso estreita a janela, mas não a fecha, porque rename não é compare-and-swap. Para o caso que sobra, o conteúdo que estava no disco é copiado para `definitions/.overwritten/<id>-<instante>.yaml` antes do rename. Uma gravação do VS Code que caia exatamente entre essa cópia e o rename ainda se perde; é a janela que sobra, de milissegundos. Execuções só fixam commits, nunca um arquivo sujo.

- **Retomada do save.** Os passos são idempotentes e a varredura de partida converge. Arquivo sujo vai pela ingestão. Commit sem linha em `workflow_versions` ganha a linha. As tasks de webhook têm id determinístico, então reconciliar de novo não duplica.
- **Bot com o canvas aberto.** Cada save, de qualquer escritor, sai em `document.subscribe`. Sem edição local, o editor troca o modelo no lugar. Com edição local, mostra "Mudado por Ralph · Recarregar / Mesclar", e o save recebe `Conflict{base, current}`. `mergeDocuments` resolve o que não colide e lista o que colide.
- **Aba Fonte.** O editor mostra o YAML canônico num editor de código que salva pelo mesmo `save`. O YAML canônico perde comentários; texto livre vai em `description`.
- **Fixação.** `RunStarted` grava `commit`, `hash` e os `callPins` dos subworkflows. O ator só lê `workflow_versions`, nunca o `HEAD`.

---

## 8. Mobile (Android)

Entrada por uma linha "Workflows" na tela de Bots, que já é do fork. Não há aba nova, então não mexe nas uniões de abas do upstream. As rotas ficam em `apps/mobile/src/Stack.tsx` (seam existente): `bots/workflows/:environmentId`, `…/:workflowId` e `…/runs/:runId`.

- **Ver.** Lista de workflows com status, próximo disparo e última execução. O detalhe desenha o grafo da versão fixada com `react-native-svg` e o gerador do roughjs (o mesmo `CanvasModel`, posições do `canvas` ou `autoLayout`) e mostra gatilhos e histórico.
- **Disparar.** "Rodar agora" com formulário de parâmetros gerado do `ParamSpec`.
- **Acompanhar.** Tela da execução com o grafo colorido por status, lista de passos (status, duração, tokens, custo estimado, link para a thread do passo, que abre na tela de thread que já existe), visão de cada bloco (rodada do hillclimb e melhor resultado; notas da arena; folhas do graph; achados do interrogate) e controles de pausar, retomar, cancelar e repetir passo. Lê `run.subscribe` com deltas.
- **Aprovar portão.** Folha com a pergunta, a evidência (relatório, link do PR, números), aprovar ou rejeitar e nota. O push de portão aberto chega como `bot_message` e toca na tela da execução: `alert_path: /bots/workflows/<env>/runs/<runId>`, com uma linha a mais no seam do `AgentNotifications.kt:362`, que hoje só aceita `/threads/`. Não há botão de aprovar dentro da notificação, porque isso pediria código nativo novo e outro caminho de autenticação. Abrir e aprovar leva dois toques.
- **Edição leve.** Formulários para o que é seguro no celular: ativar ou desativar, valores padrão de parâmetros, cron e fuso, `model`, `prompt` e `timeout` de um nó, e orçamento. O celular edita a definição decodificada, roda `compileWorkflow` localmente para erro na hora e salva com `baseRevision`. Topologia (nós e arestas) só no desktop.
- **Métricas e ledger.** Resumo por workflow (execuções por status, custo por noite) e a lista do ledger.

A lógica comum (status para cor, agrupamento de passos, merge de deltas e layout) fica em `packages/client-runtime/src/workflows.ts`, como `botDirectory.ts` faz para bots. Web e mobile não duplicam regra.

---

## 9. Proteções

### 9.1 Orçamento por execução

- **De onde vem.** `RunBudget` da versão fixada (passos, tempo, tokens e USD opcional), limitado pelo teto do host (`HostLimits`, configurável no host de bots; padrão 24 h, 30M tokens e 500 passos).
- **O que conta como token.** Entrada sem cache mais saída: `(inputTokens − cachedInputTokens) + outputTokens` de `TurnTokenUsage` (`packages/contracts/src/providerRuntime.ts:56-61`; a entrada inclui cache lido e criado, e a saída inclui reasoning). Com `usageStatus` `partial` ou `unavailable`, os campos podem faltar: o passo é cobrado pela reserva. Leitura de cache fica numa coluna à parte e entra no USD estimado com a taxa própria. Sem isso, um turno de Opus com 50 chamadas a 80k de contexto contaria uns 4M de tokens e estouraria qualquer orçamento no primeiro passo.
- **Tempo.** `wall` conta o tempo ativo da execução. Tempo parado em portão (`waiting_gate`) e em pausa não conta, e aparece separado na tela.
- **Reserva.** Antes de cada `StartTurn`, e de cada `StartUnit` com `tokensFrom` (evals e benches pagos), o passo reserva `tokenReservation ?? estimativa` (média do custo daquele nó nas execuções anteriores, ou o padrão do host). A admissão exige `gasto + reservado + reserva ≤ teto`. Ao assentar, a reserva vira o custo real. Uso desconhecido é cobrado pelo valor reservado, nunca por zero. Um filho (`call`) reserva o orçamento inteiro dele no pai em `StartChildRun`. Por isso `map` com concorrência e subworkflows não gastam duas vezes o mesmo saldo. O comando pago recebe a reserva em `WF_TOKEN_BUDGET` e deve parar ao atingi-la; as CLIs da §11 fazem isso.
- **Teto global.** Os forwarders do proxy medem todo token que passa por eles e são a medida autoritativa do gasto total dos workflows, inclusive o que não é turno do T3, como um `curl` em laço ou um subagente do CLI. Passado `HostLimits.workflowTokensPerDay`, eles recusam e o motor pausa as execuções (§9.5).
- **Estouro.** O `decide` para de admitir, interrompe turnos e units vivos e termina em `budget_exhausted`. `amendBudget` seguido de `resume` é o caminho de volta.
- **Limite honesto.** O Codex só fecha a contagem do turno no fim (`CodexTurnTokenUsage.ts:96-138`). Um turno longo pode passar da reserva. Os limites duros são o `timeout` do passo e, onde o provider reporta uso acumulado no meio do turno, um vigia que interrompe em duas vezes a reserva. USD é estimativa via `usagePricing` e só vale quando todo passo tem preço; senão a tela diz "custo desconhecido", nunca zero.

### 9.2 Fadiga

- **Na execução.** A dobra conta passos `failed`, `lost`, `timed_out` e medições inválidas seguidas desde o último sucesso. Candidato rejeitado com medição válida não conta. Em N, o `decide` grava `RunPaused{fatigue}` e um `Notify` com chave `notify:fatigue:<runId>:<n da pausa>`: um aviso lógico por pausa. A entrega é pelo menos uma vez, deduplicada no aparelho.
- **No workflow.** N `RunOutcome` falhos seguidos gravam `Suspended`, mandam um push e fazem os gatilhos gravarem `TriggerSkipped{suspended}` até `Unsuspended`.

### 9.3 Um passo pesado por vez

- Comandos nunca rodam na árvore de processos do servidor. `CommandRunner.start` cria **uma** unit no gerenciador de usuário do Israel, que roda o `wfUnit`, que roda o comando num container (comando completo na §9.5). Com `heavy: true`, quem pega o lock do `heavy.sh` é o próprio container (`wf-run --heavy`), com o arquivo montado só leitura, então o lock dura exatamente o que o comando dura, mesmo se a unit morrer. Os limites vão nas flags do container com os equivalentes do `heavy.sh` (`CPUWeight=20`, `IOWeight=20`, `MemoryMax=6G`, `Nice=19`): `--cpu-shares`, `--blkio-weight`, `--memory 6g` e prioridade baixa no processo.
- O motor não chama o `heavy.sh` diretamente. Ele abre uma segunda unit (`systemd-run --wait`), que pode sobreviver à primeira: se a de fora morre, o flock é solto enquanto a de dentro continua, e duas cópias rodam. Com o lock no container, quem segura o lock é o processo que faz o trabalho.
- `wfUnit` roda fora do container, como Israel, e grava os recibos em `~/.t3/workflows/receipts/`, que nenhum container monta. Ele escreve `started.json` e faz fsync quando o container avisa que pegou o lock (`WF-LOCKED`) e **antes** de liberar o argv (`GO`). Quando o filho termina, grava `exit.json` com o código de saída que ele mesmo observou, por rename atômico. O comando não consegue forjar um recibo. `queuedMs = started − spawned`, e espera de lock não conta como execução.
- O lock nunca é aninhado. O compilador recusa `heavy` junto com `selfSerializing` ou com argv que cita `heavy.sh`.
- **Agentes e comandos que chamam `heavy.sh`** (o agente rodando typecheck, o `run.py` do bench por episódio) usam o mesmo caminho por dentro do sandbox. Lá, `/home/israel/.cache/t3-testdata/heavy.sh` é um shim da imagem que manda `{ argv, cwd }` pelo socket `~/.t3/workflows/heavy.sock`, montado no container, ao **broker pesado** do motor. O broker atribui o pedido ao passo dono de `cwd` (uma worktree ou diretório de execução conhecido; qualquer outro é recusado), roda outro container como acima, com o lock e as mesmas flags, e devolve saída e código de saída pelo socket. O broker não dá ao chamador nada que o container já não tenha: a fronteira de confiança é o conjunto de execuções de workflow (§9.5), e o comando roda nela. O bench do argo35 é a exceção: roda inteiro num container com `run.py --no-heavy`, com o lock seguro pelo `wf-run --heavy` do container do começo ao fim, porque os episódios precisam do display que o próprio `run.py` sobe.
- **Limite.** Um agente que rode `cargo build` sem passar pelo `heavy.sh` não é serializado. O container do provider tem `--cpus` e `--memory` próprios, então isso fica limitado, mas não em fila. O prompt base de passo manda usar `heavy.sh`.
- Cancelamento: `systemctl --user stop wf-<k>`. Nunca por padrão de nome.

### 9.4 Idempotência depois de crash

Resumo da §3.4:

| Efeito      | Protegido por                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| thread      | recibo do `commandId` no upstream (`launch` e `sendToThread`)                                                                |
| comando     | nome da unit + `started.json` gravado antes do argv + `exit.json`; `replay: never` sem recibo vira `ambiguous`               |
| git         | compare-and-swap no `update-ref`; merge conferido com `is-ancestor`; push sem força recusado se a ref remota não é ancestral |
| PR          | busca pela branch antes de criar                                                                                             |
| ledger      | chave única do fato                                                                                                          |
| portão      | a primeira decisão vence                                                                                                     |
| notificação | pelo menos uma vez, deduplicada no aparelho pela chave                                                                       |

### 9.5 Ações proibidas: barreira estrutural

Um agente com shell faz qualquer coisa que o prompt proíba. Neste host, credencial e controle estão por toda parte:

- o Israel está no grupo `docker`;
- o `t3-friend.service` carrega tokens no ambiente;
- `~/.railway` faz deploy;
- os homes do Claude e do Codex trazem MCPs de deploy e hooks;
- no `127.0.0.1` respondem serviços sem autenticação: o T3 em `:3773`, o `pluggy-mcp` em `:3796` com dados bancários e o `cliproxyapi` em `:8317`;
- o display X `:99` do computer use do host e um VNC em `[::]:5900` estão expostos;
- o repositório de produção usa `core.hooksPath` relativo, e qualquer git do host numa pasta que um passo escreve lê config que o passo controla (por `.git`, `commondir`, `gitdir` ou um layout bare).

Esconder caminho por caminho não fecha isso. A barreira é a mesma que o fork já usa em produção para os bots de guest (`apps/server/src/bots/guest/sandbox/`): **cada sessão de provider e cada comando roda num container Docker**. A escolha contra a alternativa de usuário Unix próprio com `bwrap` está na §9.6.

**1. O container.** Flags do guest (`t3-guest-claude:89-96,184-191`), com um uid próprio:

- `--user 10001`, conta `wf` criada na imagem; o guest usa 1000, que no host é o uid do Israel, e o workflow não;
- `--cap-drop ALL`;
- `--security-opt no-new-privileges`;
- `--read-only` e `--tmpfs /tmp`;
- `--memory`, `--cpus` e `--pids-limit`;
- o seccomp e o AppArmor padrão do Docker;
- `--rm --init`.

O container vê a imagem e os volumes montados, e só. Não existe `/home/israel`, socket do Docker, `/run` do host, barramento do systemd nem processo do host. O teste do guest prova isso com um container de verdade: `sandbox.docker.test.ts:79-100` cobre o host escondido, `CapEff` zero, `NoNewPrivs` e nenhum socket do Docker.

A imagem `t3-workflow-sandbox` é nova, num Dockerfile em `apps/server/src/bots/workflows/sandbox/`, a partir da mesma base do guest. Ela traz node, pnpm, vp, rust, git, `claude`, `codex`, `wf-git` e o shim do `heavy.sh`, mais o que o bench e o computer use pedem: Xvfb, i3, D-Bus, xdotool, alacritty e o Chrome for Testing. O build passa pelo `heavy.sh`. Volumes novos nascem do root: na criação, o fork roda uma vez `docker run --rm --user 0 --cap-drop ALL --cap-add CHOWN -v <volume>:/v t3-workflow-sandbox chown <dono> /v`, com dono 10001 para os volumes de passo e 1000 para o do proxy.

**2. Rede.** Os containers ficam numa rede criada com `docker network create --internal --ipv6=false -o com.docker.network.bridge.gateway_mode_ipv4=isolated t3-wf-internal`. Uma rede `--internal` comum ainda dá ao host um endereço na bridge, e os containers alcançam por ele qualquer serviço do host que escute em `0.0.0.0` ou `::`, como o `sshd` deste host em `0.0.0.0:22`. O modo `isolated`, que só vale junto com `--internal`, não dá endereço nenhum à bridge ([documentação do Docker](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)).

A única saída é um container de proxy (`t3-wf-egress`) ligado a essa rede e a uma bridge comum, com o mesmo `proxy-main.mjs` + `egress-proxy.mjs` do guest: CONNECT só para endereço público (`isPublicAddress`). O socket abstrato do X `:99` fica preso ao namespace de rede do host. O ambiente leva `HTTPS_PROXY` e `HTTP_PROXY` para `egress:3128` e `NO_PROXY=localhost,127.0.0.1,egress`, como no guest (`t3-guest-claude:169-172`).

O teste do guest (`sandbox.docker.test.ts:102-127`) prova que o proxy recusa o host e que `127.0.0.1:3773` e o `:22` dos IPs do host ficam bloqueados. Ele **não** prova o caso da bridge: monta a lista de endereços do host antes de a rede existir e não tenta a porta 5900. O teste do workflow cobre isso (fatia 4). O sandbox do guest em produção usa `--internal` sem `isolated` e tem a mesma lacuna; corrigi-lo fica fora deste desenho, mas vale um ticket próprio.

**3. Credenciais só no proxy.** O container recebe placeholders. As credenciais reais são montadas só leitura no container do proxy, e os forwarders as põem nas chamadas:

- o do Anthropic é o do guest (`api-forward.mjs`, com rotas e modelos permitidos; o teste das linhas `:129-200` e `:289-306` prova que a chave fica só no proxy);
- o do OpenAI é novo, no mesmo molde. O token de acesso vem do `CodexManagedTokenBroker` do T3: o motor o grava num diretório de credenciais dele (`~/.t3/workflows/secrets/proxy/`), montado só leitura no proxy **como diretório**, e troca o arquivo lá dentro com rename atômico antes de o token vencer. O forwarder relê o arquivo a cada chamada. Montar o arquivo sozinho não serviria: a montagem continuaria apontando para o arquivo antigo depois do rename, e o guest monta um diretório pelo mesmo motivo (`t3-guest-claude:56-58`);
- o container do proxy roda como uid 1000, como o do guest, porque é código confiável e o único que lê os arquivos de credencial (0600, do Israel). Os containers de passo, com uid 10001, não leem nada disso;
- a lista de modelos vem das versões fixadas das execuções vivas, mais o modelo auxiliar do Claude Code (`claude-haiku-5-5`, também em `ANTHROPIC_SMALL_FAST_MODEL`);
- os forwarders medem todo token. O proxy guarda o contador do dia num volume só dele (`t3-wf-egress-state`, iniciado com dono 1000, não 10001, e montado só no proxy) e recusa quando passa do teto (`HostLimits.workflowTokensPerDay` e o fuso do host em `TZ`, passados no ambiente do proxy, para que o dia dele vire junto com o do motor). Ele também escreve uma linha JSON por chamada no stdout, e o motor segue esse log (`docker logs -f t3-wf-egress`, de um container confiável) para o painel e para pausar as execuções com `RunPaused{host_daily_cap}`. Na virada do dia, no fuso do host, o contador zera e o motor retoma sozinho o que pausou por esse motivo.

**4. O host nunca vê os dados de um passo.** Esta é a regra que fecha a classe de achados mais repetida da revisão: git, scripts de setup ou leituras do servidor tocando pasta que um passo escreve.

- **Volume.** Clones, worktrees, saídas e `/tmp` das execuções ficam no volume Docker `t3-wf-runs`, do uid 10001. Os dados de um volume ficam em `/var/lib/docker`, que o Israel não lê.
- **Placeholder.** O caminho que o servidor T3 usa como cwd de uma thread é um **placeholder**: um diretório vazio do Israel, modo 0555, em `~/.t3/workflows/cwd/<runId>/<nome>/`, que o motor cria antes do passo. Todo container monta o volume no mesmo caminho absoluto (`-v t3-wf-runs:/home/israel/.t3/workflows/cwd`).
- Dentro do container, o caminho mostra a worktree. No host, mostra um diretório vazio que nenhum passo consegue escrever. O servidor faz `chdir` nele, o `isGitRepository` dá `false` (não há `.git` nele nem acima dele até `/`, conferido), o checkpoint é pulado (`CheckpointService.ts:245`), e as leituras do adapter do Claude (`.git`, `.claude/settings*.json`) não acham nada.
- Não há symlink para seguir nem repositório bare para plantar.
- **Ordem.** O motor cria o placeholder no host. Depois, `wf-git prepare` (um comando com `-w` na raiz do volume) cria a pasta da worktree dentro do volume. Só então uma sessão de provider ou um comando usa esse caminho como `-w`. O wrapper recusa `-w` que ainda não existe no volume, em vez de deixar o Docker criá-lo como root.

**Como o código entra e sai.** Com bundles git e stdout, como antes:

- **Entrada.** O motor gera um bundle a partir do repositório de produção, com uma ref de transferência no sha pedido que ele apaga depois. O primeiro bundle é completo; os seguintes são incrementais, e se o espelho já tem o sha não há bundle. Um contêiner "escritor" do motor recebe o bundle pelo stdin e o grava no volume `t3-wf-inbox`, que os passos montam só leitura. Um comando do sandbox atualiza o espelho e clona a execução (`git clone --shared`), escrevendo os remotos (`origin` = espelho, `upstream` = URL pública).
- **Saída.** `wf-git export-bundle <sha>`, no container, escreve `git bundle create - refs/wf-out/<sha>` no stdout. O `wfUnit` grava o stdout num temporário dentro de `~/.t3/workflows/publish/<proj>.git`, o repositório bare do motor. O motor roda `bundle verify` e `fetch` com refspec exato (`refs/wf-out/<sha>:refs/wf-import/<runId>/<chave>`), confere o sha com o do journal, faz push sem força para a `WfBranch` e roda `gh pr create --draft`. O `publish/` tem `origin` com a URL do GitHub conferida contra uma lista do host, `core.hooksPath=/dev/null` e um gitconfig global fixo do motor com o credential helper do `gh`.
- **Artefatos.** `wf-git export-artifact` sai pelo stdout e é gravado pelo escritor no volume `t3-wf-artifacts`, que os passos montam só leitura.
- **Tetos de stdout.** 1 MiB para JSON, 512 MiB para bundle e 2 GiB para artefato. Passou do teto, o `wfUnit` mata o comando e o passo falha.
- **Git do motor.** `engineGit()` só aceita o repositório de produção e o `publish/`. O resto do git (medir sha, `is-ancestor`, `diff --name-only`, criar e remover worktree, mergear folha) é `wf-git` no container, com JSON no stdout.

**Como o container chega ao passo.**

- **Providers.** As instâncias `claudeWorkflow` e `codexWorkflow` têm `binaryPath` em `wf-claude` e `wf-codex`, wrappers do fork no molde de `t3-guest-claude`, e `homePath` num diretório vazio do Israel, então o servidor não acha skills nem config do host para elas. O wrapper faz `docker run --rm -i --init` com as flags acima, os volumes `t3-wf-runs` (no caminho do placeholder), `t3-wf-inbox` e `t3-wf-artifacts` (só leitura), `t3-wf-home-<provider>` em `/home/wf` (sem MCP, hooks, `notify` nem skills) e o socket do broker pesado.
- **cwd e ambiente.** `-w "$PWD"` mantém o cwd. O guest não faz isso (o entrypoint dele entra numa pasta fixa), então essa parte é nova e a fatia 4 testa. O `docker run` não herda o ambiente do host: só passa o que vem em `-e`. Os nomes que o SDK usa vão explícitos, como no guest (`t3-guest-claude:180-182`).
- **Sondas.** O `--version` vira um `docker run --network none`, como no guest (`:84-86`).
- **Claude e Codex.** O Claude abre um container por sessão, e o wrapper recusa `$PWD` fora de `~/.t3/workflows/cwd/`. O `codex app-server` é um container por processo, com `-w` na raiz do volume, e o cwd de cada thread chega pelo protocolo. Como todo container monta o volume inteiro, um app-server que já está de pé enxerga execuções criadas depois. Por isso a fronteira de confiança é **o conjunto de execuções de workflow**, não o passo. Dentro dela, um passo `read` ganha worktree descartável, cada thread tem um único acesso e uma única worktree, e o motor só confia no journal (shas gravados, checks dele, recibos, bundles verificados).
- **Comandos e o lock pesado.** O `CommandRunner` cria a unit `systemd-run --user --unit=wf-<k> --collect -p ExecStopPost="docker rm -f wf-cmd-<k>" -- wfUnit --receipt <dir> -- docker run --rm -i --name wf-cmd-<k> --label t3.workflow=<runId> … --mount type=bind,src=/home/israel/.cache/t3-testdata/heavy.lock,dst=/run/wf/heavy.lock,readonly -w <cwd> t3-workflow-sandbox wf-run [--heavy] -- <argv>`. **Quem segura o lock é o próprio container**, não a unit:
  1. o `wf-run`, dentro do container, faz `flock /run/wf/heavy.lock` (o mesmo arquivo do `heavy.sh`; `flock` vale entre namespaces);
  2. com o lock, ele escreve `WF-LOCKED` no stderr e espera `GO` no stdin;
  3. o `wfUnit` grava o `started.json` com fsync e manda `GO`;
  4. só então o `wf-run` executa o argv.

  Se o `wfUnit` morrer antes do `GO`, o stdin fecha e o argv nunca roda. Se a unit parar depois, por cancelamento ou porque o `wfUnit` morreu, o `ExecStopPost` derruba o container, e o lock só é solto quando ele morre: nenhum outro comando pesado começa no meio. Se o próprio gerenciador do usuário cair, o `ExecStopPost` não roda, e o container segue com o lock até terminar. A ativação põe o `heavy.lock` em 0644, porque o uid 10001 precisa abri-lo para leitura, e o monta com `--mount`, que recusa arquivo inexistente em vez de criar um diretório no lugar. Depois de um restart, o motor adota pelo nome do container: se ele ainda roda, espera; se sumiu sem `exit.json`, a saída se perdeu, e vale `replay` (`safe` refaz, `never` vira `ambiguous`). O broker pesado e o bench usam o mesmo caminho, sempre por uma unit do `CommandRunner`.

- **Agentes que chamam `heavy.sh`.** O shim no caminho do `heavy.sh` manda `{ argv, cwd }` pelo socket ao broker. O broker atribui o pedido ao passo dono do `cwd` e o roda por uma unit do `CommandRunner`, como acima, com `wf-run --heavy`.
- **O bench do argo35** roda inteiro num container, com `run.py --no-heavy`, e o `wf-run --heavy` desse container segura o lock do começo ao fim. Xvfb, i3, D-Bus e Chrome sobem dentro do container, e o display do host nunca entra.
- **Containers que sobram.** Todo container de workflow leva o rótulo `t3.workflow`, mais `t3.workflow.wrapper=<pid>:<início do processo>:<boot id>` com o processo que o lançou (o instante de início evita confundir um pid reaproveitado no mesmo boot). Os de comando levam também o passo. Os do Claude levam o passo tirado do `$PWD`, porque são um por sessão. O do Codex não tem passo, porque um app-server serve várias threads. Uma sessão está viva enquanto existe, no mesmo boot, um processo com aquele pid e aquele instante de início. A varredura roda em todo tick do motor, não só na partida, então um wrapper antigo que o servidor ainda vai parar na subida sai na passada seguinte. Antes de uma nova tentativa, ele remove os containers de comando e do Claude rotulados com aquele passo. No Codex, a tentativa anterior é parada pelo `interruptThread` do T3 na thread dela, já que o container é compartilhado.
- **Só o motor usa essas instâncias.** O `BotsService` (do fork) recusa `claudeWorkflow` e `codexWorkflow` como modelo de bot e no fallback do `makeRegular`. Um `isWorkflowLauncher` separado do `isSandboxLauncher` evita que `runsOnHost` mude para elas (`sandboxInstance.ts`, `BotsService.ts:391-394`). Uma thread comum que alguém crie nelas falha: o cwd dela não está no volume.
- **Sem scripts de projeto.** As threads de passo pertencem ao projeto T3 "Workflows", com raiz em `~/.t3/workflows/cwd` e `projectSettingsOverrides[<id>].defaultProjectScripts = []`. Sem script, `resolveProjectScripts` (`packages/shared/src/projectScripts.ts:11-21`) não devolve nada para setup nem para settle, e mesmo que devolvesse, rodaria num placeholder vazio.
- **Remoção.** O uid 10001 é dono de tudo no volume, então `wf-git remove` apaga a worktree inteira e roda `git worktree prune`. Se a worktree já não existe, conta como feito, então ele é `replay: safe`. O motor apaga o placeholder. Quando a execução acaba, as worktrees saem conforme o `retain` de cada uma (padrão: ficam só se a execução falhou). A árvore inteira sai 7 dias depois do fim (`HostLimits.runRetention`), menos as worktrees com `retain: always` ou com PR aberto.

**Camadas:**

| Camada                  | Mecanismo                                                                                                                 | O que impede                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1. Container            | flags e imagem do guest, uid 10001, seccomp e AppArmor do Docker                                                          | ler ou escrever o host, Docker, `systemctl`, sinal para o servidor, envenenar config de sessões fora |
| 2. Placeholder + volume | o host vê um diretório vazio e imutável; os dados ficam num volume que o Israel não lê                                    | git, scripts, adapter ou motor do host lendo, seguindo ou executando algo que um passo escreveu      |
| 3. Rede interna + proxy | `--internal`, `egress-proxy`                                                                                              | T3, MCP do T3, `:3796`, `:8317`, X `:99`, VNC, rede da casa e Tailscale                              |
| 4. Sem credencial       | forwarders no container do proxy                                                                                          | push, merge, chamadas em nome do Israel, exfiltrar token, gastar fora do medidor                     |
| 5. Sem MCP do T3        | além da rede, o hunk do fork em `McpHttpServer.ts:239` recusa (403) toda thread `wf:`                                     | `t3_thread_send`, `delegate_task` etc. se a rede vazar                                               |
| 6. Modo de runtime      | `full-access` dentro do container; pedidos ao usuário recebem `AnswerRequest(decline)` ou viram portão com `askIsrael`    | travar a madrugada esperando aprovação                                                               |
| 7. Só o motor publica   | intents fechados; `OpenPullRequest` com sha do journal, bundle verificado, push sem força para `WfBranch`, PR em rascunho | o próprio motor e qualquer definição                                                                 |
| 8. Lint                 | `classifyCommand` ao salvar                                                                                               | feedback cedo; não é barreira                                                                        |
| 9. Sentinela            | `git rev-parse` na produção e `git ls-remote origin` das refs protegidas antes e depois de cada passo                     | detecta em até um passo o que escapar                                                                |
| 10. Proteção remota     | ruleset do GitHub na `friend/main`                                                                                        | última camada, externa (pergunta aberta 2)                                                           |

**Tarefas do host.** Um nó `host` só nomeia uma tarefa de um registro fechado no código do fork (`apps/server/src/bots/workflows/hostTasks/`), sem argv nem cwd. Hoje há uma, `extract-corrections` (§11.4):

1. faz a cópia só leitura do `statev2.sqlite`;
2. tira dela só os campos permitidos (correção do Israel, texto anterior do assistente sem saídas de ferramenta, ids de evidência);
3. manda o JSONL pelo escritor para o volume `t3-wf-inbox`.

**Autoteste.** Na partida, o motor roda um container de passo e só libera passos se tudo isto se confirmar:

- `/home/israel` só tem o caminho do volume;
- não há socket do Docker;
- `CapEff` é zero;
- `127.0.0.1:3773`, `:3796` e `:8317`, os IPs do host e de todas as bridges (lidos depois de a rede existir), nas portas 22 e 5900, estão bloqueados, direto e pelo proxy;
- a bridge `t3-wf-internal` não tem endereço no host;
- o display `:99` não abre;
- nenhuma variável tem segredo, só placeholders;
- `git push` sem credencial falha;
- um modelo fora da lista é recusado.

Do lado do host:

- `git rev-parse` num placeholder falha;
- a lista de scripts do projeto "Workflows" está vazia;
- os placeholders estão vazios e com modo 0555;
- o `heavy.lock` abre para leitura como uid 10001.

Se algo falhar, os passos ficam recusados (fechado por padrão) e o motor avisa.

Portões nunca destravam as camadas 1 a 7. Um portão aprova o workflow continuar suas próprias ações permitidas. "Mergear na friend/main" é sempre um `handoff`.

**Preparação.** Não precisa de root, usuário novo, sudoers nem mudança no gitconfig do Israel: o servidor já usa Docker para os guests, e o Israel está no grupo `docker`. Na ativação, o fork cria a imagem, a rede interna, o container do proxy e os volumes, de forma idempotente, como o `ensure_infra` do guest (`t3-guest-claude:99-130`).

### 9.6 Isolamento: Docker contra usuário Unix próprio com `bwrap`

O desenho passou cinco rodadas de revisão com outra barreira: um usuário de sistema `t3wf`, entrado por `sudo`, dentro de um `bwrap` sem rede do host, com diretórios setgid compartilhados entre o Israel e o `t3wf`. Quase toda rodada achou uma fuga nova (A9, B31, A14, B43, B48). O supervisor pediu a comparação com o modelo do guest antes de fechar. A tabela separa o que depende da tecnologia do sandbox do que é integração com o host e vale para os dois.

| Classe de achado                                                           | `t3wf` + `bwrap`                                                                                                                                                                | Docker + placeholder                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segredos no ambiente e em arquivos do host (A2, B1)                        | fechada com `--clearenv`, permissão por uid e tabela de montagens; código novo, sem teste                                                                                       | fechada por construção: o container só tem imagem e volumes, e o `docker run` só passa o ambiente que vem em `-e`. O teste do guest prova o host escondido (`sandbox.docker.test.ts:79-100`)                                                      |
| Home do provider gravável e MCP de deploy (B2)                             | home próprio em `/srv/t3wf/homes`                                                                                                                                               | volume próprio, como o home do guest                                                                                                                                                                                                              |
| Rede: T3, serviços locais, X `:99`, VNC (B31, A19, B53)                    | `--unshare-net` + ponte de loopback para sockets unix; código novo, sem teste                                                                                                   | rede `--internal` em modo `isolated` + container de proxy. O teste do guest prova o proxy e o `127.0.0.1` (`:102-127`), mas não a bridge nem a porta 5900; o modo `isolated` e esse teste são novos                                               |
| Credencial dentro do sandbox, gasto fora do medidor (B32, B38, A17)        | forwarders como processos do host atrás de sockets                                                                                                                              | forwarders no container do proxy; o do Anthropic testado no guest (`:129-200`, `:289-306`)                                                                                                                                                        |
| Git do host em pasta que o passo escreve (B3, A9, B26, B44, B48, A18)      | quatro mecanismos: uid diferente, esqueleto do Israel com folhas setgid, `safe.bareRepository=explicit` no gitconfig global do Israel e `safe.directory` só no perfil           | fechada por construção: o host só vê um placeholder vazio e imutável, e os dados ficam num volume que o Israel não lê                                                                                                                             |
| Script de setup e leituras do adapter no cwd (A14, A16)                    | projeto "Workflows" sem scripts + hunk novo no `ClaudeAdapterV2`                                                                                                                | projeto "Workflows" sem scripts; o adapter lê um diretório vazio, e o hunk não é preciso                                                                                                                                                          |
| Symlink lido pelo motor; tarefa do host; dados do snapshot (B36, B43, B37) | regra do stdout, registro fechado, lista de campos                                                                                                                              | igual                                                                                                                                                                                                                                             |
| cwd, ambiente e sondas do wrapper (A11, B30, A15, B42)                     | protocolo `--cwd`/`--env` por cima do `env_reset` do sudo; código novo                                                                                                          | `-e` explícito e `--version` à parte, padrão do guest testado com o CLI real (`:357-381`); o `-w` no caminho do placeholder é novo (o guest entra numa pasta fixa)                                                                                |
| Remoção e retenção (B49)                                                   | remoção em dois lados, porque nenhum dos dois apaga tudo                                                                                                                        | o uid 10001 apaga tudo no volume; o motor apaga o placeholder                                                                                                                                                                                     |
| Lock pesado e limites (B22, B23, A20, B54)                                 | unit única + scope com CPU e memória                                                                                                                                            | o container segura o lock (`wf-run` com handshake `WF-LOCKED`/`GO`) + `--cpu-shares`, `--blkio-weight` e `--memory` equivalentes aos do `heavy.sh`; o `ExecStopPost` derruba o container em toda parada da unit, e o lock só sai quando ele morre |
| Bench e computer use (A3, B4)                                              | episódios pelo broker com `/tmp` compartilhado por execução                                                                                                                     | o bench inteiro num container com `--no-heavy` sob o lock; X dentro do container                                                                                                                                                                  |
| Superfície do kernel                                                       | o processo do sandbox tem user namespaces sem privilégio (o Ubuntu restringe isso de propósito: `kernel.apparmor_restrict_unprivileged_userns = 1`) e nenhum seccomp por padrão | seccomp e AppArmor padrão do Docker, sem capabilities; o daemon é root, e uma fuga do kernel cai como root (sem `userns-remap`)                                                                                                                   |
| Preparação do host                                                         | root: usuário, `/srv/t3wf`, sudoers com `!use_pty`, toolchains próprias, gitconfig global do Israel                                                                             | nenhuma: Docker já está no host e o Israel já está no grupo                                                                                                                                                                                       |
| Seams                                                                      | 10 arquivos (inclui o `ClaudeAdapterV2`)                                                                                                                                        | 9 arquivos                                                                                                                                                                                                                                        |

**Custo na VPS** (4 vCPU, 16 GB), medido aqui:

- `docker run` com imagem em cache sobe em 0,16 a 0,23 s;
- cada container custa cerca de 9,5 MB de RSS no `containerd-shim`;
- o proxy tem teto de 256 MB, como o do guest.

Numa noite típica rodam ao mesmo tempo o proxy, um app-server do Codex, de duas a quatro sessões do Claude e um comando pesado: menos de 200 MB além do que os próprios agentes usam. O `bwrap` sobe em milissegundos e quase não custa memória, mas a diferença não pesa num passo que dura minutos. A imagem deve ficar com 2,5 a 3,5 GB (a base do node tem 333 MB, medida; o resto são o rust, o Chrome, o X e os CLIs, estimados). Ela é construída uma vez via `heavy.sh` e refeita quando as ferramentas mudam.

**O que já existe e o que é novo.**

- **Já existe no fork e está testado em produção, para os guests:** cerca de 1.200 linhas, com um teste de 447 linhas que roda Docker de verdade. São as flags de endurecimento, a rede interna com proxy (sem o modo `isolated`), o forwarder do Anthropic com lista de modelos, o `--version` à parte e o CLI do Claude num container com retomada de conversa.
- **É novo:** a imagem com as ferramentas, o Codex e o X (com a conta `wf`, uid 10001); o modo `isolated` da rede; o forwarder do OpenAI e o arquivo de token; a medição e o teto diário; o `-w` no placeholder sobre o volume; o escritor de inbox e artefatos; o broker pesado; o `wf-run` com o lock dentro do container; o rótulo e a limpeza de containers. Também uma cópia do teste do guest para a imagem de workflow, com o Codex, a bridge descoberta depois de criada e a porta 5900.
- **No `bwrap`, tudo seria novo:** `wf-enter`, a ponte de rede, o setup com root e o sudoers, e nenhum teste existe.

**Decisão: Docker, no molde do guest.**

- Ele fecha por construção as classes que o `bwrap` só fechava com quatro mecanismos e configuração no host. A mais repetida era o git do host em pasta do passo.
- Ele reaproveita isolamento que já roda e já tem teste.
- Ele não pede root nem mudança na config do Israel, e tira uma seam.
- O preço é cerca de 0,2 s por container e alguns GB de imagem.
- O risco que fica é o daemon root: uma fuga do kernel de dentro do container cai como root, e não como `t3wf`. Seccomp, AppArmor, `cap-drop ALL`, `no-new-privileges`, rootfs só leitura e uid sem conta reduzem essa chance mais do que o `bwrap`, que expõe user namespaces ao processo. Ligar `userns-remap` mudaria todos os containers do host, inclusive os de guest, e fica de fora.

---

## 10. Custo, tokens, painel de métricas e ledger

- **Por passo.** O sensor lê os provider turns da tentativa, mais as continuações de restart. Usa `turnTokenUsage` (`packages/contracts/src/providerRuntime.ts:57`): entrada já inclui cache e saída já inclui reasoning, então não soma de novo. Grava `complete | partial | unavailable`. O USD estimado sai das taxas de `usagePricing` (`apps/server/src/usage/usagePricing.ts:11`). Subagentes nativos não entram no total garantido, e a tela diz isso. Comandos com `tokensFrom` (evals pagos) somam o que imprimem.
- **Painel por workflow** (`metrics`). Execuções por status, duração e custo por execução (série), taxa de falha e tokens médios por nó, e séries das métricas que os comandos emitem (por exemplo `throughput_ratio` noite a noite), com o veredito de cada ponto.
- **Ledger.** Tela própria (web e Android) com filtro por ledger, workflow e veredito: hipótese, barra (hash e texto), antes, depois, sha e link da execução.
- **Kanban.** `card.project` cria um ticket local por execução (`UpsertCard`, chave = runId), move a coluna com o status (todo → in_progress → in_review em portão → done) e liga as threads dos passos. Projeto ligado ao Linear é recusado na validação, porque criar ticket nele seria uma mutação externa no Linear (`KanbanService.ts:840`).
- **Push.** Construtor puro no padrão de `botPushNotice.ts:110` para portão aberto, execução terminada (pronta para revisão, falha, sem ganho), fadiga e sentinela. Usa o `t3_kind: "bot_message"` que o Android já entrega (`AgentNotifications.kt:23-26`; um tipo novo seria descartado), com `alert_path: /bots/workflows/<env>/runs/<runId>`. Reusa `BotPushDelivery` e os aparelhos registrados.

---

## 11. Biblioteca de workflows prontos

Modelos em `apps/server/src/bots/workflows/library/`. Cada um depende de CLIs auxiliares que imprimem JSON e ainda não existem. A fatia 12 escreve todos eles.

| CLI                                                                                | Repositório        | Contrato                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/friend/wf/select-upstream-tag.ts`                                         | t3code             | `ls-remote` + fetch da tag para `refs/wf/upstream/<tag>` + `is-ancestor` contra a base → `{ tag, tagSha, contained }`                                                                                                                                                                                                                |
| `scripts/friend/merge-upstream.ts --json --into <worktree>`                        | t3code             | idempotente: tag já mergeada → `merged`; imprime `{ status: merged \| conflicts, conflicts[] }`                                                                                                                                                                                                                                      |
| `scripts/friend/wf/fork-checks.ts --json`                                          | t3code             | `check-seams`, `vscode-theme --check` e testes do fork → `{ seams, theme, tests, failures[] }`                                                                                                                                                                                                                                       |
| `bench/agent/argo35_metric.py`                                                     | computer-use-linux | `--suite argo35-train \| argo35-holdout` (o split congelado de `METRIC.md`); roda `run.py` intercalando base e candidato, valida cobertura (uma linha por variante, tarefa e rep; binários com hash) → `{ complete, baseline, candidate, throughput_ratio, regressed_tasks, errors, tokens }`; sai ≠ 0 só se a comparação é inválida |
| `bench/agent/sol_suites.py`                                                        | computer-use-linux | roda `sol-easy`, `sol-hard` e `sol-long` com o binário dado num diretório novo e chama `sol_regression.py` nele; sai ≠ 0 em regressão                                                                                                                                                                                                |
| `scripts/friend/wf/mcp-token-count.ts --json`                                      | t3code             | inventário servido inteiro, toolkits do fork incluídos → `{ total, perTool, method }` (`chars/4` declarado; tokenizer quando houver)                                                                                                                                                                                                 |
| `scripts/friend/wf/mcp-eval-verdict.ts`                                            | t3code             | `pnpm mcp-tool-use` contra baseline fixado → `{ complete, case_regressions, usage }`                                                                                                                                                                                                                                                 |
| tarefa do host `extract-corrections` (`apps/server/src/bots/workflows/hostTasks/`) | t3code             | código do servidor, do lado do Israel: backup só leitura do `statev2.sqlite` e JSONL com só os campos permitidos, gravado pelo escritor no volume `t3-wf-inbox` (`/wf/inbox/<runId>/` nos containers) (§9.5)                                                                                                                         |

### 11.1 Merge semanal do upstream

````yaml
schema: t3.workflow/v1
id: upstream-merge
title: Merge do upstream
home: { project: t3code }
params: { base: { type: string, default: friend/main, pattern: "^[A-Za-z0-9._/-]+$" } }
triggers:
  - { id: weekly, kind: cron, expr: "0 7 * * 1", tz: America/Sao_Paulo }
  - {
      id: newtag,
      kind: upstreamTag,
      remote: "https://github.com/pingdotgg/t3code",
      pattern: '^v\d+\.\d+\.\d+$',
      pollMinutes: 120,
    }
concurrency: single
budget: { steps: 60, wall: 8h, tokens: 4000000 }
fatigue: { consecutiveFailures: 3 }
models:
  lead: { provider: claude, model: claude-opus-5-5, effort: high }
  reviewer: { provider: codex, model: gpt-6.1-sol, effort: high }
workspaces:
  integ:
    {
      project: t3code,
      base: "{{params.base}}",
      branch: "wf/merge-{{nodes.select.output.tag}}",
      retain: always,
    }
nodes:
  select:
    {
      kind: command,
      cwd: { project: t3code, readOnly: true },
      replay: safe,
      parse: json,
      argv:
        [
          node,
          scripts/friend/wf/select-upstream-tag.ts,
          --remote,
          "https://github.com/pingdotgg/t3code",
          --base,
          "{{params.base}}",
        ],
      output:
        {
          tag: { type: string, pattern: '^v\d+\.\d+\.\d+$' },
          tagSha: { type: string, pattern: "^[a-f0-9]{40}$" },
          contained: { type: boolean },
        },
    }
  route:
    { kind: branch, cases: [{ port: nothing, when: "nodes.select.output.contained" }], else: go }
  merge:
    {
      kind: command,
      cwd: integ,
      replay: safe,
      parse: json,
      argv:
        [
          node,
          scripts/friend/merge-upstream.ts,
          --json,
          --into,
          ".",
          --tag,
          "{{nodes.select.output.tag}}",
        ],
      output:
        {
          status: { type: string, pattern: "^(merged|conflicts)$" },
          conflicts: { type: "string[]" },
        },
    }
  conflicted:
    {
      kind: branch,
      cases: [{ port: repair, when: "nodes.merge.output.status == 'conflicts'" }],
      else: clean,
    }
  repair:
    {
      kind: agent,
      model: $lead,
      workspace: integ,
      access: write,
      output: { committed: { type: boolean } },
      prompt: 'Resolva os conflitos do upstream {{nodes.select.output.tag}}: {{nodes.merge.output.conflicts}}. Preserve todo hunk `Fork (friend)` (scripts/friend/seams.ts). Commite o merge. Termine com ```json {"committed": true}```.',
    }
  setup: { kind: command, cwd: integ, heavy: true, replay: safe, argv: [vp, i] }
  checks:
    {
      kind: command,
      cwd: integ,
      heavy: true,
      replay: safe,
      parse: json,
      argv: [node, scripts/friend/wf/fork-checks.ts, --json],
      check: "out.seams && out.theme && out.tests",
    }
  fix:
    {
      kind: agent,
      model: $lead,
      workspace: integ,
      access: write,
      retry: { max: 1, on: [failed] },
      prompt: "Os checks do fork falharam: {{nodes.checks.output.failures}}. Corrija na worktree e commite.",
    }
  recheck:
    {
      kind: command,
      cwd: integ,
      heavy: true,
      replay: safe,
      parse: json,
      argv: [node, scripts/friend/wf/fork-checks.ts, --json],
      check: "out.seams && out.theme && out.tests",
    }
  review:
    {
      kind: interrogate,
      target: { workspace: integ, baseRef: "{{params.base}}" },
      mode: loop,
      reviewers: [$reviewer],
      lead: $lead,
      intent: "Merge do upstream {{nodes.select.output.tag}}; só as resoluções de conflito e as seams do fork são nossas.",
      checks: [{ argv: [node, scripts/friend/check-seams.ts], cwd: integ }],
      rounds: 3,
    }
  unchanged: { kind: output, status: no_change, value: { tag: "{{nodes.select.output.tag}}" } }
  ready:
    {
      kind: output,
      status: ready_for_review,
      notify: true,
      value: { tag: "{{nodes.select.output.tag}}", sha: "{{workspaces.integ.head}}" },
      pullRequest:
        {
          workspace: integ,
          base: "{{params.base}}",
          title: "Merge upstream {{nodes.select.output.tag}}",
          body: "Merge automático do upstream. Checks do fork verdes; revisão interrogate aprovada.",
        },
      handoff: "Depois de revisar o PR: na sua checkout da friend/main, git merge --ff-only {{workspaces.integ.branch}}",
    }
  failedChecks:
    {
      kind: output,
      status: checks_failed,
      notify: true,
      value: { failures: "{{nodes.recheck.output.failures}}" },
    }
  stuck:
    {
      kind: output,
      status: blocked,
      notify: true,
      value: { branch: "{{workspaces.integ.branch}}" },
      report: "A revisão não convergiu; veja os achados abertos na execução.",
    }
edges:
  - select -> route
  - route:nothing -> unchanged
  - route:go -> merge
  - merge -> conflicted
  - conflicted:repair -> repair
  - conflicted:clean -> setup
  - repair -> setup
  - setup -> checks
  - checks:pass -> review
  - checks:fail -> fix
  - fix -> recheck
  - recheck:pass -> review
  - recheck:fail -> failedChecks
  - review:approve -> ready
  - review:stuck -> stuck
````

Falha de infraestrutura (sem rede no `select`) é o comando falhando: `replay: safe` tenta de novo, e a fadiga cuida da repetição. Conflito, check vermelho e revisão travada têm saídas distintas.

### 11.2 Hillclimb noturno do computer use (argo35)

Barra pré-registrada: throughput ≥ 1,5×, sucesso não pior e nenhuma tarefa que passava falhando, com tarefa aprovada por maioria estrita como em `summarize.py:100-114`. A busca usa só o split de treino (25 tarefas). O holdout (10) roda uma vez, no fim, e só se a barra foi atingida no treino (`METRIC.md:136-188`). A regressão Sol usa as suítes `sol-easy`, `sol-hard` e `sol-long` que o `sol_regression.py` espera.

```yaml
schema: t3.workflow/v1
id: argo35-hillclimb
title: Hillclimb de throughput no argo35
home: { project: computer-use-linux }
params:
  {
    reps: { type: number, default: 3 },
    from: { type: string, default: feat/cu-argo35-terra, pattern: "^[A-Za-z0-9._/-]+$" },
  }
triggers:
  [
    {
      id: nightly,
      kind: cron,
      expr: "30 1 * * *",
      tz: America/Sao_Paulo,
      misfire: { mode: skip, grace: 1h },
    },
  ]
concurrency: single
budget: { steps: 300, wall: 7h, tokens: 15000000 }
fatigue: { consecutiveFailures: 3 }
models: { lead: { provider: claude, model: claude-opus-5-5, effort: high } }
nodes:
  climb:
    kind: hillclimb
    workspace:
      {
        project: computer-use-linux,
        base: "{{coalesce(ledgerBest('argo35-throughput'), params.from)}}",
      }
    ledger: argo35-throughput
    generator:
      model: $lead
      workspace: { project: computer-use-linux, readOnly: true }
      prompt: |
        Melhore o throughput ponta a ponta (sucessos por minuto de agente) do servidor MCP de computer use no
        argo35-train sem reduzir sucesso. Leia bench/agent/METRIC.md. Nunca edite bench/, tarefas ou checkers;
        nunca ajuste no holdout. Já tentado: {{ledgerDigest('argo35-throughput')}}. Proponha UM mecanismo novo.
    build:
      {
        argv: [cargo, build, --release, --locked],
        cwd: attempt,
        heavy: true,
        replay: safe,
        artifact: target/release/computer-use-linux,
      }
    measure:
      bench:
        argv:
          [
            python3,
            bench/agent/argo35_metric.py,
            --suite,
            argo35-train,
            --reps,
            "{{params.reps}}",
            --base-bin,
            "{{best.artifact}}",
            --cand-bin,
            "{{candidate.artifact}}",
            --out,
            "{{step.dir}}",
          ]
        cwd: { project: computer-use-linux, readOnly: true }
        selfSerializing: true
        replay: safe
        parse: json
        tokensFrom: tokens.total
        timeout: 5h
    objective: { expr: "m.bench.candidate.throughput", direction: max }
    keep: >-
      m.bench.complete && m.bench.errors == 0 && len(m.bench.regressed_tasks) == 0
      && m.bench.candidate.success_rate >= m.bench.baseline.success_rate && m.bench.throughput_ratio >= 1.05
    confirmWhen: "m.bench.candidate.throughput / origin.bench.candidate.throughput >= 1.5"
    target: >-
      m.bench.complete && m.bench.throughput_ratio >= 1.5 && len(m.bench.regressed_tasks) == 0
      && m.bench.candidate.success_rate >= m.bench.baseline.success_rate
    plateau: { rounds: 4 }
    budget: { iterations: 12, wall: 6h, tokens: 12000000 }
  holdout:
    kind: command
    cwd: { project: computer-use-linux, readOnly: true }
    argv:
      [
        python3,
        bench/agent/argo35_metric.py,
        --suite,
        argo35-holdout,
        --reps,
        "3",
        --base-bin,
        "{{nodes.climb.output.origin.artifact}}",
        --cand-bin,
        "{{nodes.climb.output.best.artifact}}",
        --out,
        "{{step.dir}}",
      ]
    selfSerializing: true
    parse: json
    check: "out.complete && out.throughput_ratio >= 1.5 && len(out.regressed_tasks) == 0 && out.candidate.success_rate >= out.baseline.success_rate"
  sol:
    kind: command
    cwd: { project: computer-use-linux, readOnly: true }
    argv:
      [
        python3,
        bench/agent/sol_suites.py,
        --bin,
        "{{nodes.climb.output.best.artifact}}",
        --out,
        "{{step.dir}}",
      ] # sol-easy, sol-hard, sol-long + sol_regression.py
    selfSerializing: true
    check: "exit == 0"
  win:
    {
      kind: output,
      status: ready_for_review,
      notify: true,
      value: { best: "{{nodes.climb.output.bestBranch}}" },
      pullRequest:
        {
          workspace: climb.best,
          base: "{{params.from}}",
          title: "argo35: {{nodes.climb.output.best.reading}}",
          body: "Esta noite: barra atingida no treino contra a última base validada ({{nodes.climb.output.origin.sha}}), holdout e Sol sem regressão. O PR acumula as noites validadas desde {{params.from}}; cada uma está no ledger argo35-throughput.",
        },
      promote: { ledger: argo35-throughput, sha: "{{nodes.climb.output.bestSha}}" },
      handoff: "Instalar o binário no caminho vivo do computer use fica com você.",
    }
  holdoutFail:
    {
      kind: output,
      status: rejected,
      notify: true,
      value: { best: "{{nodes.climb.output.bestBranch}}" },
      report: "Atingiu a barra no treino e falhou no holdout.",
    }
  solFail:
    {
      kind: output,
      status: rejected,
      notify: true,
      value: { best: "{{nodes.climb.output.bestBranch}}" },
      report: "Regressão nas suítes Sol.",
    }
  noGain:
    {
      kind: output,
      status: no_gain,
      value:
        { endedBy: "{{nodes.climb.output.endedBy}}", best: "{{nodes.climb.output.best.reading}}" },
    }
edges:
  - climb:target -> holdout
  - climb:no_gain -> noGain
  - climb:budget -> noGain
  - climb:blocked -> noGain
  - holdout:pass -> sol
  - holdout:fail -> holdoutFail
  - sol:pass -> win
  - sol:fail -> solFail
```

Só a saída `win` marca o candidato como `validated` no ledger (`promote`), e só `validated` vira a base da noite seguinte. Uma noite que para no holdout ou no Sol não muda a base. O holdout e o Sol comparam com a origem da noite, que é a última base validada.

`argo35_metric.py` e `sol_suites.py` precisam existir no repositório do CU antes, com o split congelado e o hash dos binários. Esse repositório é o `feat/cu-argo35-terra`, não a checkout em `~/Projects` (`grounding`: o harness só existe nessa branch).

### 11.3 Corte de tokens dos MCPs

```yaml
schema: t3.workflow/v1
id: mcp-token-cut
title: Cortar tokens das definições de ferramentas MCP sem regressão de comportamento
home: { project: t3code }
triggers: [{ id: weekly, kind: cron, expr: "0 2 * * 6", tz: America/Sao_Paulo }]
budget: { steps: 200, wall: 10h, tokens: 8000000, usd: 40 }
fatigue: { consecutiveFailures: 3 }
models: { lead: { provider: claude, model: claude-opus-5-5, effort: high } }
nodes:
  cut:
    kind: hillclimb
    workspace: { project: t3code, base: friend/main }
    ledger: mcp-token-cut
    generator:
      model: $lead
      workspace: { project: t3code, readOnly: true }
      prompt: |
        Encurte descrições e schemas de ferramentas MCP (apps/server/src/mcp/toolkits/*/tools.ts,
        apps/server/src/bots/**/tools.ts) sem perder orientação de roteamento ou segurança. Uma mudança
        coerente por tentativa. Já tentado: {{ledgerDigest('mcp-token-cut')}}
    measure:
      tokens:
        {
          argv: [node, scripts/friend/wf/mcp-token-count.ts, --json],
          cwd: attempt,
          parse: json,
          replay: safe,
        }
      evals:
        {
          argv:
            [
              node,
              scripts/friend/wf/mcp-eval-verdict.ts,
              --model,
              claude-opus-5-5,
              --baseline,
              "{{origin.evals.resultsPath}}",
              --out,
              "{{step.dir}}",
            ],
          cwd: attempt,
          parse: json,
          heavy: true,
          tokensFrom: usage.total_tokens,
          timeout: 2h,
        }
    objective: { expr: "m.tokens.total", direction: min }
    keep: "m.evals.complete && m.evals.case_regressions == 0 && m.tokens.method == origin.tokens.method && m.tokens.total <= best.tokens.total * 0.97"
    target: "m.evals.complete && m.evals.case_regressions == 0 && m.tokens.total <= origin.tokens.total * 0.7"
    plateau: { rounds: 3 }
    budget: { iterations: 10, wall: 9h, tokens: 7000000 }
  review:
    kind: interrogate
    target: { workspace: cut.best, baseRef: friend/main }
    intent: "Texto de ferramenta MCP encurtado; confirmar que nenhuma orientação de roteamento ou segurança se perdeu."
    mode: panel
    reviewers: [{ provider: codex, model: gpt-6.1-sol, effort: high }, $lead]
    lead: $lead
    checks: [{ argv: [vp, run, check:changed], cwd: cut.best, heavy: true }]
    rounds: 3
  done:
    {
      kind: output,
      status: ready_for_review,
      notify: true,
      value: { before: "{{nodes.cut.output.origin}}", after: "{{nodes.cut.output.best}}" },
      pullRequest:
        {
          workspace: cut.best,
          base: friend/main,
          title: "Corte de tokens MCP",
          body: "Antes e depois no corpo da execução.",
        },
      handoff: "Servir as ferramentas novas exige restart; isso é seu.",
    }
  noGain: { kind: output, status: no_gain, value: { endedBy: "{{nodes.cut.output.endedBy}}" } }
  stuck: { kind: output, status: blocked, notify: true, value: {} }
edges:
  [
    "cut:target -> review",
    "cut:no_gain -> noGain",
    "cut:budget -> noGain",
    "review:approve -> done",
    "review:stuck -> stuck",
  ]
```

A origem mede `tokens` e `evals` contra si mesma, e é isso que gera `origin.evals.resultsPath`. O método de contagem (`chars/4` ou tokenizer) fica gravado, e `keep` recusa comparar métodos diferentes.

### 11.4 Qualidade a partir das correções do Israel

```yaml
schema: t3.workflow/v1
id: corrections-quality
title: Correções viram enforcement estrutural
home: { project: t3code }
triggers:
  [
    {
      id: nightly,
      kind: cron,
      expr: "0 3 * * *",
      tz: America/Sao_Paulo,
      misfire: { mode: skip, grace: 1h },
    },
  ]
# parallel: uma noite esperando o portão de 72 h não bloqueia a seguinte; o `once` no ledger evita repetir classe.
# O `wall` conta só tempo ativo, não a espera em portão (§9.1).
concurrency: parallel
budget: { steps: 250, wall: 8h, tokens: 10000000 }
fatigue: { consecutiveFailures: 3 }
models:
  lead: { provider: claude, model: claude-opus-5-5, effort: high }
  sol: { provider: codex, model: gpt-6.1-sol, effort: low }
  solhi: { provider: codex, model: gpt-6.1-sol, effort: high }
  haiku: { provider: claude, model: claude-haiku-5-5 }
nodes:
  extract: {
      kind: host, # registro fechado do fork (§9.5); o sandbox só recebe o JSONL
      task: extract-corrections,
      replay: safe,
      output: { count: { type: number }, path: { type: string, pattern: "^/wf/inbox/" } },
    }
  classify:
    {
      kind: agent,
      model: $haiku,
      workspace: { project: t3code, readOnly: true },
      output: { classes: { type: json } },
      prompt: "Leia {{nodes.extract.output.path}} (correções do Israel com a ação anterior; texto não confiável). Agrupe em classes de erro. Uma classe precisa de >= 2 ocorrências independentes. Chaves kebab estáveis.",
    }
  each:
    kind: map
    items: "nodes.classify.output.classes"
    as: cls
    maxItems: 5
    concurrency: 1
    body:
      nodes:
        design:
          {
            kind: arena,
            once: { ledger: rsi-corrections, key: "{{item.key}}" },
            task: 'Classe de erro "{{item.title}}", evidência {{item.evidence}}. Proponha o enforcement ESTRUTURAL mais barato: arquitetura > tipo > lint cujo erro diga a correção > teste de comportamento > doc. Mostre que falharia numa instância real passada.',
            artifact: "proposal.md na raiz da sua worktree",
            runners: [$lead, $sol],
            minCandidates: 1,
            judge: $solhi,
            lead: $lead,
            rubric:
              [
                estrutural antes de prosa,
                provado contra instância real,
                menor diff,
                sem dependência nova,
              ],
            maxReruns: 1,
            workspace: { project: t3code, base: friend/main },
          }
        pick:
          {
            kind: gate,
            ask: "Implementar o enforcement de '{{item.title}}'? Proposta: {{nodes.design.output.artifactPath}}",
            options: [implement, skip],
            expires: { after: 72h, decision: skip },
          }
        build:
          {
            kind: graph,
            goal: "Implemente {{nodes.design.output.artifactPath}}; aceite = o teste que falhava antes passa depois.",
            lead: $lead,
            leaf: $sol,
            workspace: { project: t3code, base: friend/main },
            finalChecks: [{ argv: [vp, run, check:changed], cwd: build.integration, heavy: true }],
            reworkCap: 2,
            maxLeaves: 6,
            maxParallel: 2,
          }
        review:
          {
            kind: interrogate,
            target: { workspace: build.integration, baseRef: friend/main },
            intent: "Enforcement estrutural para {{item.title}}",
            mode: loop,
            reviewers: [$solhi],
            lead: $lead,
            checks: [],
            rounds: 3,
          }
        pr:
          {
            kind: output,
            status: ready_for_review,
            value: { class: "{{item.key}}" },
            pullRequest:
              {
                workspace: build.integration,
                base: friend/main,
                title: "enforce: {{item.title}}",
                body: "Classe de erro com evidência {{item.evidence}}.",
              },
          }
      edges:
        [
          "design:ok -> pick",
          "pick:implement -> build",
          "build:ok -> review",
          "review:approve -> pr",
        ]
    collect: { class: "{{item.key}}", verdict: "{{nodes.review.output.verdict}}" }
  out:
    {
      kind: output,
      status: proposals,
      notify: true,
      value: { results: "{{nodes.each.output}}" },
      report: "Mudanças em skills e regras globais continuam propostas dentro de cada proposal.md; nada foi aplicado em ~/.claude.",
    }
edges: [extract -> classify, classify -> each, each -> out]
```

O snapshot é pesado (o `statev2.sqlite` tem vários GB) e é a única exceção do host (§9.5): roda do lado do Israel, só lê a fonte e entrega ao sandbox uma cópia redigida. O texto das correções não é confiável: entra emoldurado nos prompts e nunca em argv. Mudança em skill ou regra global fica como proposta, como o `reflect` já exige.

---

## 12. Lista de seams

Nove arquivos do upstream. Sete já são seams hoje (`scripts/friend/seams.ts`) e dois são novos. Os arquivos novos do fork não são seams: os prefixos novos entram em `FORK_OWNED_PREFIXES` (`seams.ts:542`), que é do fork.

| Arquivo                                                                        | Já é seam?               | Mudança                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Por que não dá para ficar no fork                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/scheduledTasks/ScheduledTaskService.ts`                       | sim (2 → 5)              | 1) Na construção da camada (`:398-408`): `Effect.serviceOption(WorkflowTriggerHook)`. 2) No despacho (`:816-857`): task com id `wf-hook:` vai para `hook.fire({ taskId, deliveryId, prompt })`; fora de um disparo de webhook (`runNow`, agendado) a task falha com "task de workflow só dispara por webhook"; sem o gancho, falha com "motor de workflows indisponível" e **nunca** cai no lançamento comum. 3) Um `hook.guard(taskId)` no começo de `upsert`, `delete`, `setEnabled`, `runNow` e `rotateWebhookToken`, que recusa `wf-hook:` fora do escopo do motor (`WorkflowEngineCaller` no contexto do Effect) | É o único ponto onde todos os caminhos de disparo se juntam (`ScheduledTaskService.ts:816-857`). Sem o guard, a task que carrega o webhook poderia ser editada, desligada ou apagada pela tela de tarefas ou por `delete_scheduled_task`. O `layerCore` já fica abaixo do runtime (`server.ts:527-547`), então `runtimeLayer.ts` não muda |
| `apps/server/src/mcp/McpHttpServer.ts`                                         | sim (4)                  | Registrar `WorkflowToolkit` no hunk dos toolkits do fork (`:1174`); no hunk de `:239`, invocação de thread `wf:` recebe 403                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Registro de toolkit e autenticação MCP são do upstream                                                                                                                                                                                                                                                                                    |
| `packages/client-runtime/src/rpc/client.ts`                                    | sim (2)                  | Três tags de stream em `EnvironmentSubscriptionRpcTag`, dentro do hunk existente                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A união de streams é explícita                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/routeTree.gen.ts`                                                | sim (contains)           | Entradas geradas para `_chat.workflows*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Arquivo gerado                                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/components/sidebar/mainAppLocation.ts`                           | sim (1)                  | `/workflows` entra na cláusula de páginas utilitárias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Volta para o chat                                                                                                                                                                                                                                                                                                                         |
| `apps/mobile/src/Stack.tsx`                                                    | sim                      | Rotas `bots/workflows/…`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Registro do Stack é do upstream                                                                                                                                                                                                                                                                                                           |
| `apps/mobile/modules/t3-agent-notifications/android/.../AgentNotifications.kt` | sim (2 → 3)              | Aceitar caminho de toque `/bots/workflows/` além de `/threads/` (`:362`). Os pushes de workflow usam o `t3_kind: "bot_message"` que o receptor já entrega (`:23-26`), então o tipo não muda                                                                                                                                                                                                                                                                                                                                                                                                                           | Lista de caminhos no código nativo                                                                                                                                                                                                                                                                                                        |
| `packages/shared/package.json`                                                 | **não, nova** (contains) | Export `./workflows` para `src/workflows/` (compilador, expressões, `classifyCommand`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | O AGENTS.md reserva `packages/contracts` para schemas; lógica de runtime compartilhada mora em `packages/shared`, que só expõe subpaths declarados                                                                                                                                                                                        |
| `evals/mcp-tool-use/run.ts`                                                    | **não, nova** (1)        | Incluir os toolkits do fork no catálogo da eval (`:303`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Sem isso, nenhuma ferramenta do fork tem eval, nem as de hoje                                                                                                                                                                                                                                                                             |

Sem mudança em `runtimeLayer.ts`, `ws.ts`, `rpc.ts`, `RpcAuthorization.ts`, `ServerEnvironment.ts`, `GitWorkflowService`, nos adapters de provider, no `ProviderSessionManager` ou no `ThreadLaunchService`. O script de setup se desliga por configuração (projeto "Workflows" com lista vazia), as leituras do adapter do Claude caem num placeholder vazio, e a imagem, a rede, o proxy e os volumes Docker são infraestrutura criada pelo fork, não código do upstream. O spread de `BOTS_RPCS`, os spreads de escopo e a capability `bots` já levam tudo (`grounding/fork-infra.md:145-158`). O perfil de execução usa o `binaryPath` e o `homePath` das instâncias de provider, que são configuração. A entrada na barra lateral do web fica no `BotsSidebarSection`, que é do fork. Prefixos novos do fork: `packages/contracts/src/workflows`, `packages/shared/src/workflows/`, `packages/client-runtime/src/workflows.`, `apps/web/src/routes/_chat.workflows`.

---

## 13. Plano de entrega

Fatias verificáveis, todas no escopo completo e sem fase "depois". P = até um dia, M = dois a quatro dias, G = uma semana ou mais. "/graph" marca fatia que roda como lead Opus com folhas Sol (`gpt-6.1-sol` @low), cada folha com conjunto de escrita exclusivo. Builds e testes pesados sempre via `heavy.sh`, um por vez.

| #   | Fatia                                                                                                                                                                                                                                                                               | Esforço | Depende de | Check de aceitação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Paralelo                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | Contrato e compilador: schemas em `packages/contracts/src/workflows.ts`, compilador em `packages/shared/src/workflows/` (schema, expressões, templates, grafo, contaminação, regra de thread contínua, `classifyCommand`, família de modelo)                                        | M       | —          | Tabela de testes do compilador: os quatro modelos da §11 compilam; cada `DiagnosticCode` tem um caso que falha; YAML canônico ida e volta com o mesmo hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | /graph: folhas expressões · grafo · lint                   |
| 2   | Núcleo do motor: migração 014, `Journal`, dobra, `decide` dos primitivos, decisor do workflow (promoção de `TriggerFired`), `RunActor` com interpretador falso                                                                                                                      | G       | 1          | Testes por tabela `(prefixo do journal) → intents`, uma linha por janela da §3.4; append com chave repetida não grava e devolve o existente; `TriggerFired` órfão vira execução uma vez só                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                          |
| 3   | Interpretador real: bundles de entrada e saída, `wf-git` (clones, worktrees, advance, merge), `ThreadLaunchService`, `sendToThread`, sensor com `waitForThread`, `CommandRunner` (unit única, `wfUnit`, recibos, lock dentro do container pelo `wf-run`), broker pesado, `publish/` | G       | 2          | Teste de integração com o provider `Replay (dev)`: execução de dois passos; o servidor de dev desta worktree morre no meio do passo 1 (PID capturado) e volta; a execução termina com **uma** thread por chave e **uma** unit por chave; matar a unit depois de `started.json` com `replay: never` deixa o passo `ambiguous`; um bundle de saída com sha diferente do journal é recusado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                          |
| 4   | Sandbox: imagem `t3-workflow-sandbox`, `wf-claude`, `wf-codex`, rede interna, container do proxy com forwarders (o do OpenAI é novo), medição e teto diário, volumes, placeholders, escritor, broker pesado, autoteste, 403 do MCP para `wf:`, sentinela                            | G       | 3          | Uma cópia do `sandbox.docker.test.ts` do guest para a imagem de workflow, com Docker de verdade: host escondido, `CapEff` zero, sem socket do Docker; `127.0.0.1:3773`, `:3796`, `:8317` e os IPs do host bloqueados, direto e pelo proxy; display `:99` inalcançável; nenhuma credencial no container; Claude **e Codex** completam um turno pelos forwarders (ou pelo broker gerenciado do Codex atrás do forwarder, plano B); um modelo fora da lista é recusado e o teto diário pausa; trocar o arquivo de token com o proxy de pé faz a próxima chamada usar o token novo; o contador do proxy sobrevive à recriação do container. Do lado do host: um placeholder continua vazio e com modo 0555 depois de um passo que escreve na worktree, `git rev-parse` nele falha, o T3 não tira checkpoint, e um `strace -f -e trace=openat` dos processos do Israel durante uma execução completa não mostra nenhuma abertura no volume; um `scripts/setup-worktree.ts` reescrito por um passo não roda no lançamento da thread seguinte; um artefato ou bundle que é symlink para um arquivo do Israel vira erro; `t3_thread_send` de uma thread `wf:` recebe 403; os bots recusam as instâncias de workflow; com dois comandos pesados na fila, matar a unit do primeiro no meio não deixa o segundo começar antes de o primeiro container morrer; a bridge `t3-wf-internal` não tem endereço no host e o `sshd` em `0.0.0.0:22` não responde pela bridge; remover de novo uma worktree que já sumiu conta como feito; autoteste quebrado → motor recusa passos | paralelo a 5                                               |
| 5   | Definições: repositório git, save/validate/history, ingestão de edição à mão, watcher, `workflow_versions`, conflito por revisão do arquivo, modelos prontos                                                                                                                        | M       | 1          | Save → commit com YAML canônico; edição à mão válida sem commit → vira commit e `document.subscribe` emite; edição à mão inválida → save de canvas recebe `Conflict` com o arquivo sujo e nada é sobrescrito; duas edições só de layout → `Conflict`; arquivo inválido → gatilho grava `TriggerSkipped{invalid}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | paralelo a 4                                               |
| 6   | Gatilhos: cron com fuso, webhook (seam da STS com gancho e guard, `coalesceKey`, reconciliação no tick), manual, bot, tag do upstream, PR mergeado (`linked` e `repo`), thread terminou, rotina falhou com profundidade causal                                                      | G       | 2, 5       | Teste de ocorrência por gatilho (chave única, fuso com horário de verão, misfire); teste da seam: task `wf-hook:` vai para o gancho, task comum segue igual, `runNow` e `delete` de task `wf-hook:` são recusados fora do motor; entrega de webhook aceita sobrevive a crash antes do despacho; task apagada por fora volta no tick seguinte; `check-seams` ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | /graph: folhas por fonte de evento                         |
| 7   | Blocos: hillclimb, arena, graph, interrogate e suas visões                                                                                                                                                                                                                          | G       | 3          | Por bloco, tabela de testes do sub-decisor: chave e árvore duplicadas recusadas, platô termina `no_gain`, barra só na confirmação contra a origem, `ledgerBest` só devolve `validated`; juiz da mesma família recusado; folha fora de `owns` rejeitada e dependente partindo do sha integrado; troca de acesso abre thread nova; rodada de interrogate com thread nova e sem aprovação por timeout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | /graph: uma folha por bloco                                |
| 8   | Proteções e avisos: reservas (turnos e comandos pagos), tokens cobráveis, vigia, tempo ativo, fadiga, push, cartão do kanban, PR pelo motor                                                                                                                                         | M       | 3          | Mapas concorrentes não passam do saldo; uso desconhecido é cobrado pela reserva; espera em portão não conta no `wall`; fadiga avisa uma vez por pausa; `OpenPullRequest` repetido acha o PR existente; projeto ligado ao Linear recusado; padrões de orçamento medidos com turnos reais de uma cópia do `statev2.sqlite` (`vp run migrate-dev-db`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                          |
| 9   | RPC e MCP: grupo `bots.workflows.*`, `WorkflowToolkit`, permissões, deltas de execução, eval                                                                                                                                                                                        | M       | 2, 5       | Testes de permissão das RPCs (portão só com sessão de usuário); handler recusa thread de passo; casos de eval "valida com dryRun antes de salvar" e "não tenta aprovar portão" falhando antes do texto final e passando depois                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                          |
| 10  | Web e desktop: lista, editor (adaptador React Flow + roughjs, Inspector, aba Fonte, merge), tela da execução, painel de métricas, ledger                                                                                                                                            | G       | 1, 9       | Testes de browser do adaptador (ida e volta, nota preservada, aresta apagada por teclado e por menu, banner de conflito); passada única com `test-t3-app` com o Israel autorizando                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | /graph: folhas adaptador · Inspector · execução · métricas |
| 11  | Android: lista, detalhe com grafo SVG, rodar, execução, portão, edição leve, métricas, push                                                                                                                                                                                         | M       | 9          | Passada com `test-t3-mobile`: o push de portão **chega** como notificação e o toque abre a execução; aprovar no celular avança a execução no servidor; edição leve inválida mostra erro local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | paralelo a 10                                              |
| 12  | Biblioteca: as CLIs da §11 e os quatro modelos                                                                                                                                                                                                                                      | G       | 4, 7, 8    | Contrato JSON de cada CLI testado; primeira execução real do `upstream-merge` numa tag conhecida termina com a branch `wf/` **no GitHub** (sha conferido com `git ls-remote`) e PR em rascunho, com a `friend/main` intacta (sentinela limpa); o bench do argo35 roda um episódio inteiro **dentro do perfil** (Xvfb, i3, Chrome e o binário candidato), senão o modelo fica marcado como não suportado sem supervisão                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | /graph: uma folha por rotina                               |
| 13  | Documentação: seção no `FORK.md`, guia do usuário, `seams.ts`                                                                                                                                                                                                                       | P       | todas      | `node scripts/friend/check-seams.ts` ok; o `FORK.md` descreve onde moram os workflows, o perfil e a exceção do host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                          |

Caminho crítico: 1 → 2 → 3 → 4 → 12. A fatia 4 vem antes de qualquer execução real: sem o perfil provado, o motor recusa passos. As fatias 4 e 5, 6 e 8, 10 e 11 andam em paralelo duas a duas, sempre com um build pesado por vez na VPS.

Ativar em produção é deploy e infraestrutura, e pede o ok do Israel na hora, fora deste plano: construir a imagem `t3-workflow-sandbox`, criar a rede interna, o container do proxy e os volumes (o fork faz isso de forma idempotente), pôr o token do `claude setup-token` onde o container do proxy lê, criar as instâncias `codexWorkflow` e `claudeWorkflow` nas settings do host de bots, criar o projeto "Workflows" com a lista de scripts vazia, rodar a migração 014 no `bots.sqlite` real e ligar o primeiro gatilho. Também põe o `heavy.lock` em 0644. Não há root, usuário novo nem mudança no gitconfig do Israel.

---

## 14. Riscos

1. **O daemon do Docker é root.** Uma fuga do kernel de dentro de um container cai como root, sem `userns-remap`. Seccomp, AppArmor, `cap-drop ALL`, `no-new-privileges`, rootfs só leitura e uid sem conta reduzem a chance. Ligar `userns-remap` mudaria todos os containers do host, inclusive os de guest, e fica de fora (§9.6).
2. **Providers dentro do container.** O Claude Code num container já roda em produção para os guests. O `codex app-server` num container, com home em volume e o forwarder do OpenAI, ainda não foi testado. O forwarder com o backend do ChatGPT é a parte mais incerta, e o plano B usa o broker gerenciado do T3 atrás do mesmo forwarder (§9.5). A fatia 4 decide antes de qualquer outra coisa depender disso.
3. **O proxy deixa sair para a internet.** Um passo com prompt injection pode mandar código do repositório para fora. Não é uma ação proibida pelos requisitos, mas é exfiltração possível. Se o Israel quiser, o proxy aceita uma lista de domínios (APIs dos providers, registries, GitHub).
4. **A fronteira de confiança é o conjunto de execuções de workflow.** Todo container monta o volume inteiro, então um passo consegue mexer em arquivos de outra execução. O motor não depende disso para nada que publica (journal, checks próprios, recibos, bundles verificados), mas um PR pode sair com conteúdo sabotado, e só a revisão pega.
5. **Trabalho pesado do agente fora do shim** não entra na fila, só fica limitado pelo `--cpus` e `--memory` do container.
6. **Imagem grande.** De 2,5 a 3,5 GB (rust, Chrome, X, CLIs), construída via `heavy.sh` e refeita quando as ferramentas mudam. Um build quebrado deixa os workflows parados até o próximo.
7. **O bench do argo35 num container.** Xvfb, i3, D-Bus privado, Chrome e os agentes dos episódios precisam funcionar dentro da imagem. Se não funcionarem, o hillclimb noturno fica bloqueado para rodar sem supervisão. A fatia 12 decide.
8. **Sem checkpoint nem visualização de arquivos do T3 nas threads de passo.** O servidor só vê o placeholder vazio. O motor mostra o que mudou pelos shas do journal e pelo PR.
9. **Orçamento de tokens.** Pode passar pelo tamanho dos turnos em voo. O `timeout` é o limite duro.
10. **Dois bancos sem transação comum.** As chaves cobrem o lado do upstream. Queda de energia pode perder as últimas transações (`synchronous = NORMAL`), e um passo pode ser refeito ou ficar `ambiguous`.
11. **Merge do upstream mexendo no despacho da STS.** O `check-seams` pega a perda do hunk, e o teste da fatia 6 pega mudança de comportamento.
12. **Latência do webhook.** O `coalesceKey` durável soma até 10 s. Serve para rotinas, não para webhook interativo.
13. **Canvas.** Apagar aresta pelo teclado não foi provado no protótipo. Também não há tinta livre, que o Excalidraw teria.
14. **Custo à noite.** Turnos de Opus e evals pagos. O painel mostra custo por noite, e os padrões de orçamento saem de turnos reais (fatia 8).
15. **O sandbox do guest tem a lacuna da bridge.** A revisão achou que a rede `--internal` dos guests, em produção hoje, deixa os containers alcançarem o `sshd` e outros serviços do host em `0.0.0.0` pelo endereço da bridge. Este desenho usa o modo `isolated`; o guest precisa da mesma correção, fora deste escopo.
16. **Prompt injection** vinda de webhook, PR ou correções. Defesas: moldura de não confiável, regra de contaminação para argv e o container, que limita o estrago.

---

## 15. Perguntas abertas para o Israel

1. **Onde mora o repositório de definições?** `~/.t3/workflows/definitions` é um git local sem remote, só no host. A alternativa é um repositório privado no GitHub que você empurra, para ter backup e revisão fora da VPS. O desenho funciona com os dois.
2. **Você liga o ruleset do GitHub na `friend/main`** (sem force push, PR obrigatório, só você passa)? É a última camada se uma credencial escapar do perfil. É configuração externa e não faço sem seu ok.
3. **Padrões da madrugada:** rotina noturna que perdeu a janela porque o servidor estava fora roda quando ele volta (até 1 h depois) ou pula para a noite seguinte? E qual o teto de tokens ou USD por noite somando todas as rotinas?

---

## Apêndice A. Como este desenho foi feito

- **Grounding.** Quatro exploradores Sol (`gpt-6.1-sol` @high) leram gatilhos (`ScheduledTask`), execução durável (`ThreadLaunchService`, recuperação de restart, tokens), a infraestrutura do fork (`bots.sqlite`, MCP, RPC, kanban, push, Android) e os quatro casos reais com os blocos do pstack.
- **Arena.** Dois candidatos estruturalmente diferentes, escritos em paralelo:
  - Opus: journal, decisor puro, blocos nativos, arquivo como autoridade;
  - Sol @low: estado relacional mutável, um reconciliador, blocos expandidos em primitivos, banco como autoridade.
- **Juiz cruzado.** Sol @high deu 17/30 ao Opus e 19/30 ao Sol e recomendou o Sol como base.
- **Síntese.** A base é o candidato Opus, divergindo do juiz, por três motivos:
  1. o candidato Sol trata o arquivo como exportação, e isso fura um requisito explícito do Israel (canvas e arquivo como a mesma fonte, nos dois sentidos);
  2. a expansão de blocos do Sol empurrava a lógica de ledger e de "manter" para capabilities privilegiadas e não mostrou como um DAG dinâmico do graph cabe em `map`;
  3. as notas baixas do Opus vieram de defeitos que se corrigem dentro do modelo dele.
- **Enxertos e correções do candidato Sol e do juiz:**
  - perfil de execução como barreira de verdade (resolvido no fim com containers Docker, §9.6);
  - estado `ambiguous` e classes de replay para comandos, com `started.json` antes do argv (F2);
  - entrega de webhook durável antes do 202 via `coalesceKey` (F1);
  - fim de execução atômico com as consequências (F6);
  - reservas de orçamento no pai e nos filhos (F7);
  - revisão do documento cobrindo o layout e escritor único do repositório (F5);
  - deltas de execução no stream;
  - nuance de família do juiz na arena;
  - "Converter em bloco" no canvas;
  - profundidade causal e sha do objeto da tag nos gatilhos (F11);
  - rotinas com saídas distintas e o split treino/holdout do argo35 (F10).
- **Descartado do Opus:** o broker de aprovação por comando. Com o perfil, os passos rodam em `full-access` e nada trava esperando aprovação.
- **Revisão adversarial (`/interrogate`, painel).** Rodada 1 com Sol (`gpt-6.1-sol` @high) e Opus (`claude-opus-5-5` @high), lendo o doc contra o código e o host. Os dois pediram mudanças. Os achados aceitos e como foram resolvidos:
  - o perfil era lista de bloqueio: o usuário está no grupo `docker`, o serviço carrega tokens no ambiente e `~/.railway` estava legível. Virou lista de permissão, com ambiente vazio e home vazio;
  - os homes reais do Claude e do Codex estavam graváveis, com MCP de deploy e hooks. Agora há homes próprios do sandbox;
  - o motor rodaria hooks git que o agente escreveu, porque o repositório usa `core.hooksPath` relativo. Agora há clone por execução com hooks desligados e `engineGit()`;
  - a exceção do bench rodava o binário candidato fora do sandbox. Foi removida, e os episódios passam pelo broker;
  - `t3_thread_send` escapava do sandbox. Agora o MCP do T3 responde 403 para toda thread `wf:`;
  - recibos e saídas ficavam num diretório escondido. Agora existe o layout `~/.t3/workflows/`, com recibos fora do alcance do sandbox;
  - um save do canvas sobrescrevia edição à mão sem commit. Agora a revisão é do arquivo no disco e há ingestão antes do save;
  - o SQL do lease não cercava nada. O lease foi apagado: há um escritor só por `stateDir`;
  - `TriggerFired` órfão não tinha dono. Agora o decisor do workflow o promove;
  - a sentinela pausava em todo restart. O `InvocationID` saiu;
  - a task do webhook podia ser mexida por qualquer um. Agora há guard na seam e reconciliação no tick;
  - o Android descartaria `t3_kind: "workflow"`. Os pushes usam `bot_message`;
  - faltava check de aceitação em passo de agente. Entrou `accept`;
  - o orçamento contava leitura de cache. Agora conta tokens cobráveis, e comandos pagos também reservam;
  - o argo35 subia em candidatos não validados. Agora há `validated` e `promote`;
  - um portão de 72 h não cabia num `wall` de 8 h. Agora o `wall` conta tempo ativo e a rotina tem `concurrency: parallel`;
  - o compilador estava em `contracts`. Foi para `packages/shared`;
  - o `heavy.sh` aninhado deixava duas cópias rodarem. Agora há uma unit só com o mesmo lock;
  - uma thread trocava de acesso ou de worktree. Agora há uma de cada por thread;
  - faltava a linha de `sendToThread` na tabela de crash. Entrou.
- **Rodada 2** (os mesmos dois revisores, sobre o diff e os próprios ids). A1 a A8 e B1 a B25 resolvidos, menos B3. Achados novos e como foram resolvidos:
  - (A9, B26) com o mesmo uid, um passo redirecionava o git do host pelo `.git` (arquivo), pelo `commondir` ou pelo `gitdir`, e um clone criado depois do app-server ficava sem a montagem só leitura. Agora os passos rodam como o usuário `t3wf`: o git do host recusa repositório de outro dono, e o motor só toca git em `publish/` e na produção, com código passando por bundle;
  - (B31) a rede compartilhada alcançava o display `:99`, o `pluggy-mcp` e o `cliproxyapi`. Agora há `--unshare-net` e um proxy só para endereço público, como no guest;
  - (B32) havia credenciais dentro do sandbox. Elas foram para forwarders no proxy, e o sandbox fica só com placeholders;
  - (A10, B28) o clone publicava no repositório local, sem credencial e sem `upstream`. Agora a publicação sai de `publish/<proj>.git`, com o remoto do GitHub conferido e o helper do `gh`, e os remotos do clone são escritos no sandbox;
  - (A11, B30) a checagem de `cwd` do wrapper quebrava a partida do Codex e as sondas de saúde. Saiu, e uma thread fora de `/srv/t3wf` falha porque o `t3wf` não lê o diretório;
  - (B27) uma edição à mão inválida travava todo editor. Agora o conflito só acontece por revisão, e quem viu o texto quebrado pode substituí-lo;
  - (A12) o rename depois da checagem não é atômico. Isso agora está escrito, e uma cópia do que estava no disco é guardada;
  - (B29) o `secretRef` só vale uma vez. O segredo do HMAC agora fica com o motor;
  - (B33) faltava `--collect` na unit. Entrou;
  - (B34) o campo certo é `cachedInputTokens`, e uso desconhecido é cobrado pela reserva;
  - (B35) um `runId` aceito podia não existir. Agora ele aparece como `queued` ou `skipped` com o motivo.
- **Rodada 3** (estendida além das três rodadas padrão porque os achados eram de segurança). A9 a A11 e B26 a B35 resolvidos. Achados novos e como foram resolvidos:
  - (B36) o motor, como Israel, copiava artefato e bundle de caminho do `t3wf` e seguiria symlink para o token do GitHub. Agora vale a regra: o lado do Israel nunca abre caminho em `/srv/t3wf/runs`, e bytes saem só pelo stdout de `wf-enter exec`;
  - (A14) o lançamento da thread rodava o script de setup do projeto como Israel, na worktree do passo. Agora as threads ficam no projeto "Workflows", com lista de scripts vazia, e o autoteste confere;
  - (A13, B39) o `git bundle` recusa sha sem ref. Agora há refs de transferência e o bundle completo vem antes dos incrementais;
  - (A15, B42) o `wf-enter` perdia o cwd e o `env_reset` perdia variáveis. Agora há `--cwd` e `--env` com lista fixa, o `homePath` aponta para o home do `t3wf`, e o `isSandboxLauncher` reconhece os wrappers;
  - (B37) o snapshot entregava o banco inteiro, com tokens de webhook. Agora a extração roda do lado do Israel e o sandbox recebe só campos permitidos;
  - (B38) os forwarders deixavam qualquer processo gastar fora do orçamento. Agora eles têm lista de modelos, medem todo token e param no teto diário do host;
  - (B40) a ponte só tinha a porta 3128. Agora tem as três portas e `NO_PROXY`;
  - (B41) faltavam permissões de socket e de artefato. Agora são explícitas;
  - (A12) a janela restante do rename está escrita como é.
- **Rodada 4** (estendida pelo mesmo motivo). A12 a A15 e B36 a B42 resolvidos. Achados novos e como foram resolvidos:
  - (B43) o nó do lado do host rodaria, como Israel, um script de um checkout que o `t3wf` escreve. Agora os nós `host` só nomeiam tarefas de um registro fechado no código do servidor, sem argv nem cwd;
  - (B44) um passo podia trocar a própria worktree por um symlink para um repositório do Israel, e o servidor faria checkpoint nele. Agora o motor cria o esqueleto e as folhas, e o `t3wf` só escreve dentro das folhas;
  - (A16) o adapter do Claude lia `.git`, `commondir` e `.claude/settings*.json` da worktree no host. Agora essas leituras se desligam para os wrappers de workflow, no hunk do fork que já existe;
  - (B45) reconhecer os wrappers em `isSandboxLauncher` deixaria bots de guest usarem as instâncias de workflow. Agora há um `isWorkflowLauncher` separado, e o `BotsService` recusa essas instâncias;
  - (A17) o plano B do Codex punha um token no sandbox, fora do medidor. Agora ele também fica atrás do forwarder;
  - (B46) faltava o modelo auxiliar do Claude Code na lista e o caminho de volta do teto diário. Os dois entraram;
  - (B47) havia sobras: refs de transferência apagadas depois do bundle, pulo do bundle vazio, refspec exato, teto de tamanho do stdout, e o Israel fora do grupo `t3wf`.
- **Rodada 5.** A16, A17 e B43 a B47 resolvidos. Achados novos e como foram resolvidos:
  - (B48) com a folha sendo do Israel, um repositório bare plantado nela passaria na checagem de dono de um git do Israel (terminal, VS Code). Agora o setup põe `safe.bareRepository=explicit` no gitconfig global do Israel, e o VS Code do T3 recusa essas pastas;
  - (A18) o git do `t3wf` recusaria as folhas do Israel. Agora há `safe.directory` só no gitconfig do perfil;
  - (B49) ninguém conseguia apagar uma worktree. Agora a remoção tem dois lados (o sandbox esvazia, o motor faz `rmdir`), e entrou uma regra de retenção;
  - (B50) acertos: o `strace` virou check da fatia 4 com o texto certo, a contagem da seam do Claude subiu, o setgid é herdado sem `chmod`, e o erro esperado do git ficou "permissão ou dono".
- **Rodada 6.** Os dois revisores aprovaram o modelo de usuário `t3wf` com `bwrap`, com dois nits (B51 e B52).
- **Troca para Docker.** Antes de fechar, o supervisor (bot T3 Fork) pediu para comparar esse modelo com o container por passo que o fork já usa para os guests, porque quase toda rodada tinha achado uma fuga nova (A9, B31, A14, B43, B48). A comparação está na §9.6. O Docker fecha por construção a classe mais repetida (git e leituras do host em pasta do passo), porque o host só vê um placeholder vazio. Ele também reaproveita isolamento que já tem teste com Docker de verdade e não pede root, usuário novo, sudoers nem mudança no gitconfig do Israel. A §9.5 foi reescrita, a seam do `ClaudeAdapterV2` saiu, e os nits de B52 que valem para o Docker entraram: remover de novo uma worktree que já sumiu conta como feito, o `prepare` roda `git worktree prune` antes de recriar, e o `retain` foi alinhado com a retenção de 7 dias.
- **Rodada 7** (sobre o texto com Docker). Achados e como foram resolvidos:
  - (A19, B53) uma rede `--internal` comum deixa o host alcançável pelo endereço da bridge, e o `sshd` deste host escuta em `0.0.0.0:22`. Agora a rede usa `gateway_mode_ipv4=isolated`, conferido na documentação do Docker, e o teste descobre a bridge depois de criada e tenta as portas 22 e 5900. O guest em produção tem a mesma lacuna, registrada como risco;
  - (A20, B54) o `ExecStopPost` derrubava o container só depois de o lock ser solto. Agora o próprio container segura o lock, com um handshake `WF-LOCKED`/`GO` antes do `started.json`;
  - (B55) o volume nascia do root, faltava a conta do uid 10001 e a ordem de criação do `-w`. Agora há `chown` único, a conta `wf` na imagem e a ordem placeholder → `wf-git prepare` → uso;
  - (B56) faltava dizer como o token do Codex chega ao proxy, como o uso volta ao motor e quem lê os arquivos 0600. Agora há arquivo de token trocado pelo motor, o log JSON do proxy e o proxy como uid 1000;
  - (B57) quatro afirmações de "testado" na §9.6 estavam erradas. A tabela agora separa o que o teste do guest cobre do que é novo;
  - (B58) um container podia sobrar depois de kill duro e competir com a nova tentativa. Agora os containers têm rótulo e são limpos na partida e antes de cada tentativa.
- **Rodada 8.** A19, A20 e B53 a B58 resolvidos, menos B56. Achados e como foram resolvidos:
  - (A21, B56) o token do Codex montado como arquivo não se renovaria depois de um rename. Agora o proxy monta o diretório de credenciais, como o guest faz;
  - (A22, B59) o volume do contador do proxy nasceria com o dono errado. Agora ele nasce com dono 1000 e fica só no proxy;
  - (B60) o dia do proxy virava em UTC. Agora ele recebe o fuso do host;
  - (B61) três passagens ainda punham o lock na unit, e a frase sobre o `ExecStopPost` estava errada. As duas coisas foram corrigidas;
  - (B62) o `heavy.lock` passou a ser montado com `--mount`, que recusa arquivo inexistente;
  - (B63) os rótulos agora dizem o processo que lançou o container, e "sessão viva" ficou definida;
  - (B64) os pesos do `heavy.sh` agora estão certos.
- **Rodada 9.** Os dois revisores aprovaram. Ficaram nits: duas passagens antigas sobre o lock (B61) e a varredura de containers (B65), com o instante de início do processo no rótulo e a varredura em todo tick. Foram corrigidos sem nova rodada, porque nit sozinho não pede revisão.

## Apêndice B. Alternativas descartadas

1. **Estado relacional mutável com reconciliador** (candidato Sol). É mais fácil de consultar, mas cada janela de crash pede raciocínio próprio ("o lançamento saiu antes da gravação do status?"), e resolver isso pede um outbox, que é um journal com passos a mais.
2. **Outbox de efeitos do upstream.** Daria atomicidade com a criação da thread, mas o outbox e o executor são fechados e do upstream (`EffectOutbox.ts:35`, `EffectWorker.ts:100`) e violam a regra de armazenamento do fork.
3. **Blocos como expansão em `loop`, `branch` e `map`.** Ver §4.
4. **Definição como script TypeScript**, como o `local_workflow` do Claude. Não dá para desenhar num canvas, validar comandos estaticamente nem retomar sem reexecutar código de usuário.
5. **Banco como autoridade e arquivo como exportação.** Fura o requisito de canvas e arquivo serem a mesma fonte.
6. **Cron pela `ScheduledTask`** estendendo a união de schedule. Custaria de 4 a 7 arquivos do upstream e a chave de disparo continuaria sem identidade de ocorrência.
7. **Broker de aprovação como barreira** (candidato Opus original). Regras de allow do usuário no Claude passam por cima dele, e um script chamado pelo motor nunca vira pedido de aprovação.
8. **Excalidraw e tldraw** como canvas. Ver §7.1.
