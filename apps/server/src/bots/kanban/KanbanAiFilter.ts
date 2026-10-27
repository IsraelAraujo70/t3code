/**
 * Turns a sentence ("my urgent bugs in progress") into kanban filter clauses with a small model
 * through the server's OpenRouter key, the same key dictation uses. The answer is decoded as
 * `KanbanFilterClause`s; nothing the model says reaches the board unchecked.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  KANBAN_DATE_FILTER_FIELDS,
  KANBAN_FLAG_FILTER_FIELDS,
  KANBAN_LIMITS,
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_OWNER_PERSON_ID,
  KANBAN_SET_FILTER_FIELDS,
  KanbanError,
  KanbanFilterClause,
  kanbanBotPersonId,
  linearWorkspaceId,
  LOCAL_KANBAN_WORKSPACE_ID,
  type KanbanAiFilterInput,
  type KanbanAiFilterResult,
  type KanbanSnapshot,
  type ProjectId,
} from "@t3tools/contracts";

import { DICTATION_KEY_ENV } from "../dictation/Dictation.ts";
import { BotsStore } from "../BotsStore.ts";
import { KanbanService } from "./KanbanService.ts";

export const KANBAN_AI_FILTER_MODEL_ENV = "T3CODE_KANBAN_AI_FILTER_MODEL";
export const DEFAULT_KANBAN_AI_FILTER_MODEL = "anthropic/claude-haiku-5.5";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const unusable = () => new KanbanError({ message: "Could not turn that into filters." });

/**
 * The system prompt: clause shapes, value encodings, and the catalog (states, people, labels…) of
 * the board scope (`projectId` null = every project). Tickets themselves are never sent.
 */
export function buildAiFilterPrompt(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  todayIso: string,
  botNames: ReadonlyMap<string, string>,
): string {
  const inScope = (id: ProjectId) => projectId === null || id === projectId;
  const links = snapshot.links.filter((link) => inScope(link.projectId));
  const teams = new Set(links.map((link) => link.teamId));
  const accounts = snapshot.accounts.filter(
    (account) => projectId === null || links.some((link) => link.accountId === account.id),
  );
  const organizations = new Set(accounts.map((account) => account.organizationId));
  const workspaceIds = new Set<string>([
    LOCAL_KANBAN_WORKSPACE_ID,
    ...[...organizations].map(linearWorkspaceId),
  ]);
  const workspaces = snapshot.workspaces.filter(
    (workspace) => projectId === null || workspaceIds.has(workspace.id),
  );
  const linearProjects = snapshot.linearProjects.filter(
    (project) => projectId === null || organizations.has(project.organizationId),
  );
  const linearProjectIds = new Set(linearProjects.map((project) => project.id));
  const botIds = new Set<string>([
    ...workspaces.flatMap((workspace) => workspace.botIds),
    ...snapshot.tickets.flatMap((ticket) =>
      inScope(ticket.projectId) && ticket.botId !== null ? [ticket.botId] : [],
    ),
  ]);
  const bots = [...botIds].map((id) => ({ id, name: botNames.get(id) ?? id }));
  const catalog = {
    states: snapshot.states
      .filter((state) => projectId === null || teams.has(state.teamId))
      .map(({ id, name, type }) => ({ id, name, type })),
    localStates: KANBAN_LOCAL_STATE_LABELS,
    people: [
      { id: KANBAN_OWNER_PERSON_ID, name: "the T3 user (local tickets)" },
      ...snapshot.people
        .filter((person) => projectId === null || organizations.has(person.organizationId))
        .map(({ id, name, displayName }) => ({ id, name, displayName })),
      ...bots.map((bot) => ({ id: kanbanBotPersonId(bot.id), name: `${bot.name} (bot)` })),
    ],
    labels: snapshot.labels
      .filter(
        (label) =>
          projectId === null ||
          (workspaceIds.has(label.workspaceId) &&
            (label.teamId === null || teams.has(label.teamId))),
      )
      .map(({ id, name }) => ({ id, name })),
    projects: linearProjects.map(({ id, name }) => ({ id, name })),
    milestones: snapshot.milestones
      .filter((milestone) => projectId === null || linearProjectIds.has(milestone.projectId))
      .map(({ id, name }) => ({ id, name })),
    cycles: snapshot.cycles
      .filter((cycle) => projectId === null || teams.has(cycle.teamId))
      .map(({ id, number, name, startsAt, endsAt }) => ({
        id,
        name: name ?? `Cycle ${number}`,
        startsAt: startsAt.slice(0, 10),
        endsAt: endsAt.slice(0, 10),
      })),
    bots,
    workspaces: workspaces.map(({ id, name }) => ({ id, name })),
    accounts: accounts.map(({ id, name }) => ({ id, name })),
    t3Projects:
      projectId === null
        ? [...new Set(snapshot.tickets.map((ticket) => ticket.projectId))]
        : [projectId],
  };
  return [
    `You turn a request about Kanban tickets into filters. Today is ${todayIso}. A ticket must match every clause.`,
    `Reply with JSON only: {"filters":[clause,...]}. Clause kinds:`,
    `- {"kind":"set","field":F,"op":"in"|"notIn","values":[string,...]} (at most ${KANBAN_LIMITS.filterValues} values), F one of ${KANBAN_SET_FILTER_FIELDS.join(", ")}.`,
    `- {"kind":"date","field":F,"op":"before"|"after"|"pastDays"|"nextDays"|"isSet"|"isEmpty","value":V}, F one of ${KANBAN_DATE_FILTER_FIELDS.join(", ")}. V is "YYYY-MM-DD" for before/after, a number of days for pastDays/nextDays, null for isSet/isEmpty. closedAt is when it was completed.`,
    `- {"kind":"flag","field":F,"value":true|false}, F one of ${KANBAN_FLAG_FILTER_FIELDS.join(", ")}.`,
    `- {"kind":"text","field":"content","value":string} matches identifier, title and label names (at most 200 characters).`,
    "Set values:",
    "- status: a state id, or a localStates key. statusType: triage, backlog, unstarted, started, completed, canceled, duplicate.",
    `- assignee, creator: a people id, "me" (the user), or "none" (nobody).`,
    `- priority: "0" No priority, "1" Urgent, "2" High, "3" Medium, "4" Low.`,
    `- label, project, milestone: catalog ids, or "none". cycle: a cycle id, "current" (running today), or "none".`,
    `- bot: a bot id (the ticket's responsible bot). workspace: a workspace id. account: an account id, or "local" (not synced). t3Project: a t3Projects id.`,
    `- threadStatus (any linked thread): approval (needs approval), input (waits for an answer), failed, working, settled, or "none" (no thread).`,
    `- pullRequest: open, draft, merged, closed, or "none" (no pull request).`,
    "Use only ids from the catalog. Leave out what the request does not ask for.",
    `Catalog: ${encodeCatalog(catalog)}`,
  ].join("\n");
}

