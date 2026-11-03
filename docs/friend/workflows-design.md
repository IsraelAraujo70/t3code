# Workflows no fork friend: desenho

Status: aprovado pelo Israel em 2026-11-02, com uma mudança no mesmo dia: os passos rodam no host, sem container (§9.6). As fatias 1 a 3 estão na branch `feat/workflows`. Os protótipos descartáveis do canvas ficaram no histórico do git: pasta `prototypes/workflows-canvas/` no commit `f6ddb26aa`.

Um workflow é um processo de agentes com vários passos que roda sozinho, disparado por horário, webhook, pedido de bot ou evento interno. Ele serve sobretudo às rotinas de auto-melhoria (RSI) da madrugada: merge do upstream, hillclimb do computer use, corte de tokens dos MCPs e qualidade a partir das correções do Israel.

Os caminhos de código citados são relativos à raiz do repositório, no commit `80da99c43`.

---

## 0. Decisões que sustentam o desenho

1. **Uma tabela é a verdade.** Cada execução é um journal só de inserção em `bots.sqlite` (`workflow_facts`, com `UNIQUE(stream, key)`). Gravar o mesmo fato duas vezes não faz nada. Listas e telas leem caches reconstruíveis a partir do journal.
2. **A decisão é uma função pura.** `decide(workflow, estado, contexto) -> Intent[]` não faz I/O, como o `Orchestrator` do upstream. Um interpretador fino executa cada intent com uma chave determinística: o `commandId` do `ThreadLaunchService`, o nome da unit do systemd, o compare-and-swap de uma ref git. A retomada depois de um restart cabe numa frase: dobrar o journal, reexecutar os intents gravados sem resultado, religar os sensores e decidir de novo.
3. **Cada passo de agente é uma thread T3 comum**, lançada com `ThreadLaunchService.launch` (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:838`). Ela acompanha a continuação de restart que o upstream já faz (`ThreadManagementService.ts:845-894`). O motor nunca manda o próprio "continue".
4. **hillclimb, arena, graph e interrogate são tipos nativos de nó**, cada um com sub-estado tipado e sub-decisor puro. Todos executam pelos mesmos três executores (turno de agente, comando, operação git), então o crash e a retomada são os mesmos para tudo.
5. **O arquivo é a fonte da verdade.** Cada workflow é um `<id>.workflow.yaml` num repositório git do host de bots. Canvas, bot (MCP) e edição à mão passam pelo mesmo compilador e viram commit. Uma edição à mão aparece no canvas aberto. Cada execução fixa o commit e o hash semântico da versão.
6. **Cada passo roda no host**, como uma thread T3 comum, na mesma instância de provider e com o mesmo acesso dos bots: a tela `:99` do computer use, os MCPs do host e o resto. Um comando que faria deploy, restart, merge na `friend/main`, force push ou mudança no `~/.t3/userdata/settings.json` espera um portão que só o Israel decide. O portão não é uma barreira: um passo com shell consegue contornar o portão, e o Israel aceitou esse risco (§9.5). Só o motor empurra uma branch `wf/…` e abre o PR em rascunho.
7. **Gatilhos reaproveitam o que existe.** O webhook vira uma `ScheduledTask` (URL, HMAC, filtros, dedupe e URL pública prontos). O cron com fuso usa o `Scheduler` compartilhado com `effect/Cron`. A `ScheduledTask` não tem cron nem fuso.
8. **Poucas seams.** São nove arquivos do upstream, e sete deles já são seams hoje. A única lógica de servidor nova num arquivo do upstream é o gancho e o guard das tasks de webhook no `ScheduledTaskService`.
9. **Canvas: React Flow com traço desenhado à mão via roughjs.** Os dois são MIT. O pedaço preguiçoso tem 65 KiB gzip, contra 2,4 MiB do Excalidraw. A biblioteca já impede seta solta. O tldraw ficou de fora pela licença.

### 0.1 Como se usa

> **Workflows** rodam no host de bots. As threads dos passos ficam fora da lista normal de threads e aparecem só na tela de Workflows; cada uma tem um link de volta para a execução. Cada workflow é um arquivo YAML num repositório git do host (Settings → Bots → Workflows mostra o caminho). Abra **Workflows** na barra lateral para desenhar um no canvas, comece de um modelo pronto (merge do upstream, hillclimb do computer use, corte de tokens MCP, correções viram enforcement) ou peça a um bot: "monta um workflow que…". Cada save vira commit, e cada execução usa a versão exata com que começou. A tela da execução mostra cada passo ao vivo: thread, tokens, custo estimado e, nos blocos, o estado deles (rodada do hillclimb, melhor métrica, rodadas sem ganho). Portões mandam push para o celular e são aprovados na tela da execução. Bots criam, editam, validam, rodam e listam workflows, mas nunca aprovam portão. Um comando de workflow que faria deploy, restart, merge na `friend/main`, force push ou mudança no `settings.json` espera a sua aprovação na tela da execução. Workflows terminam num PR em rascunho ou num relatório, mais o comando que você roda.

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
  // laço próprio que só começa depois da recuperação do upstream (forkParked)
  yield* forkParked(engine.tick.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
  // tick: promove TriggerFired órfãos e, por execução viva, liga o ator da execução, que dobra o journal,
  // reexecuta intents pendentes com as mesmas chaves, liga os sensores (waitForThread, exit.json)
  // e volta ao laço decide → gravar → executar.
});
```

---

## 1. Tipos e contrato

O contrato implementado está em [`packages/contracts/src/workflows.ts`](../../packages/contracts/src/workflows.ts) e o compilador em [`packages/shared/src/workflows/`](../../packages/shared/src/workflows/). Os blocos desta seção mostram a forma; o código manda nos detalhes. Três diferenças em relação ao texto original:

- os nomes exportados levam o prefixo `Workflow` (`WorkflowModelRef`, `WorkflowAgentNode`, `WorkflowTemplate`…), como os do kanban levam `Kanban`. O `index.ts` reexporta tudo, e um `ModelRef` futuro do upstream quebraria o `export *`;
- dentro da definição, os ids são strings com pattern, sem brand. Assim o tipo decodificado é JSON puro e cabe no `Schema.suspend` dos corpos de `map` e `loop`. As chaves de `nodes`, `params`, `models` e `workspaces` são `Schema.String` e o compilador confere o nome, porque um `Record` com chave refinada descarta em silêncio a chave que não casa;
- o decode recusa campo desconhecido (`onExcessProperty: "error"`). Sem isso, um campo com erro de digitação some sem aviso.

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
/** A definição escolhe provider e modelo, nunca a instância. O host de bots resolve para a
 *  instância em que roda os bots. */
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

/** Checkout que o motor cria (único jeito de ganhar um): uma worktree git no host, em
 *  `~/.t3/workflows/runs/<runId>/<nome>`; a branch renderiza para `wf/…`. */
export const WorkspaceDecl = Schema.Struct({
  project: Template,
  base: Template, // ref, ou "workspace:<nome>" para partir do HEAD de outro
  branch: Template,
  // o que sobra quando a execução acaba; depois, a árvore toda sai em 7 dias, menos `always` e worktree com PR aberto
  retain: Schema.optional(Schema.Literals(["always", "on_failure", "never"])), // padrão on_failure
});
export const WorkspaceUse = Schema.Union([
  Schema.String, // nome em `workspaces` ou exportado por bloco (`climb.best`)
  // worktree destacada e descartável no sha do projeto fixado na partida (`git rev-parse`, sem checkout); o que for escrito nela se perde
  Schema.Struct({ project: Template, readOnly: Schema.Literal(true) }),
]);

/** Check de aceitação de um passo de agente. Quem roda é o motor, nunca o próprio agente:
 *  um comando na worktree do passo, ou um turno de juiz (thread nova, só leitura). */
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
  // "new" (padrão) ou "continue:<nodeId>". Uma thread tem um só acesso, uma só worktree e um só modelo
  // a vida toda: o compilador só aceita continue com o mesmo workspace, access e modelo.
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
  as: Schema.optional(NodeId), // nome extra para `item`, para um corpo aninhado alcançar o item de fora
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

Os gatilhos (`WorkflowTrigger` em `packages/contracts/src/workflows.ts`) ficam num mapa por id,
como os nós, e dividem o espaço de nomes com eles. Os tipos e o que muda entre eles estão na §5.

```ts
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
  triggers: Schema.optional(Schema.Record(Schema.String, WorkflowTrigger)),
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
  // 1. decode com errors: "all" e onExcessProperty: "error" → diagnósticos com caminho
  // 2. nomes de nó, param, modelo e workspace no pattern; id de nó único em todos os níveis
  // 3. edges "a:porta -> b" por nível; portas: agent/command ok|fail, com check ou accept pass|fail,
  //    gate <options>, branch <portas>|else, blocos ok|fail|<saídas nomeadas>; desconhecida → "port"
  // 4. acíclico em cada nível (map/loop são nós; seus corpos são grafos à parte); call sem ciclo
  // 5. toda Expr/Template parseada; raiz legal no contexto; `nodes.<id>` só de nó que já rodou
  // 6. contaminação: trigger.*, param string sem pattern e saídas de agente sem `pattern` não entram em argv, env, ref git nem branch
  // 7. classifyCommand(argv): shell inline, programa dinâmico, escalada de privilégio → erro; ação protegida → aceita (portão na execução, §9.5)
  // 8. heavy && (selfSerializing || argv cita heavy.sh) → "heavy-nesting"
  // 9. modelos: sem apelidos (opus|sonnet|haiku|fable), $refs resolvem; arena: família(judge) ≠ família(lead)
  // 10. orçamentos ≤ teto do host, timeouts ≤ wall; tokensFrom exige tokenReservation
  // 11. thread "continue:<nó>" só com o mesmo workspace e o mesmo access do nó continuado
  // 12. gatilhos: id único, cron e fuso parseiam, replayKey, pattern da tag; card fora de projeto do Linear
  // 13. hash = sha256(JSON canônico sem canvas), com as edges reescritas como "a -> b"
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

`classifyCommand` lê o argv de um nó `command`. No save, ele recusa o que esconderia do portão o que o comando faz: shell inline, programa vindo de template, `xargs`, escalada de privilégio e agendamento fora da execução. Na execução, um argv classificado como deploy, restart, merge, force push ou mudança no `settings.json` espera o portão do Israel (§9.5).

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
  "skipped", // TriggerSkipped; o motivo vem em skipReason
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
export const RunSummary = Schema.Struct({
  runId: RunId,
  workflowId: WorkflowId,
  title: Schema.String,
  hash: Schema.NullOr(SemanticHash), // null enquanto queued ou skipped: nenhuma versão fixada ainda
  commit: Schema.NullOr(Schema.String),
  status: RunStatus,
  pausedFor: Schema.NullOr(Schema.Literals(["fatigue", "ambiguous", "user"])),
  skipReason: Schema.NullOr(Schema.Literals(["busy", "disabled", "suspended", "invalid"])),
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

Migração do fork `apps/server/src/bots/migrations/014_Workflows.ts`, chave `14_Workflows` em `BotsDb.ts:28`. Nenhuma tabela do upstream muda. Ids de thread ficam sem chave estrangeira entre bancos, como em `thread_watches` (`migrations/002_ThreadWatches.ts:8`). Os arquivos ficam em `~/.t3/workflows/`: definições, recibos, segredos e as worktrees e saídas das execuções (`runs/<runId>/`).

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
  pull_request_url TEXT,
  summary_json TEXT NOT NULL DEFAULT ''); -- o WorkflowRunSummary inteiro; as colunas servem a filtro e ordem
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
  | { _tag: "RunPaused"; reason: "fatigue" | "ambiguous" | "user"; detail }
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
  | { _tag: "ChildRunEnded"; childRunId; status; output; cost }; // "child:<childRunId>"

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
      runPath; // o cartão aponta para a execução; nunca liga thread de passo
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
  | { _tag: "ArchiveThread"; key; threadId }
  | { _tag: "Record"; facts: ReadonlyArray<StreamFact> }; // decisão pura, sem execução
// A união é fechada: o próprio motor não tem intent de merge em ref protegida, deploy, restart ou push forçado.
// Um nó `command` com ação protegida (§9.5) ganha antes do StartUnit um OpenGate que só o Israel decide.

/**
 * Puro. Ordem: 1 terminal? → [] · 2 controles · 3 orçamento · 4 fadiga
 * 5 pedidos de runtime → AnswerRequest ou OpenGate · 6 assentar passos com resultado
 * 7 avançar o grafo (primitivo → intents, com portão do Israel antes de comando protegido; bloco → blockDeciders[kind].decide)
 * 8 timeouts e expiração de portão por ctx.now · 9 nada vivo e nada pronto → OutputSet + RunEnded
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

O ator de cada execução (`runActor` em `WorkflowEngine.ts`, uma fibra por execução viva num `FiberMap`) faz: dobrar, reexecutar intents pendentes com as mesmas chaves, ligar sensores e repetir `decide → gravar → executar` até o fim. Cada append publica `(stream, seq)` num `PubSub`. O ator acorda com fato novo no seu stream ou no prazo de `nextDeadline`. Os próprios fatos são a caixa de entrada, e nenhuma fila em memória pode perder mensagem.

**Como a fatia 2 implementou** ([`apps/server/src/bots/workflows/`](../../apps/server/src/bots/workflows/)):

- `decide` devolve os fatos a gravar (`NewFact[]`), não intents: um intent executável sai como `IntentRecorded`, o que substitui o intent `Record`. `BranchTaken` virou `StepResolved` com a porta escolhida. `BlockAdvanced` e `once` chegam com os blocos (fatia 7).
- Chaves no stream da execução: `turn:`, `nudge:`, `accept:`, `judge:`, `unit:`, `ws:`, `pin:`, `child:`, `open:<gateKey>` para o intent do portão e `gate:<gateKey>` para a decisão, `resolved:<passo>@<n>`, `skip:`, `expand:`, `iter:`, `output`, `ended`.
- Um passo que resolve numa passada é relido na mesma passada, então a nova tentativa, os sucessores, o próximo item do `map` e a próxima iteração do `loop` saem no mesmo lote.
- A execução filha grava `ChildRunEnded` no stream do pai no mesmo lote do próprio fim.
- Um `IntentFailed` com `retryable` não é gravado: o ator executa a mesma chave de novo depois de `retryEvery` (30 s).
- O ator decide até ficar quieto antes de executar o que está pendente. Depois do `RunEnded`, um início ainda sem recibo vai para `WorkflowInterpreter.abandon` (nunca é executado), e um início cujo recibo chegou atrasado é interrompido. Cada interrupção é do intent de início vivo, com chave `interrupt:<chave do intent>`.
- Todo início, inclusive `accept`, `nudge` e `judge`, gasta um passo do orçamento. O `accept.argv` passa pelo mesmo portão do Israel que o argv de um nó `command`.
- De `pause` e `resume`, só o controle mais recente vale, com a chave dele. `amendBudget` fica gravado e a fatia 8 aplica o novo teto.
- O tick do motor é um laço próprio que espera a ativação do servidor (`forkParked`). O `Scheduler` compartilhado é fornecido dentro do `runtimeLayer` e não chega à camada dos bots.
- Ainda não: `retry` de passo numa execução já terminada (o `RunEnded` é final), orçamento por tokens, reserva e tempo ativo (fatia 8) e a publicação do PR (fatia 8).

### 3.2 Execução

```
      TriggerFired (gatilho | manual | bot | filho | rotina falhou)
                       │ decisor do workflow: txn RunCreated (workflow:) + RunStarted (run:) + cache
                       ▼
     ┌──────────► running ── pause / fadiga / ambíguo ──► paused
     │              │  │                                                │
     │  resume ◄───────┼────────────────────────────────────────────────┘
     │              │  └─ orçamento estourado ─► Interrupt dos vivos ─► budget_exhausted
     │              ├─ cancel ─► Interrupt dos vivos ─► cancelled
     │              └─ nada vivo e nada pronto ─► OutputSet ─► succeeded | failed
     └── retry de um passo numa execução failed ─► running (tentativa + 1)
```

**Do gatilho à execução.** Todo pedido de execução é primeiro um `TriggerFired` no stream do workflow, com chave = ocorrência. Quem cria a execução é o **decisor do workflow**, outra função pura (`decideWorkflow(workflowState, ctx) -> WorkflowIntent[]`) que o motor roda no tick e logo depois de cada `TriggerFired`. Para cada `TriggerFired` sem `RunCreated` nem `TriggerSkipped`, ele decide entre:

- criar a execução (`RunCreated` + `RunStarted`, uma transação);
- pular, com `TriggerSkipped{disabled | suspended | invalid}`; se o gatilho é de um filho (`call`), o mesmo batch grava `ChildRunEnded{skipped}` na execução pai, que senão esperaria para sempre;
- esperar: `concurrency: queue` com execução viva deixa o fato pendente até ela acabar, e `single` grava `TriggerSkipped{busy}`.

O `runId` é derivado da ocorrência, então `start`, `run.start` e `workflow_run` devolvem o `runId` na hora, com status `accepted`, mesmo que o motor ainda esteja subindo ou a execução esteja na fila. Promover duas vezes bate na mesma chave.

O fim é atômico. Num único append vão `OutputSet` e `RunEnded` em `run:<id>`, `RunOutcome` em `workflow:<id>` e, se a execução falhou, os `TriggerFired` dos workflows que assinam `workflowFailed`. Notificações e cartões do fim são intents gravados nesse mesmo batch. Na partida, o motor carrega as execuções vivas e também as terminadas com `pending_intents > 0`. Assim nenhuma consequência some entre duas gravações.

O caminho de volta: `failed` aceita `retry` de um passo, `paused` aceita `resume`, `budget_exhausted` aceita `amendBudget` (registrado como `ControlRequested`, com o novo teto) seguido de `resume`, e um workflow suspenso por fadiga aceita `Unsuspended`. Uma nova versão roda numa execução nova.

O `retry` segue a regra de "rodar de novo" do portão ambíguo: a tentativa seguinte do passo começa na hora, sem olhar `retry.max`. Ele vale para um passo do nível de cima cuja última tentativa não teve sucesso e cuja falha ainda não levou a nenhum sucessor; o motor recusa no RPC o que não cabe. Numa execução `failed`, o motor grava `RunReopened` e a execução volta a `running`. Repete também o que o fim parou, e os caminhos mortos que a falha cortou voltam a ser avaliados; o fim seguinte e o seu `RunOutcome` ganham chaves com o número da reabertura (`ended:1`, `outcome:<runId>:1`). Não reabre: uma execução `cancelled`, `succeeded` ou `budget_exhausted`, uma execução filha (repete-se o passo `call` do pai) ou uma cuja worktree o `retain` já removeu.

A projeção `workflow_runs` é o que as listas leem: o ator grava a linha da execução depois de dobrar fatos novos, o motor grava a de uma execução criada na hora, e na partida refaz as linhas que faltam ou ficaram atrás do stream. O `lastRun` do resumo de cada workflow vem da mesma tabela.

Quando a execução acaba e nada mais roda nas suas worktrees, o motor grava `RemoveWorkspace` para o que o `retain` solta: um checkout só leitura sempre sai; uma worktree declarada fica com `always`, ou com `on_failure` (o padrão) se a execução não teve sucesso. A branch `wf/…` fica.

### 3.3 Passo

```
pending ─(deps resolvidas, join ok)─► guarda falsa ─► skipped (caminho morto se propaga)
   │                                 once no ledger ─► skipped(once)
   ▼ guarda verdadeira, orçamento reservado
   ├─ comando com ação protegida ─► OpenGate do Israel ─► waiting_gate ─► rejeitado: failed (porta fail, nada roda)
   │    (a aprovação vale para o argv mostrado no portão; se ele renderizar diferente depois, o passo falha)
dispatched (IntentRecorded StartTurn|StartUnit)
   ▼ fato de resultado
running (TurnStarted | UnitSpawned) ── RuntimeRequest ──► AnswerRequest (segue) | OpenGate ──► waiting_gate
   (o portão mostra as perguntas ou o pedido de aprovação; a resposta do Israel vai como `answers` por pergunta, ou `accept`)
   ▼ observação (TurnSettled | UnitExited)
StepResolved: succeeded | failed | lost | timed_out | cancelled | ambiguous
   ├─ retry casa e há tentativas ─► dispatched (tentativa + 1, chaves novas)
   └─ ambiguous ─► RunPaused(ambiguous) + portão "rodar de novo / marcar falho / cancelar"
```

Saída de agente: o motor lê `subagentResultForRun` (`packages/provider-core/src/server/subagentProjection.ts:168`) e procura o último bloco ```json. Se `output` foi declarado, o JSON precisa decodificar e bater com a forma: tipos, `pattern` e campos obrigatórios (`checkOutput`). Só os campos declarados seguem para os sucessores, porque o compilador confia num campo com `pattern` em argv, env e refs. Se o JSON falta ou não bate, o motor manda um turno de cobrança na mesma thread ("termine com o JSON no formato X"). Se falhar de novo, o passo falha. O veredito de um juiz só conta de um turno que terminou `completed` com JSON válido; um comando de aceite sem desfecho conhecido (perdido, sem leitura, timeout) falha o passo sem ler o `check`. Turnos de cobrança e de juiz seguem a regra do turno principal: só o cancelamento do upstream num restart vira `lost` e repete o passo. O texto padrão "completed without an assistant result" nunca passa como saída.

Se o motor não consegue ler um passo vivo por cerca de cinco minutos (projeção ou recibo ilegível), ele tenta parar o original (interrupt da thread, `systemctl --user stop` da unit) e grava o desfecho como desconhecido (`TurnSettled{unobserved}`, `UnitExited{signal: "UNOBSERVED"}`). O decisor pausa a execução com o portão "rodar de novo / marcar falho / cancelar", como num comando `replay: never` que sumiu: nenhuma política de `retry` repete esse passo sozinha, porque o original pode continuar rodando na mesma worktree. "Marcar falho" encerra as tentativas desse passo; só "rodar de novo" abre outra. Um erro de execução que se pode repetir é tentado dez vezes antes de virar falha.

### 3.4 Tabela de crash: o processo morre entre duas linhas quaisquer

| Janela                                                              | Estado durável                                                               | O que a partida faz                                                                                                                                                                                                                                                                                                                                                                                                                                 | Por que não duplica                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decide` voltou, nada gravado                                       | nada                                                                         | decide de novo                                                                                                                                                                                                                                                                                                                                                                                                                                      | nada externo aconteceu                                                                                                                                                                                               |
| `TriggerFired` gravado, `RunCreated` não                            | fato órfão no stream do workflow                                             | o decisor do workflow (§3.2) promove: cria a execução, pula ou enfileira                                                                                                                                                                                                                                                                                                                                                                            | `runId` é derivado da ocorrência; promover duas vezes bate na mesma chave                                                                                                                                            |
| `StartTurn` gravado, `launch` não chamado                           | intent pendente                                                              | `launch` com `threadId = wf:<runId>:<sha(key)>` e `commandId = wf:<sha(key)>`                                                                                                                                                                                                                                                                                                                                                                       | primeira chamada de fato                                                                                                                                                                                             |
| `launch` confirmou no upstream, `TurnStarted` não gravado           | intent + thread no upstream                                                  | `launch` de novo com a mesma entrada: o recibo devolve a mesma thread (`ThreadLaunchService.ts:838-858`); o motor passa o `messageId` derivado da chave, porque o do upstream, se faltar, é aleatório (`:945-951`)                                                                                                                                                                                                                                  | recibo do upstream                                                                                                                                                                                                   |
| `StartTurn{continue}` gravado, `sendToThread` sem resultado gravado | intent pendente                                                              | `sendToThread` de novo com o mesmo `commandId`, `messageId` derivado e `mode: "queue"` (`ThreadManagementService.ts:761-800`)                                                                                                                                                                                                                                                                                                                       | recibo do upstream; `queue` nunca vira steer de uma continuação de restart                                                                                                                                           |
| turno rodando, servidor reinicia                                    | passo running                                                                | sensor chama `waitForThread(untilDelegatedWorkSettled)`, que segue `restartContinuationOfRunId` e espera efeitos de restart pendentes (`ThreadManagementService.ts:873-894`)                                                                                                                                                                                                                                                                        | o motor não manda "continue"                                                                                                                                                                                         |
| upstream cancelou o turno por não poder retomar                     | passo running                                                                | `TurnSettled{cancelled}` → `lost` → o motor repete o passo até duas vezes, sem precisar de `retry` na definição (comandos `lost` também). Com `access: write`, a nova tentativa abre thread nova **na mesma worktree**, avisada de que a anterior foi interrompida                                                                                                                                                                                  | nova tentativa é decisão gravada, com chave nova                                                                                                                                                                     |
| `StartUnit` gravado, unit não criada                                | intent pendente                                                              | `exit.json` existe? adota. Unit `wf-<k>` ativa? observa. `started.json` existe? perdido (abaixo). Nada? cria a unit                                                                                                                                                                                                                                                                                                                                 | `started.json` é gravado com fsync depois do lock e antes do argv; sem ele, o comando não começou. `systemd-run --unit` recusa nome repetido enquanto a unit vive, e `--collect` limpa a que falhou antes de começar |
| unit rodando, servidor reinicia                                     | passo running                                                                | a unit sobrevive (é do gerenciador do usuário, fora do cgroup do `t3-friend.service`); o sensor vê `exit.json` depois                                                                                                                                                                                                                                                                                                                               | ninguém mata a unit                                                                                                                                                                                                  |
| `started.json` sem `exit.json`, unit sumiu (OOM, reboot)            | passo running                                                                | `replay: safe` → nova tentativa; `replay: never` → `ambiguous`, a execução pausa com portão "rodar de novo / marcar falho / cancelar"                                                                                                                                                                                                                                                                                                               | nunca conclui "não rodou" só porque falta o recibo                                                                                                                                                                   |
| `PrepareWorkspace` interrompido                                     | intent pendente                                                              | o motor roda `git worktree prune`, adota a worktree que já existe no caminho com a branch esperada, ou apaga o resto e refaz; a branch `wf/…` guarda a execução dona (`git config branch.<b>.wfrun`); se ela é de uma execução que terminou, o motor a solta (a worktree antiga fica destacada com os arquivos, a cabeça fica em `refs/wf-runs/<dono>/<branch>`) e cria a branch nova no `baseRef`; se é de uma execução viva ou de ninguém, recusa | caminho e branch derivados da chave                                                                                                                                                                                  |
| `GitOp advance` feito, resultado não gravado                        | intent pendente                                                              | o motor faz `update-ref refs/heads/wf/… <to> <from>`; se a ref já é `<to>`, conta como feito. O motor guarda o sha no journal e não depende da ref                                                                                                                                                                                                                                                                                                  | compare-and-swap na ref                                                                                                                                                                                              |
| `GitOp mergeLocal` interrompido                                     | intent pendente                                                              | se `HEAD` já contém `from` (`merge-base --is-ancestor`), feito; se há `MERGE_HEAD`, `merge --abort` e refaz                                                                                                                                                                                                                                                                                                                                         | worktree é só da execução                                                                                                                                                                                            |
| `OpenPullRequest` interrompido                                      | intent pendente                                                              | refaz: push sem força do sha gravado no journal (não do `HEAD` da worktree) para a `WfBranch`; push do mesmo sha é no-op; `gh pr list --head <branch>` acha o PR e grava                                                                                                                                                                                                                                                                            | o PR é achado pela branch                                                                                                                                                                                            |
| `Notify(push)` enviado, `Notified` não gravado                      | intent pendente                                                              | reenvia                                                                                                                                                                                                                                                                                                                                                                                                                                             | entrega pelo menos uma vez; o Android deduplica por `alert_id = key` (`AgentNotifications.kt:146`)                                                                                                                   |
| portão decidido duas vezes ou de dois aparelhos                     | `GateDecided` com chave `gate:<key>`                                         | nada                                                                                                                                                                                                                                                                                                                                                                                                                                                | o primeiro vence; o segundo recebe a decisão existente                                                                                                                                                               |
| tick do cron roda duas vezes na mesma ocorrência                    | `TriggerFired` com chave da ocorrência                                       | nada                                                                                                                                                                                                                                                                                                                                                                                                                                                | chave única                                                                                                                                                                                                          |
| `RunEnded` gravado com obrigações                                   | mesmo batch que `RunOutcome`, `TriggerFired` dos assinantes e intents de fim | partida carrega terminadas com `pending_intents > 0`                                                                                                                                                                                                                                                                                                                                                                                                | o fim é atômico                                                                                                                                                                                                      |
| save de definição interrompido                                      | arquivo escrito, commit ou versão faltando                                   | a varredura de partida trata como edição à mão (§7.3) e completa commit, versão e tasks de webhook                                                                                                                                                                                                                                                                                                                                                  | cada passo do save é idempotente                                                                                                                                                                                     |

A ordem da partida é: o motor roda o próprio tick com `forkParked` (`apps/server/src/serverActivation.ts`), que só começa depois da recuperação do upstream, e só no host de bots (`bots/layer.ts`). O `Scheduler` compartilhado não é exportado para o layer de bots. Enquanto o motor não está pronto, `run.start`, `workflow_run` e o gancho do webhook gravam o `TriggerFired` no journal e respondem "aceito". A execução nasce quando o motor fica pronto. Nada cai num lançamento comum de thread.

### 3.5 Mapa de módulos

Todos os caminhos são novos e do fork.

````
packages/contracts/src/workflows.ts           §1: schemas, RPCs, WORKFLOWS_WS_METHODS, escopos
packages/shared/src/workflows/                compileWorkflow, parseExpr, evalExpr, renderTemplate, classifyCommand, modelFamily (export ./workflows)
packages/contracts/src/bots.ts (do fork)      + export * from "./workflows.ts"; ...WORKFLOWS_RPCS em BOTS_RPCS; escopos

apps/server/src/bots/workflows/
  facts.ts  fold.ts  decide.ts  view.ts       fatos como Schema, dobra, decisão pura, visões
  blocks/{hillclimb,arena,graph,interrogate}.ts   um BlockDecider cada
  Journal.ts            append(batch) em BEGIN IMMEDIATE, read, liveRuns, changes (PubSub), rebuildProjections
  Interpreter.ts        execute, abandon e observe de cada intent → fatos de resultado e observações
  WorkflowEngine.ts     serviço público (start, control, decideGate, runView, subscribeRun, listRuns, metrics, ledger, isStepThread)
                        e o ator de cada execução (FiberMap), com o próprio tick
  exec/HostInterpreter.ts  o Interpreter no host: manda cada intent ao executor; caminhos e nomes de unit derivados da chave
  exec/Turns.ts         launch, sendToThread, observação por waitForThread em blocos de 15 s com os pedidos de runtime, interrupt, resposta
  exec/turnResult.ts    último bloco ```json e custo da execução e das continuações de restart
  exec/Units.ts         uma unit systemd-run por comando; com heavy, o flock do heavy.lock e os limites do heavy.sh na mesma unit;
                        o observador lê exit.json
  exec/wfUnit.ts        roda na unit: started.json (fsync) → argv → exit.json (rename atômico)
  git/Workspaces.ts     git do motor no host: worktrees, update-ref com CAS, merge local; sem hooks (o push para wf/… é da fatia 8)
  layer.ts              o bloco do motor: journal, catálogo, interpretador e executores; o SqlClient do bots.sqlite fica privado
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
apps/server/src/bots/layer.ts (do fork)   + WorkflowTriggerHook no layerCore; o bloco de workflows/layer.ts no layerService

packages/client-runtime/src/workflows.ts      toCanvasModel, fromCanvasModel, mergeDocuments, autoLayout, mergeRunDelta, statusTone
packages/client-runtime/src/state/bots.ts     + átomos de workflows (comandos e assinaturas)
apps/web/src/bots/workflows/                  WorkflowsPage, WorkflowEditor (CanvasHost, Inspector, SourceTab, MergeDialog),
                                              RunView, MetricsPanel, LedgerView, canvas/reactFlowAdapter.tsx, canvas/roughSkin.tsx
apps/web/src/routes/_chat.workflows*.tsx      lista, editor, execução (declarados do fork)
apps/mobile/src/bots/workflows/               WorkflowsScreen, WorkflowScreen, RunScreen (grafo em react-native-svg), GateSheet, LightEditScreen
scripts/friend/wf/                            CLIs JSON das rotinas (§11)
````

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
4. **Build.** Comando heavy. Antes de medir, o motor copia o artefato para `~/.t3/workflows/runs/<runId>/artifacts/<sha>/`, para que a medição não dependa da worktree da tentativa. Sem `artifact`, o build só prepara a worktree (o `vp i` do corte de tokens) e nada é copiado.
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

| Gatilho                  | Fonte                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Ocorrência                      | Observações                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cron com fuso**        | do fork: `Cron.parse(expr, tz)` (`.repos/effect-smol/packages/effect/src/Cron.ts:545`) avaliado no tick do `Scheduler` compartilhado. `occ = Cron.prev(cron, now)`; dispara se `occ > última ocorrência` e está dentro do `misfire.grace` (padrão `latest` e 1 h). Ativar grava a marca d'água, então nada é recuperado do passado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `cron:<trigger>:<occ ISO UTC>`  | A `ScheduledTask` só tem intervalo e hora fixa no fuso do host (`Schedule.ts:12-37`) e sua chave de disparo não identifica a ocorrência (`ScheduledTaskService.ts:807-812`). Horário duplicado no fim do horário de verão tem duas chaves UTC distintas                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **webhook**              | **reaproveita a `ScheduledTask`**. `reconcileWebhooks` (no save e em todo tick) faz `upsert`, dentro do escopo do motor, da task `wf-hook:<workflowId>:<trigger>` com `schedule: {type: "webhook", signature, filters, dedupe: { replayKey, coalesceKey: "{{request}}", coalesceWindowSeconds: 10 }}`, `prompt: template ?? "{{request}}"` e `projectId: home`. Tirar o gatilho apaga a task. O segredo do HMAC fica em `~/.t3/workflows/secrets/` e vai como `secret` em cada recriação (um `secretRef` só vale uma vez, `ScheduledTaskService.ts:1104-1107`). A task aparece na tela de tarefas como "gerenciada pelo workflow X", e o guard da seam (§12) recusa editar, desligar, apagar ou "rodar agora" fora do motor. Se alguém apagar o banco por fora, o tick recria a task, e como o token da URL é novo, o motor avisa o Israel da URL nova | `webhook:<deliveryId>`          | O `coalesceKey` nunca vazio faz a entrega virar linha durável em `scheduled_task_webhook_pending` **antes** do 202 (`webhookDedupe.ts:85-90`). Sem ele, a entrega imediata fica só em memória até o despacho (`ScheduledTaskService.ts:1986-2034`). O custo é até 10 s de latência. O worker durável despacha por `runTask`, onde está o gancho (§12). HMAC, prova do relay, filtros, limites e URL pública (`webhookPublicBase.ts:54`) vêm de graça. O payload chega estruturado (`trigger.method`, `path`, `query` e `headers` redigidos, `body`, até 256 KiB) e também como `trigger.text`, o `template` renderizado com a moldura de não confiável (`webhookTemplate.ts:148`) |
| **bot**                  | MCP `workflow_run`, só pelo gatilho `bot` declarado (§5.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `bot:<botId>:<clientRequestId>` | No fim, um `Notify{thread}` acorda o bot com o link, como o `ThreadWatchReactor` (`ThreadWatchReactor.ts:45`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **manual**               | RPC `run.start` (web, desktop, Android), só com gatilho `manual` declarado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `manual:<clientRequestId>`      | O mesmo `clientRequestId` com parâmetros diferentes é erro, não a execução velha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **tag nova no upstream** | poller do fork no tick: `git ls-remote --tags --refs <remote>`, maior tag que casa com `pattern`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tag:<remote>:<tag>:<objeto>`   | Só leitura: não faz fetch nem mexe em ref local, então tag local perdida não ganha (`merge-upstream.ts:30-41` faz fetch e confia em tags locais). O sha do objeto entra na chave: tag movida é ocorrência nova e aparece como tal                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **PR mergeado**          | `scope: linked`: `streamStoredEventsFrom({ afterSequence: cursor, eventType: "thread.pull-request-link-updated" })` (`Orchestrator.ts:416-420`, evento em `contracts/orchestrationV2.ts:2728`) mais a cauda ao vivo. `scope: repo`: `gh api` de PRs fechados desde o cursor, a cada 10 min no mínimo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `pr:<repo>#<n>:<mergeSha>`      | `linked` cobre PRs ligados a threads T3; `repo` cobre o repositório inteiro, com custo de cota da API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **thread terminou**      | cursor em `thread.settled` (`ThreadSettlementService.ts:603`), filtrado por projeto, bot ou prefixo de título; threads de passo de workflow ficam de fora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `settled:<threadId>:<seq>`      | "Terminou" é `thread.settled`, não um `run.updated` terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **rotina falhou**        | o próprio motor: no batch atômico do fim (§3.2), grava `TriggerFired` nos assinantes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `run-failed:<runId>`            | `causalDepth` do filho = pai + 1; dispara só se `< 2` e se o assinante ≠ origem. Não há laço infinito                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Um workflow declara seus gatilhos num mapa por id (`triggers.<id>`), que divide o espaço de nomes
com os nós: o id também chaveia a posição do nó de entrada no canvas. Há três tipos sob demanda,
`manual`, `bot` e `call`, no máximo um de cada, em que quem chama passa os parâmetros; os de evento
(`webhook`, `cron`, `upstreamTag`, `prMerged`, `threadSettled`, `workflowFailed`) mapeiam o payload
para os parâmetros com `params`. Qualquer gatilho começa o grafo inteiro: o motor não roteia por
gatilho, e um ramo por gatilho se escreve com `when` sobre `trigger.id`. Um nó `call` só compila
contra um workflow com gatilho `call` que o aceite em `from`.

### 5.1 Switches e quem dispara

O switch do workflow (`Toggled`) arma todos os gatilhos; cada gatilho tem o seu (`TriggerToggled`,
ligado até alguém desligar), porque desligar só um webhook não pode virar commit. Uma função pura,
`triggerBlock` (`triggers/policy.ts`), decide se um `TriggerFired` vira execução: o decisor do
workflow é a autoridade, e os handlers da RPC e do MCP chamam a mesma função para recusar antes.
A origem vem do prefixo da ocorrência, que só o servidor escreve: `manual:` e `test:` são do dono e
ignoram os dois switches (dá para testar sem armar cron e webhook); a suspensão por fadiga continua
bloqueando. Um `call` respeita o switch do filho, para uma edição de bot sem permissão (que desliga o
workflow) não rodar chamada pelo pai.

### 5.2 Gatilho bot

O gatilho `bot` expõe o workflow aos bots: `workflow_list` mostra a `description` (quando usar) e os
parâmetros, e `workflow_run` recusa um workflow sem esse gatilho ou um bot fora de `bots`, mesmo com
`canManageBots`. Por cima vale a regra do turno do dono: um bot sem `canManageBots` só roda, cancela
ou liga um workflow num turno aberto por mensagem do próprio Israel. O payload grava `bot.id`, e o
decisor confere a lista de novo na promoção, porque a definição pode mudar no meio.

### 5.3 Último evento e modo de teste

`workflow_trigger_samples` guarda o último evento de cada gatilho: o journal grava a linha na mesma
transação do `TriggerFired`, e o snapshot leva só a data (`lastFiredAt`). O payload, de até 256 KiB,
nunca vai no snapshot nem nos deltas da execução: a tela lê pela RPC (`trigger.sample`,
`run.trigger`) quando abre.

"Listen for test event" é o stream `trigger.listen`: por 120 s, a próxima entrega aceita pela task
do webhook (mesmo HMAC, filtros e dedupe da produção) é capturada e não cria execução. A captura
grava a amostra e uma marca por `deliveryId` (`workflow_test_deliveries`) na mesma transação, e o
gancho confere a marca antes de disparar: uma entrega de teste reentregue depois de um crash, quando
ninguém mais escuta, é confirmada sem execução. "Run with this event" chama `run.start` com
`testTrigger` e roda o mapeamento `params` sobre a amostra.

Dentro de um `prompt` de agente, todo buraco que lê `trigger.*` (menos `text`, `id` e `kind`) sai
entre `<trigger-data>` e `</trigger-data>`, com uma nota de dado não confiável; o compilador já os
mantém fora de argv, env e refs.

Os cursores (`workflow_cursors`) avançam só depois do `TriggerFired` gravado. Perder um cursor relê eventos, e as chaves deduplicam. Todas as fontes sobem só no host de bots.

Contaminação: valores de webhook, título de PR e texto de thread são **não confiáveis**. O compilador proíbe que entrem em argv, env ou nome de branch, a não ser por um parâmetro com `pattern`, decodificado nesse pattern na partida. Nos prompts eles entram com a moldura de dado não confiável.

---

## 6. Ferramentas MCP para bots

Toolkit do fork `WorkflowToolkit` (`apps/server/src/bots/workflows/mcp/tools.ts` e `handlers.ts`), registrado no hunk do fork que já existe em `McpHttpServer.ts:1174`.

| Ferramenta             | Parâmetros                                                 | Saída                                                                         | Anotação                              |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `workflow_list`        | `{ includeTemplates? }`                                    | `{ you, workflows: [{ id, title, valid, enabled, triggers, bot, lastRun }] }` | leitura                               |
| `workflow_get`         | `{ workflowId }`                                           | `{ source, revision, hash, diagnostics, enabled }`                            | leitura                               |
| `workflow_save`        | `{ workflowId?, source, baseRevision?, message, dryRun? }` | `{ ok, workflowId?, revision?, commit?, diagnostics, webhooks? }`             | escrita; `dryRun: true` é a validação |
| `workflow_set_enabled` | `{ workflowId, triggerId?, enabled }`                      | `{ enabled }`                                                                 | escrita                               |
| `workflow_run`         | `{ workflowId, params?, clientRequestId? }`                | `{ runId, status, link }`                                                     | escrita                               |
| `workflow_runs`        | `{ workflowId?, status?, limit? }`                         | execuções recentes, resumidas                                                 | leitura                               |
| `workflow_run_status`  | `{ runId }`                                                | `RunSummary` mais passos e blocos com texto truncado                          | leitura                               |
| `workflow_run_cancel`  | `{ runId }`                                                | `{ status }`                                                                  | escrita, destrutiva                   |
| `workflow_ledger`      | `{ ledger?, workflowId?, limit? }`                         | entradas com veredito e números                                               | leitura                               |

Regras:

- **Mesma validação.** Os handlers chamam `WorkflowDefinitions.save` e `WorkflowEngine.start`, os mesmos métodos das RPCs. A edição de um bot vira commit com autor `<nome do bot> (bot)`.
- **Quem pode.** Qualquer bot que não seja de guest pode ler, rascunhar e validar. Rodar exige o gatilho `bot` do workflow (§5.2). Rodar, cancelar, ativar (o workflow ou um gatilho) e salvar mantendo gatilhos ativos são permitidos quando o dono pediu na própria mensagem nesta conversa ou concedeu `canManageBots`; mensagens de outro bot, tarefas agendadas e passos de workflow não contam. Um workflow novo começa desativado; um save não solicitado sem essa permissão desativa o existente até o dono ativar no app. Bot de guest não recebe estas ferramentas.
- **Sem portão.** Nenhuma ferramenta decide portão. Só a RPC `gate.decide`, com sessão de usuário, decide.
- **Sem autoedição.** Os handlers recusam quem chama de dentro de uma thread de passo (`isWorkflowStepThreadId`). Um workflow não edita, roda nem cancela workflows.
- **Eval.** O texto das ferramentas fala com modelos e precisa de caso em `evals/mcp-tool-use` antes de ir ao ar (AGENTS.md, "Evals"). Hoje o catálogo da eval não inclui toolkits do fork (`evals/mcp-tool-use/run.ts:303`). A fatia 9 inclui os toolkits do fork e casos para "valida com dryRun antes de salvar" e "não tenta aprovar portão".

### 6.1 Workflow que trabalha para um bot

Uma rotina de bot (o heartbeat de hora em hora do Trader, o resumo das 21:00) vira workflow com dois campos:

- `bot: <botId>` no nível de cima diz para quem o workflow trabalha. Os passos `agent` recebem os MCPs de host desse bot pelo mesmo encaminhamento in-process que o bot usa (`HostMcpForward`); o token nunca chega ao passo. Só `agent` recebe: o juiz de `accept`, `hillclimb`, `arena`, `graph` e `interrogate` fazem trabalho de código e não precisam da carteira de ninguém. Um `continue:` e o nudge do JSON herdam o vínculo, porque é a mesma thread.
- `postToBot: true` num `output` de nível de cima posta o `report` renderizado na thread principal atual do bot.

Decisões:

1. **O vínculo vem do journal, nunca de quem chama.** O decisor grava `bot` no intent `StartTurn` dos nós `agent`, a partir da definição fixada na execução. `HostMcpForward.forThread` lê `wf:<runId>:<hash>`, procura o `StartTurn` com essa thread no stream da execução e confere que o bot ainda existe (`apps/server/src/bots/workflows/stepBot.ts`). Thread de passo → execução → versão → bot. Ids de thread `wf:` seguem o mesmo modelo de confiança dos ids `bot:` (só o dono cria thread com id escolhido).
2. **Quem vincula.** Pelo `workflow_save`, um bot só põe o próprio id e não troca nem tira o vínculo de outro bot; o dono, pela UI ou RPC, vincula a qualquer bot que exista. Bot inexistente é diagnóstico `bot` no save e no `dryRun`. O `workflow_list` devolve `you`, o id do bot que chama. Edição à mão não passa por essa regra (é do dono).
3. **Bot apagado.** O passo roda sem MCP de host e a execução grava `RunWarned` (`warn:bot-missing:<id>`), que a tela da execução mostra. O post também vira aviso e não acontece.
4. **O post acorda o bot.** O orquestrador não tem mensagem sem turno: criar uma seria mexer no `Orchestrator` do upstream e nos dois clientes. O post é um `message.dispatch` na fila (`queue_after_active`), com `notification` de sistema, e o bot repassa o report na própria voz, como as rotinas de hoje. Por isso não existe opção "não acordar".
5. **Uma vez por execução e nó.** O intent `PostToBot` tem chave `post:<nó>` e o commandId é `server:workflow-post:<keyHash(runId, chave)>`. Um restart que reexecuta o intent cai no recibo do comando; uma execução reaberta não posta de novo. A thread é resolvida na hora do post (`bot:<id>:<homeGeneration>`), então a rotação de conversa não perde o report.
6. **Sem novidade, sem post.** Report vazio (depois de `trim`) ou `when` falso não postam. Só `output` de nível de cima posta; dentro de `map` ou `loop` seria um post por item, e o compilador recusa.
7. **Sem notificação dupla.** Quando o post acontece, o push "finished" da execução não sai: a resposta do bot já notifica. Sem post (report vazio, bot apagado, falha), o push segue as regras de antes.

Exemplo, o heartbeat do Trader:

```yaml
schema: t3.workflow/v1
id: trader-heartbeat
title: Heartbeat da carteira
home: { project: scratch }
bot: b_0123456789abcdef0123456789abcdef # o id do Trader (`you` no workflow_list)
triggers:
  hourly: { kind: cron, expr: "0 * * * *", tz: America/Sao_Paulo }
budget: { steps: 4, wall: 20m, tokens: 150000 }
fatigue: { consecutiveFailures: 3 }
models:
  lead: { provider: claude, model: claude-haiku-5-5 }
nodes:
  look:
    kind: agent
    model: $lead
    workspace: { project: scratch, readOnly: true }
    prompt: >-
      Leia a carteira com as tools do MCP trader e compare com a última hora.
      Responda em JSON: news é vazio quando nada mudou; senão, de 1 a 3 linhas.
    output: { news: { type: string } }
  done:
    kind: output
    status: no_change
    value: {}
    report: "{{ nodes.look.output.news }}"
    postToBot: true
edges: [look -> done]
```

Os MCPs de host só valem para passos em instância Claude, como para os bots (`docs/friend/bot-host-mcp.md`).

---

## 7. Canvas: escolha com evidência e fronteira

### 7.1 Protótipos

Três apps Vite descartáveis, um por biblioteca, com o mesmo grafo (merge semanal com fan-out e fan-in), a mesma ida e volta grafo → cena → grafo, o mesmo "patch de bot" (insere "interrogate review" e religa as arestas), modo só leitura em 390×844 e pedaço preguiçoso via `React.lazy`. Builds via `heavy.sh`, um por vez. Prints e testes via Playwright headless, porque o preview do T3 não alcança o localhost desta VPS. Tudo está em `prototypes/workflows-canvas/RESULTS.md` no commit `f6ddb26aa`, com os números brutos em `measurements.json` e `evidence.json`.

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
| Estilo desenhado à mão            |                                                                                    nativo |                                                   roughjs nas caixas e arestas (print `shots/reactflow-patch.png`) |                                                                                                                                                                                                                       nativo |
| Edição por script (Playwright)    | arrastar e conectar **falharam** (alvo só em canvas, sem calibrar); erro de seta solta ok | arrastar ok, conectar ok, seta solta impossível ok, nota livre ok; **apagar aresta pelo teclado falhou** no script |                                                                                                                                                           arrastar ok; conectar falhou (sem calibrar); erro de seta solta ok |
| Desenho livre (tinta)             |                                                                                       sim |                                                                                          não; notas e molduras sim |                                                                                                                                                                                                                          sim |

Prints em `prototypes/workflows-canvas/shots/` no commit `f6ddb26aa`: `excalidraw-patch.png`, `reactflow-patch.png`, `tldraw-patch.png`, `reactflow-edited.png` e as versões só leitura `*-readonly.png`.

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

- **Onde mora.** Um repositório git em `~/.t3/workflows/definitions/` no host de bots, com um `<id>.workflow.yaml` por workflow. O host cria o repositório no primeiro uso. Só o motor e o Israel escrevem nele; um passo com shell também consegue, e o que ele gravar entra pela ingestão como edição à mão. Os modelos prontos ficam só leitura em `apps/server/src/bots/workflows/library/`, versionados com o fork; `fromTemplate` copia um deles para o repositório.
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
- **Acompanhar.** Tela da execução com o grafo colorido por status, lista de passos (status, duração, tokens, custo estimado, link para a thread do passo, que abre na tela de thread que já existe e mostra um link de volta para a execução), visão de cada bloco (rodada do hillclimb e melhor resultado; notas da arena; folhas do graph; achados do interrogate) e controles de pausar, retomar, cancelar e repetir passo. Lê `run.subscribe` com deltas.
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
- **Teto do dia de workflows.** `HostLimits.workflowTokensPerDay` (padrão 40M tokens cobráveis) soma todas as execuções de um "dia de workflows", que vira às 12:00 no fuso do host, para que uma noite inteira caia num período só. A medida é a soma do uso dos turnos T3 mais o `tokensFrom` dos comandos; o que um passo gasta fora disso (um `curl` em laço, um subagente do CLI) não entra, porque nenhum ponto vê esse gasto. Passado o teto, o motor para de admitir passos e pausa as execuções vivas com `RunPaused{daily_cap}`; na virada do dia ele retoma o que pausou por esse motivo. `HostLimits.workflowUsdPerDay` é opcional e vem desligado. Os dois são configuráveis no host de bots.
- **Estouro.** O `decide` para de admitir, interrompe turnos e units vivos e termina em `budget_exhausted`. `amendBudget` seguido de `resume` é o caminho de volta.
- **Limite honesto.** O Codex só fecha a contagem do turno no fim (`CodexTurnTokenUsage.ts:96-138`). Um turno longo pode passar da reserva. Os limites duros são o `timeout` do passo e, onde o provider reporta uso acumulado no meio do turno, um vigia que interrompe em duas vezes a reserva. USD é estimativa via `usagePricing` e só vale quando todo passo tem preço; senão a tela diz "custo desconhecido", nunca zero.

### 9.2 Fadiga

- **Na execução.** A dobra conta passos `failed`, `lost`, `timed_out` e medições inválidas seguidas desde o último sucesso. Candidato rejeitado com medição válida não conta. Em N, o `decide` grava `RunPaused{fatigue}` e um `Notify` com chave `notify:fatigue:<runId>:<n da pausa>`: um aviso lógico por pausa. A entrega é pelo menos uma vez, deduplicada no aparelho.
- **No workflow.** N `RunOutcome` falhos seguidos gravam `Suspended`, mandam um push e fazem os gatilhos gravarem `TriggerSkipped{suspended}` até `Unsuspended`.

### 9.3 Um passo pesado por vez

- Comandos nunca rodam na árvore de processos do servidor. `WorkflowUnits.start` (`exec/Units.ts`) cria **uma** unit no gerenciador de usuário do Israel: `systemd-run --user --unit=wf-<k> --collect`. A unit roda o `wfUnit`, que grava `started.json` com fsync, roda o argv no próprio grupo de processos (timeout e parada matam o grupo; descendentes que seguram a saída depois do fim morrem após 2 s) e grava `exit.json` com o código de saída que ele mesmo observou, por rename atômico. `queuedMs = started − spawned`, e espera de lock não conta como execução.
- Com `heavy: true`, a unit leva os limites e o ambiente do `heavy.sh` (`CPUWeight=20`, `IOWeight=20`, `MemoryMax=6G`, `Nice=19`, `TMPDIR`, `CI=1`) e roda `flock /home/israel/.cache/t3-testdata/heavy.lock wfUnit …`: o mesmo lock do `heavy.sh` (`T3CODE_WORKFLOW_HEAVY_LOCK` troca o caminho em teste), pego dentro da mesma unit. O motor não chama o `heavy.sh`, porque ele abre uma segunda unit (`systemd-run --wait`) que sobrevive à primeira: se a de fora morre, o flock é solto enquanto a de dentro continua, e duas cópias rodam. Com o lock na unit, parar a unit mata o lock e o trabalho juntos.
- O lock nunca é aninhado. O compilador recusa `heavy` junto com `selfSerializing` ou com argv que cita `heavy.sh`.
- **Agentes e comandos que chamam `heavy.sh`** (o agente rodando typecheck, o `run.py` do bench por episódio) usam o `heavy.sh` do host, com o mesmo lock.
- **Computer use.** Vale a trava por display do servidor de computer use (`$XDG_RUNTIME_DIR/computer-use-linux/input-<display>.lock`). Ela serializa cada ação de entrada (clique, digitação, tecla) entre servidores, não o passo inteiro: dois passos na tela `:99` intercalam suas ações em vez de esperar um pelo outro. Uma rotina que precisa da tela por um episódio inteiro, como o bench do argo35, se serializa sozinha (fatia 12).
- **Limite.** Um agente que rode `cargo build` sem passar pelo `heavy.sh` não é serializado. O prompt base de passo manda usar `heavy.sh`.
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

### 9.5 Ações protegidas: portão do Israel

Cada passo roda no host como uma thread T3 comum, na instância de provider em que o host roda os bots, com o mesmo acesso deles: a tela `:99`, os MCPs do host, o MCP do T3, os homes do Claude e do Codex e as credenciais do Israel. Não há barreira estrutural. A proteção tem três partes:

1. **Portão do Israel no motor.** Antes de um nó `command`, o `decide` classifica o argv renderizado com `classifyCommand`. Deploy, restart, merge na `friend/main`, force push e mudança no `~/.t3/userdata/settings.json` abrem um portão antes do `StartUnit`. Só a RPC `gate.decide`, com sessão de usuário, decide: nenhuma ferramenta MCP decide portão, e nenhum bot aprova. Rejeitado, o passo falha sem rodar.
2. **Ruleset do GitHub na `friend/main`** (sem force push, PR obrigatório, só o Israel passa). Não será ligado agora: é configuração externa pendente do Israel (§15).
3. **As regras dos bots de hoje.** Os passos carregam a mesma configuração dos bots: os homes do Claude e do Codex do host, com as regras globais de confirmação. O prompt base de passo diz ainda para parar e pedir em vez de fazer deploy, restart, merge, force push ou mexer no `settings.json`. Com `askIsrael`, a pergunta vira portão.

**O portão não é uma barreira.** Ele só vê o argv de nós `command`: um passo com shell consegue contornar o portão (um agente que roda `git push --force`, um script que faz deploy), e o Israel aceitou esse risco em 2026-11-02. Pelo mesmo motivo, `classifyCommand` mira a ação protegida declarada no argv: os casos diretos (`git push --force`, push ou merge na `friend/main`, `systemctl restart t3-friend`, deploy, `npm|pnpm|yarn|vp run deploy|restart`, escrita no `settings.json`) são pegos e testados, e um argv ofuscado (opção que esconde um `-e`, script de pacote atrás de opção, shell aninhado) pode escapar sem que isso conte como defeito, porque falso positivo custa mais que essa precisão.

O que o próprio motor faz continua fechado: a união de intents não tem merge em ref protegida, deploy, restart nem push forçado. O motor só empurra a `WfBranch`, sem força e com o sha gravado no journal, e abre PR em rascunho. "Mergear na `friend/main`" é sempre um `handoff`.

No save, `classifyCommand` recusa o que esconderia do portão o que o comando faz: shell inline (`bash -c`, `node -e`), programa vindo de template, `xargs`, escalada de privilégio (`sudo`, `su`, `doas`, `pkexec`) e agendamento fora da execução (`crontab`, `at`). Pedidos de runtime de um turno (aprovação, pergunta) recebem `AnswerRequest(decline)` ou viram portão com `askIsrael`.

### 9.6 Isolamento: decisão

Até 2026-11-02 este desenho rodava cada passo num container Docker, no molde do sandbox dos bots de guest: rede interna com proxy, credenciais só nos forwarders, placeholder vazio como cwd no host e código entrando e saindo por bundle git. Antes dele, um usuário Unix próprio com `bwrap`. O Israel decidiu rodar no host: as rotinas de RSI precisam da tela `:99` do computer use, dos MCPs do host e do resto, e levar tudo isso para dentro de um container seria refazer o ambiente inteiro. Saíram o container, o proxy e os forwarders, os placeholders, os bundles, o uid 10001, o `wf-run` com handshake, a imagem, a rede, o autoteste, a sentinela, o nó `host` e o 403 do MCP para threads `wf:`. A proteção passou a ser a da §9.5.

## 10. Custo, tokens, painel de métricas e ledger

- **Por passo.** O sensor lê os provider turns da tentativa, mais as continuações de restart. Usa `turnTokenUsage` (`packages/contracts/src/providerRuntime.ts:57`): entrada já inclui cache e saída já inclui reasoning, então não soma de novo. Grava `complete | partial | unavailable`. O USD estimado sai das taxas de `usagePricing` (`apps/server/src/usage/usagePricing.ts:11`). Subagentes nativos não entram no total garantido, e a tela diz isso. Comandos com `tokensFrom` (evals pagos) somam o que imprimem.
- **Painel por workflow** (`metrics`). Execuções por status, duração e custo por execução (série), taxa de falha e tokens médios por nó, e séries das métricas que os comandos emitem (por exemplo `throughput_ratio` noite a noite), com o veredito de cada ponto.
- **Ledger.** Tela própria (web e Android) com filtro por ledger, workflow e veredito: hipótese, barra (hash e texto), antes, depois, sha e link da execução.
- **Kanban.** Opcional, por `card.project`: um ticket local por execução (`UpsertCard`, chave = runId), que aponta para a execução e move a coluna com o status (todo → in_progress → in_review em portão → done). Ele nunca liga thread de passo. Projeto ligado ao Linear é recusado na validação, porque criar ticket nele seria uma mutação externa no Linear (`KanbanService.ts:840`).
- **Avisos.** São três tipos, um aviso por evento, deduplicados pela chave do evento, e nenhum por passo:
  - **precisa de você**: portão aberto, passo esperando resposta, pausa por fadiga ou por orçamento;
  - **execução falhou**;
  - **execução terminou**: pronta para revisão ou sem ganho.

  Construtor puro no padrão de `botPushNotice.ts:110`. Usa o `t3_kind: "bot_message"` que o Android já entrega (`AgentNotifications.kt:23-26`; um tipo novo seria descartado), com `alert_path: /bots/workflows/<env>/runs/<runId>`. Reusa `BotPushDelivery` e os aparelhos registrados.

---

## 11. Biblioteca de workflows prontos

Modelos em `apps/server/src/bots/workflows/library/`; os blocos abaixo são cópia deles, e o teste do codec YAML compila os quatro. Cada um depende de CLIs auxiliares que imprimem JSON. As do t3code existem em `scripts/friend/`, menos `extract-corrections.ts`, que está pendente (por isso o `corrections-quality` não deve ser ativado). As do bench existem só na branch local `feat/wf-bench-cli` do computer-use-linux, então o `argo35-hillclimb` fica como não suportado sem supervisão até elas entrarem no checkout do host. O `upstream-merge` e o `mcp-token-cut` rodaram ponta a ponta num servidor de teste (fatia 12).

| CLI                                                         | Repositório        | Contrato                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/friend/wf/select-upstream-tag.ts`                  | t3code             | `ls-remote` + fetch da tag para `refs/wf/upstream/<tag>` + `is-ancestor` contra a base → `{ tag, tagSha, contained }`                                                                                                                                                                                                                |
| `scripts/friend/merge-upstream.ts --json --into <worktree>` | t3code             | idempotente: tag já mergeada → `merged`; imprime `{ status: merged \| conflicts, conflicts[] }`                                                                                                                                                                                                                                      |
| `scripts/friend/wf/fork-checks.ts --json`                   | t3code             | `check-seams`, `vscode-theme --check` e testes do fork → `{ seams, theme, tests, failures[] }`                                                                                                                                                                                                                                       |
| `bench/agent/argo35_metric.py`                              | computer-use-linux | `--suite argo35-train \| argo35-holdout` (o split congelado de `METRIC.md`); roda `run.py` intercalando base e candidato, valida cobertura (uma linha por variante, tarefa e rep; binários com hash) → `{ complete, baseline, candidate, throughput_ratio, regressed_tasks, errors, tokens }`; sai ≠ 0 só se a comparação é inválida |
| `bench/agent/sol_suites.py`                                 | computer-use-linux | roda `sol-easy`, `sol-hard` e `sol-long` com o binário dado num diretório novo e chama `sol_regression.py` nele; sai ≠ 0 em regressão                                                                                                                                                                                                |
| `scripts/friend/wf/mcp-token-count.ts --json`               | t3code             | inventário servido inteiro, toolkits do fork incluídos → `{ total, perTool, method }` (`chars/4` declarado; tokenizer quando houver)                                                                                                                                                                                                 |
| `scripts/friend/wf/mcp-eval-verdict.ts`                     | t3code             | `pnpm mcp-tool-use` contra baseline fixado → `{ complete, case_regressions, usage }`                                                                                                                                                                                                                                                 |
| `scripts/friend/wf/extract-corrections.ts --out <dir>`      | t3code             | pendente; cópia só leitura das tabelas que precisa do `statev2.sqlite` (nunca `VACUUM INTO` do banco inteiro, de 4,3 GB) e JSONL só com os campos permitidos (correção do Israel, texto anterior do assistente sem saídas de ferramenta, ids de evidência) → `{ count, path }`                                                       |

### 11.1 Merge semanal do upstream

````yaml
schema: t3.workflow/v1
id: upstream-merge
title: Merge do upstream
home: { project: t3code }
params:
  base: { type: string, default: friend/main, pattern: "^[A-Za-z0-9._/-]+$" }
  # A local bare repository works too: the end-to-end test points this at one.
  upstream:
    {
      type: string,
      default: "https://github.com/pingdotgg/t3code",
      pattern: "^(https://[A-Za-z0-9.-]+|)/[A-Za-z0-9._/-]+$",
    }
triggers:
  run: { kind: manual, title: Run now }
  weekly: { kind: cron, expr: "0 7 * * 1", tz: America/Sao_Paulo }
  newtag:
    kind: upstreamTag
    remote: "https://github.com/pingdotgg/t3code"
    pattern: '^v\d+\.\d+\.\d+$'
    pollMinutes: 120
    params: { upstream: "{{trigger.remote}}" }
  ask:
    kind: bot
    title: Pedido de um bot
    description: >-
      Use when the user asks to merge the latest upstream T3 Code release into friend/main.
      Pass `base` only when they name another branch.
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
          "{{params.upstream}}",
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
          --remote,
          "{{params.upstream}}",
          --base,
          "{{params.base}}",
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
      argv: [node, scripts/friend/wf/fork-checks.ts, --json, --no-heavy],
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
      argv: [node, scripts/friend/wf/fork-checks.ts, --json, --no-heavy],
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
  failed_checks:
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
  - recheck:fail -> failed_checks
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
description: >-
  Não suportado sem supervisão: as CLIs do bench (argo35_metric.py, sol_suites.py) ainda não estão
  no checkout do computer-use-linux que o host usa. Não ative até elas entrarem.
home: { project: computer-use-linux }
params:
  {
    reps: { type: number, default: 3 },
    from: { type: string, default: feat/cu-argo35-terra, pattern: "^[A-Za-z0-9._/-]+$" },
  }
triggers:
  run: { kind: manual, title: Run now }
  nightly:
    { kind: cron, expr: "30 1 * * *", tz: America/Sao_Paulo, misfire: { mode: skip, grace: 1h } }
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
        tokenReservation: 1000000
        timeout: 5h
    objective: { expr: "m.bench.candidate.throughput", direction: max }
    keep: >-
      m.bench.complete && m.bench.errors == 0 && len(m.bench.regressed_tasks) == 0
      && m.bench.candidate.success_rate >= m.bench.baseline.success_rate
      && m.bench.throughput_ratio != null && m.bench.throughput_ratio >= 1.05
    confirmWhen: "m.bench.candidate.throughput / origin.bench.candidate.throughput >= 1.5"
    target: >-
      m.bench.complete && m.bench.throughput_ratio != null && m.bench.throughput_ratio >= 1.5
      && len(m.bench.regressed_tasks) == 0
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
    check: "out.complete && out.throughput_ratio != null && out.throughput_ratio >= 1.5 && len(out.regressed_tasks) == 0 && out.candidate.success_rate >= out.baseline.success_rate"
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
  holdout_fail:
    {
      kind: output,
      status: rejected,
      notify: true,
      value: { best: "{{nodes.climb.output.bestBranch}}" },
      report: "Atingiu a barra no treino e falhou no holdout.",
    }
  sol_fail:
    {
      kind: output,
      status: rejected,
      notify: true,
      value: { best: "{{nodes.climb.output.bestBranch}}" },
      report: "Regressão nas suítes Sol.",
    }
  no_gain:
    {
      kind: output,
      status: no_gain,
      value:
        { endedBy: "{{nodes.climb.output.endedBy}}", best: "{{nodes.climb.output.best.reading}}" },
    }
edges:
  - climb:target -> holdout
  - climb:no_gain -> no_gain
  - climb:budget -> no_gain
  - climb:blocked -> no_gain
  - holdout:pass -> sol
  - holdout:fail -> holdout_fail
  - sol:pass -> win
  - sol:fail -> sol_fail
```

Só a saída `win` marca o candidato como `validated` no ledger (`promote`), e só `validated` vira a base da noite seguinte. Uma noite que para no holdout ou no Sol não muda a base. O holdout e o Sol comparam com a origem da noite, que é a última base validada.

`argo35_metric.py` e `sol_suites.py` precisam existir no repositório do CU antes, com o split congelado e o hash dos binários. Esse repositório é o `feat/cu-argo35-terra`, não a checkout em `~/Projects` (`grounding`: o harness só existe nessa branch).

### 11.3 Corte de tokens dos MCPs

```yaml
schema: t3.workflow/v1
id: mcp-token-cut
title: Cortar tokens das definições de ferramentas MCP sem regressão de comportamento
home: { project: t3code }
triggers:
  run: { kind: manual, title: Run now }
  weekly: { kind: cron, expr: "0 2 * * 6", tz: America/Sao_Paulo }
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
    # Attempt worktrees start without node_modules, and both measures import effect.
    build: { argv: [vp, i], cwd: attempt, heavy: true, replay: safe }
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
              "{{coalesce(origin.evals.resultsPath, '')}}",
              --out,
              "{{step.dir}}",
            ],
          cwd: attempt,
          parse: json,
          heavy: true,
          tokensFrom: usage.total_tokens,
          tokenReservation: 500000,
          timeout: 2h,
        }
    objective: { expr: "m.tokens.total", direction: min }
    keep: "m.evals.complete && m.evals.case_regressions == 0 && m.tokens.method == origin.tokens.method && m.tokens.total <= best.tokens.total * 0.97"
    target: "m.evals.complete && m.evals.case_regressions == 0 && m.tokens.total <= origin.tokens.total * 0.7"
    plateau: { rounds: 3 }
    budget: { iterations: 10, wall: 9h, tokens: 7000000 }
  # cut.best is a fresh worktree: the review's check:changed needs node_modules there.
  deps: { kind: command, cwd: cut.best, heavy: true, replay: safe, argv: [vp, i] }
  review:
    kind: interrogate
    target: { workspace: cut.best, baseRef: friend/main }
    intent: "Texto de ferramenta MCP encurtado; confirmar que nenhuma orientação de roteamento ou segurança se perdeu."
    mode: panel
    reviewers: [{ provider: codex, model: gpt-6.1-sol, effort: high }, $lead]
    lead: $lead
    checks: [{ argv: [vp, run, check:changed, friend/main], cwd: cut.best, heavy: true }]
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
  no_gain: { kind: output, status: no_gain, value: { endedBy: "{{nodes.cut.output.endedBy}}" } }
  stuck: { kind: output, status: blocked, notify: true, value: {} }
edges:
  [
    "cut:target -> deps",
    "deps -> review",
    "cut:no_gain -> no_gain",
    "cut:budget -> no_gain",
    "review:approve -> done",
    "review:stuck -> stuck",
  ]
```

A origem mede `tokens` e `evals` contra si mesma, sem baseline (o `coalesce` passa `--baseline` vazio, que a CLI lê como ausente), e é isso que gera `origin.evals.resultsPath`. O `build` roda `vp i` em cada worktree antes das medidas, que importam `effect`. O nó `deps` faz o mesmo na `cut.best`, uma worktree nova, antes do `check:changed` da revisão. O método de contagem (`chars/4` ou tokenizer) fica gravado, e `keep` recusa comparar métodos diferentes.

### 11.4 Qualidade a partir das correções do Israel

```yaml
schema: t3.workflow/v1
id: corrections-quality
title: Correções viram enforcement estrutural
description: >-
  Pendente: a tarefa do host scripts/friend/wf/extract-corrections.ts ainda não existe, então o
  primeiro passo falha. Não ative até ela entrar.
home: { project: t3code }
triggers:
  run: { kind: manual, title: Run now }
  nightly:
    { kind: cron, expr: "0 3 * * *", tz: America/Sao_Paulo, misfire: { mode: skip, grace: 1h } }
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
  extract:
    {
      kind: command,
      cwd: { project: t3code, readOnly: true },
      heavy: true,
      replay: safe,
      parse: json,
      argv: [node, scripts/friend/wf/extract-corrections.ts, --out, "{{step.dir}}"],
      output: { count: { type: number }, path: { type: string } },
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
            finalChecks:
              [
                {
                  argv: [vp, run, check:changed, friend/main],
                  cwd: build.integration,
                  heavy: true,
                },
              ],
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

O snapshot é pesado (o `statev2.sqlite` tem vários GB), então o `extract` roda com `heavy`. Ele só lê a fonte e entrega uma cópia redigida. O texto das correções não é confiável: entra emoldurado nos prompts e nunca em argv. Mudança em skill ou regra global fica como proposta, como o `reflect` já exige.

---

## 12. Lista de seams

Nove arquivos do upstream. Oito já são seams hoje (`scripts/friend/seams.ts`; o `packages/shared/package.json` entrou na fatia 1) e um é novo. Os arquivos novos do fork não são seams: os prefixos novos entram em `FORK_OWNED_PREFIXES` (`seams.ts:542`), que é do fork.

| Arquivo                                                                        | Já é seam?                      | Mudança                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Por que não dá para ficar no fork                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/scheduledTasks/ScheduledTaskService.ts`                       | sim (2 → 5)                     | 1) Na construção da camada (`:398-408`): `Effect.serviceOption(WorkflowTriggerHook)`. 2) No despacho (`:816-857`): task com id `wf-hook:` vai para `hook.fire({ taskId, deliveryId, prompt })`; fora de um disparo de webhook (`runNow`, agendado) a task falha com "task de workflow só dispara por webhook"; sem o gancho, falha com "motor de workflows indisponível" e **nunca** cai no lançamento comum. 3) Um `hook.guard(taskId)` no começo de `upsert`, `delete`, `setEnabled`, `runNow` e `rotateWebhookToken`, que recusa `wf-hook:` fora do escopo do motor (`WorkflowEngineCaller` no contexto do Effect) | É o único ponto onde todos os caminhos de disparo se juntam (`ScheduledTaskService.ts:816-857`). Sem o guard, a task que carrega o webhook poderia ser editada, desligada ou apagada pela tela de tarefas ou por `delete_scheduled_task`. O `layerCore` já fica abaixo do runtime (`server.ts:527-547`), então `runtimeLayer.ts` não muda |
| `apps/server/src/mcp/McpHttpServer.ts`                                         | sim (4)                         | Registrar `WorkflowToolkit` no hunk dos toolkits do fork (`:1174`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Registro de toolkit é do upstream                                                                                                                                                                                                                                                                                                         |
| `packages/client-runtime/src/rpc/client.ts`                                    | sim (2)                         | Três tags de stream em `EnvironmentSubscriptionRpcTag`, dentro do hunk existente                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A união de streams é explícita                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/routeTree.gen.ts`                                                | sim (contains)                  | Entradas geradas para `_chat.workflows*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Arquivo gerado                                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/components/sidebar/mainAppLocation.ts`                           | sim (1)                         | `/workflows` entra na cláusula de páginas utilitárias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Volta para o chat                                                                                                                                                                                                                                                                                                                         |
| `apps/mobile/src/Stack.tsx`                                                    | sim                             | Rotas `bots/workflows/…`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Registro do Stack é do upstream                                                                                                                                                                                                                                                                                                           |
| `apps/mobile/modules/t3-agent-notifications/android/.../AgentNotifications.kt` | sim (2 → 3)                     | Aceitar caminho de toque `/bots/workflows/` além de `/threads/` (`:362`). Os pushes de workflow usam o `t3_kind: "bot_message"` que o receptor já entrega (`:23-26`), então o tipo não muda                                                                                                                                                                                                                                                                                                                                                                                                                           | Lista de caminhos no código nativo                                                                                                                                                                                                                                                                                                        |
| `packages/shared/package.json`                                                 | sim, desde a fatia 1 (contains) | Export `./workflows` para `src/workflows/` (compilador, expressões, `classifyCommand`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | O AGENTS.md reserva `packages/contracts` para schemas; lógica de runtime compartilhada mora em `packages/shared`, que só expõe subpaths declarados                                                                                                                                                                                        |
| `evals/mcp-tool-use/run.ts`                                                    | **não, nova** (1)               | Incluir os toolkits do fork no catálogo da eval (`:303`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Sem isso, nenhuma ferramenta do fork tem eval, nem as de hoje                                                                                                                                                                                                                                                                             |

Sem mudança em `runtimeLayer.ts`, `ws.ts`, `rpc.ts`, `RpcAuthorization.ts`, `ServerEnvironment.ts`, `GitWorkflowService`, nos adapters de provider, no `ProviderSessionManager` ou no `ThreadLaunchService`. Com os passos no host, saíram as mudanças que só existiam pelo container: o 403 do MCP para threads `wf:` no `McpHttpServer.ts:239`, o `isWorkflowLauncher` e as instâncias de workflow. O spread de `BOTS_RPCS`, os spreads de escopo e a capability `bots` já levam tudo. A entrada na barra lateral do web fica no rodapé, ao lado do Kanban (`WorkflowsSidebarItem`, do fork, pela seam já existente em `SidebarChrome.tsx`), para aparecer em todo layout e sem nenhum bot. Prefixos do fork em `FORK_OWNED_PREFIXES`: `packages/contracts/src/workflows.`, `packages/shared/src/workflows/` e `docs/friend/` (da fatia 1); `packages/client-runtime/src/workflows.` e `apps/web/src/routes/_chat.workflows` entram com as fatias 9 e 10.

---

## 13. Plano de entrega

Fatias verificáveis, todas no escopo completo e sem fase "depois". P = até um dia, M = dois a quatro dias, G = uma semana ou mais. "/graph" marca fatia que roda como lead Opus com folhas Sol (`gpt-6.1-sol` @low), cada folha com conjunto de escrita exclusivo. Builds e testes pesados sempre via `heavy.sh`, um por vez.

| #   | Fatia                                                                                                                                                                                                                                                            | Esforço | Depende de | Check de aceitação                                                                                                                                                                                                                                                                                                                                                                                                             | Paralelo                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | Contrato e compilador: schemas em `packages/contracts/src/workflows.ts`, compilador em `packages/shared/src/workflows/` (schema, expressões, templates, grafo, contaminação, regra de thread contínua, `classifyCommand`, família de modelo)                     | M       | —          | Tabela de testes do compilador: os quatro modelos da §11 compilam; cada `DiagnosticCode` tem um caso que falha; YAML canônico ida e volta com o mesmo hash                                                                                                                                                                                                                                                                     | /graph: folhas expressões · grafo · lint                   |
| 2   | Núcleo do motor: migração 014, `Journal`, dobra, `decide` dos primitivos (com o portão do Israel antes de comando protegido), decisor do workflow (promoção de `TriggerFired`), `RunActor` com interpretador falso                                               | G       | 1          | Testes por tabela `(prefixo do journal) → intents`, uma linha por janela da §3.4; append com chave repetida não grava e devolve o existente; `TriggerFired` órfão vira execução uma vez só; comando protegido só ganha `StartUnit` depois do portão aprovado                                                                                                                                                                   | —                                                          |
| 3   | Interpretador real no host: worktrees git (preparar, avançar com CAS, mergear, remover), `ThreadLaunchService` na instância dos bots, `sendToThread`, sensor com `waitForThread`, `CommandRunner` (unit única, `wfUnit`, recibos, flock do `heavy.lock` na unit) | G       | 2          | Teste de integração com o provider `Replay (dev)`: execução de dois passos; o servidor de dev desta worktree morre no meio do passo 1 (PID capturado) e volta; a execução termina com **uma** thread por chave e **uma** unit por chave; matar a unit depois de `started.json` com `replay: never` deixa o passo `ambiguous`; `GitOp advance` com `from` desatualizado é recusado, e repetido depois de feito conta como feito | —                                                          |
| 4   | Removida em 2026-11-02: os passos rodam no host (§9.6). O que sobrava dela (portão do Israel, instância dos bots, lock na unit, trava por display) entrou nas fatias 2 e 3                                                                                       | —       | —          | —                                                                                                                                                                                                                                                                                                                                                                                                                              | —                                                          |
| 5   | Definições: repositório git, save/validate/history, ingestão de edição à mão, watcher, `workflow_versions`, conflito por revisão do arquivo, modelos prontos                                                                                                     | M       | 1          | Save → commit com YAML canônico; edição à mão válida sem commit → vira commit e `document.subscribe` emite; edição à mão inválida → save de canvas recebe `Conflict` com o arquivo sujo e nada é sobrescrito; duas edições só de layout → `Conflict`; arquivo inválido → gatilho grava `TriggerSkipped{invalid}`                                                                                                               | paralelo a 4                                               |
| 6   | Gatilhos: cron com fuso, webhook (seam da STS com gancho e guard, `coalesceKey`, reconciliação no tick), manual, bot, tag do upstream, PR mergeado (`linked` e `repo`), thread terminou, rotina falhou com profundidade causal                                   | G       | 2, 5       | Teste de ocorrência por gatilho (chave única, fuso com horário de verão, misfire); teste da seam: task `wf-hook:` vai para o gancho, task comum segue igual, `runNow` e `delete` de task `wf-hook:` são recusados fora do motor; entrega de webhook aceita sobrevive a crash antes do despacho; task apagada por fora volta no tick seguinte; `check-seams` ok                                                                 | /graph: folhas por fonte de evento                         |
| 7   | Blocos: hillclimb, arena, graph, interrogate e suas visões                                                                                                                                                                                                       | G       | 3          | Por bloco, tabela de testes do sub-decisor: chave e árvore duplicadas recusadas, platô termina `no_gain`, barra só na confirmação contra a origem, `ledgerBest` só devolve `validated`; juiz da mesma família recusado; folha fora de `owns` rejeitada e dependente partindo do sha integrado; troca de acesso abre thread nova; rodada de interrogate com thread nova e sem aprovação por timeout                             | /graph: uma folha por bloco                                |
| 8   | Proteções e avisos: reservas (turnos e comandos pagos), tokens cobráveis, vigia, tempo ativo, fadiga, push, cartão do kanban, PR pelo motor                                                                                                                      | M       | 3          | Mapas concorrentes não passam do saldo; uso desconhecido é cobrado pela reserva; espera em portão não conta no `wall`; fadiga avisa uma vez por pausa; `OpenPullRequest` repetido acha o PR existente; projeto ligado ao Linear recusado; padrões de orçamento medidos com turnos reais de uma cópia do `statev2.sqlite` (`vp run migrate-dev-db`)                                                                             | —                                                          |
| 9   | RPC e MCP: grupo `bots.workflows.*`, `WorkflowToolkit`, permissões, deltas de execução, eval                                                                                                                                                                     | M       | 2, 5       | Testes de permissão das RPCs (portão só com sessão de usuário); handler recusa thread de passo; casos de eval "valida com dryRun antes de salvar" e "não tenta aprovar portão" falhando antes do texto final e passando depois                                                                                                                                                                                                 | —                                                          |
| 10  | Web e desktop: lista, editor (adaptador React Flow + roughjs, Inspector, aba Fonte, merge), tela da execução, painel de métricas, ledger                                                                                                                         | G       | 1, 9       | Testes de browser do adaptador (ida e volta, nota preservada, aresta apagada por teclado e por menu, banner de conflito); passada única com `test-t3-app` com o Israel autorizando                                                                                                                                                                                                                                             | /graph: folhas adaptador · Inspector · execução · métricas |
| 11  | Android: lista, detalhe com grafo SVG, rodar, execução, portão, edição leve, métricas, push                                                                                                                                                                      | M       | 9          | Passada com `test-t3-mobile`: o push de portão **chega** como notificação e o toque abre a execução; aprovar no celular avança a execução no servidor; edição leve inválida mostra erro local                                                                                                                                                                                                                                  | paralelo a 10                                              |
| 12  | Biblioteca: as CLIs da §11 e os quatro modelos                                                                                                                                                                                                                   | G       | 3, 7, 8    | Contrato JSON de cada CLI testado; primeira execução real do `upstream-merge` numa tag conhecida termina com a branch `wf/` **no GitHub** (sha conferido com `git ls-remote`) e PR em rascunho, com a `friend/main` intacta (`git ls-remote` antes e depois); o bench do argo35 roda um episódio inteiro no host, com a trava por display do computer use, senão o modelo fica marcado como não suportado sem supervisão       | /graph: uma folha por rotina                               |
| 13  | Documentação: seção no `FORK.md`, guia do usuário, `seams.ts`                                                                                                                                                                                                    | P       | todas      | `node scripts/friend/check-seams.ts` ok; o `FORK.md` descreve onde moram os workflows, a execução no host e o portão do Israel                                                                                                                                                                                                                                                                                                 | —                                                          |

Caminho crítico: 1 → 2 → 3 → 7 → 12. A fatia 5 anda em paralelo a 2 e 3 (só depende de 1), assim como 6 e 8, e 10 e 11, sempre com um build pesado por vez na VPS.

Ativar em produção é deploy e pede o ok do Israel na hora, fora deste plano: reiniciar o `t3-friend` com a migração 014 no `bots.sqlite` real, criar o repositório de definições em `~/.t3/workflows/definitions` e ligar o primeiro gatilho. Não há imagem, rede, proxy, volume nem instância nova de provider.

---

## 14. Riscos

1. **Sem barreira estrutural.** Um passo roda como o Israel, com as credenciais dele, a tela `:99` e os MCPs do host. O portão só vê nós `command`: um agente ou um script consegue contornar o portão e fazer deploy, push forçado ou apagar arquivos. O Israel aceitou o risco (§9.5). O ruleset do GitHub cobriria a `friend/main`, mas está pendente (§15).
2. **Prompt injection** vinda de webhook, PR ou correções. Defesas: moldura de não confiável e a regra de contaminação para argv. Um passo injetado age com o acesso do Israel.
3. **Execuções compartilham o disco.** Um passo consegue mexer em worktrees de outra execução e em qualquer arquivo do Israel. O motor confia só no journal (shas gravados, checks dele, recibos), mas um PR pode sair com conteúdo sabotado, e só a revisão pega.
4. **Trabalho pesado do agente fora do `heavy.sh`** não entra na fila.
5. **Computer use disputado.** Os passos que pedem a tela `:99` esperam pela trava por display, e uma execução noturna longa segura a tela. A fatia 12 prova um episódio do bench no host.
6. **Orçamento de tokens.** Pode passar pelo tamanho dos turnos em voo. O `timeout` é o limite duro. O teto do dia (§9.1) não vê gasto fora dos turnos T3 e do `tokensFrom`.
7. **Dois bancos sem transação comum.** As chaves cobrem o lado do upstream. Queda de energia pode perder as últimas transações (`synchronous = NORMAL`), e um passo pode ser refeito ou ficar `ambiguous`.
8. **Merge do upstream mexendo no despacho da STS.** O `check-seams` pega a perda do hunk, e o teste da fatia 6 pega mudança de comportamento.
9. **Latência do webhook.** O `coalesceKey` durável soma até 10 s. Serve para rotinas, não para webhook interativo.
10. **Canvas.** Apagar aresta pelo teclado não foi provado no protótipo. Também não há tinta livre, que o Excalidraw teria.
11. **Custo à noite.** Turnos de Opus e evals pagos. O painel mostra custo por noite, e os padrões de orçamento saem de turnos reais (fatia 8).

---

## 15. Perguntas decididas

1. **Repositório de definições:** git local em `~/.t3/workflows/definitions`, sem remote. Decidido em 2026-11-02: as definições ficam no host de bots, junto do motor que as lê, e o histórico do git já dá revisão e volta.
2. **Ruleset do GitHub na `friend/main`** (sem force push, PR obrigatório, só o Israel passa): não será ligado agora. Fica como configuração externa pendente do Israel. Sem ele, nada barra um passo com shell que empurre na `friend/main` (§9.5).
3. **Padrões da madrugada:**
   - misfire padrão `latest` com graça de 1 h: a rotina que perdeu a janela roda se o servidor voltou em até 1 h, e senão pula para a próxima ocorrência. Configurável por gatilho (`misfire`), com o padrão em `HostLimits`;
   - teto por noite: `HostLimits.workflowTokensPerDay` = 40M tokens cobráveis somando todas as execuções, com o dia de workflows virando às 12:00 no fuso do host. `workflowUsdPerDay` é opcional e vem desligado. Sem proxy, a medida é a soma do uso dos turnos T3 mais o `tokensFrom` dos comandos (§9.1).

---

## Apêndice A. Como este desenho foi feito

As rodadas abaixo revisaram as versões com `bwrap` e com Docker. A troca para o host, depois delas, está na §9.6.

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