const AnswerJson = Schema.fromJsonString(Schema.Struct({ filters: Schema.Array(Schema.Unknown) }));
const decodeAnswer = Schema.decodeUnknownOption(AnswerJson);
const decodeClause = Schema.decodeUnknownOption(KanbanFilterClause);
const FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Reads the model's `{"filters":[...]}`, alone or in a ```json fence. Each clause is decoded on
 * its own and invalid ones are dropped; fails when none is left.
 */
export function parseAiFilterAnswer(
  text: string,
): Effect.Effect<KanbanAiFilterResult, KanbanError> {
  const json = (FENCE.exec(text)?.[1] ?? text).trim();
  const answer = decodeAnswer(json);
  const filters = Option.isNone(answer)
    ? []
    : answer.value.filters
        .flatMap((clause) => Option.toArray(decodeClause(clause)))
        .slice(0, KANBAN_LIMITS.filterClauses);
  return filters.length === 0 ? Effect.fail(unusable()) : Effect.succeed({ filters });
}

const readKey: Effect.Effect<Option.Option<Redacted.Redacted>> = Config.Redacted(
  DICTATION_KEY_ENV,
).pipe(
  Config.option,
  Effect.map(Option.filter((key) => Redacted.value(key).trim().length > 0)),
  Effect.orElseSucceed(() => Option.none()),
);

const readModel: Effect.Effect<string> = Config.String(KANBAN_AI_FILTER_MODEL_ENV).pipe(
  Config.withDefault(DEFAULT_KANBAN_AI_FILTER_MODEL),
  Effect.map((model) => model.trim() || DEFAULT_KANBAN_AI_FILTER_MODEL),
  Effect.orElseSucceed(() => DEFAULT_KANBAN_AI_FILTER_MODEL),
);

const ChatResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(
              Schema.NullOr(
                Schema.Union([
                  Schema.String,
                  Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
                ]),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

export class KanbanAiFilter extends Context.Service<
  KanbanAiFilter,
  {
    readonly filter: (
      input: KanbanAiFilterInput,
    ) => Effect.Effect<KanbanAiFilterResult, KanbanError>;
  }
>()("t3/bots/kanban/KanbanAiFilter") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const kanban = yield* KanbanService;
  const store = yield* BotsStore;

  const filter = Effect.fn("KanbanAiFilter.filter")(function* (input: KanbanAiFilterInput) {
    const key = yield* readKey;
    if (Option.isNone(key)) {
      return yield* new KanbanError({
        message: `The AI filter needs ${DICTATION_KEY_ENV} on the server.`,
      });
    }
    const snapshot = yield* kanban.readSnapshot;
    const bots = yield* store.listBots.pipe(
      Effect.mapError((cause) => new KanbanError({ message: "Could not read the bots.", cause })),
    );
    const prompt = buildAiFilterPrompt(
      snapshot,
      input.projectId,
      DateTime.formatIsoDateUtc(yield* DateTime.now),
      new Map(bots.map((bot) => [bot.id, bot.name])),
    );
    const response = yield* HttpClientRequest.post(ENDPOINT).pipe(
      HttpClientRequest.bearerToken(Redacted.value(key.value)),
      HttpClientRequest.bodyJson({
        model: yield* readModel,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: input.text },
        ],
      }),
      Effect.flatMap((request) => httpClient.execute(request)),
      Effect.timeout("30 seconds"),
      Effect.mapError(
        (cause) => new KanbanError({ message: "Could not reach the AI filter service.", cause }),
      ),
    );
    const decoded = yield* HttpClientResponse.schemaBodyJson(ChatResponse)(response).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (response.status < 200 || response.status >= 300 || decoded === null || decoded.error) {
      const detail = decoded?.error?.message ?? `HTTP ${response.status}`;
      return yield* new KanbanError({ message: `The AI filter service failed: ${detail}` });
    }
    const content = decoded.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : (content ?? []).map((part) => part.text ?? "").join("");
    return yield* parseAiFilterAnswer(text);
  });

  return KanbanAiFilter.of({ filter });
});

export const layerLive = Layer.effect(KanbanAiFilter, make);
