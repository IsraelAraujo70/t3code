// @effect-diagnostics globalDateInEffect:off deterministicKeys:off - Poll accepts explicit Date watermarks; the service key follows the workflow trigger contract.
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Journal } from "../Journal.ts";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import { forkParked } from "../../../serverActivation.ts";
import { WorkflowEngine } from "../WorkflowEngine.ts";
import { getCursor, setCursor, deleteCursor } from "./cursors.ts";
import { listTriggerTargets, type TriggerTarget } from "./targets.ts";
import { fireTrigger } from "./fire.ts";
import {
  cronDecision,
  misfirePolicy,
  latestTag,
  occurrenceKey,
  settledMatches,
} from "./occurrence.ts";

const decodePulls = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        title: Schema.String,
        html_url: Schema.String,
        merged_at: Schema.NullOr(Schema.String),
        merge_commit_sha: Schema.NullOr(Schema.String),
        base: Schema.Struct({ ref: Schema.String }),
      }),
    ),
  ),
);

const FOLLOWED_EVENT_TYPES = ["thread.settled", "thread.pull-request-link-updated"] as const;
type FollowedEventType = (typeof FOLLOWED_EVENT_TYPES)[number];

export const make = Effect.fn("WorkflowTriggers.make")(function* (
  options: {
    readonly engine?: Pick<WorkflowEngine["Service"], "start">;
    readonly listPulls?: (repo: string) => Effect.Effect<string, Error>;
    readonly listTags?: (remote: string) => Effect.Effect<string, Error>;
  } = {},
) {
  const orchestrator = yield* Effect.serviceOption(OrchestratorV2);
  // The production runtime exposes the event store (not the sink): it sets where a follower starts.
  const eventStore = yield* Effect.serviceOption(OrchestrationEventStore.OrchestrationEventStore);
  const provided = yield* Effect.serviceOption(WorkflowEngine);
  const engine = options.engine ? Option.some(options.engine) : provided;
  const context = yield* Effect.context<SqlClient.SqlClient | Journal>();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fireEvent = Effect.fnUntraced(function* (stored: OrchestrationV2StoredEvent) {
    if (Option.isNone(engine)) return;
    const event = stored.event;
    for (const target of yield* listTriggerTargets) {
      if (!target.enabled) continue;
      const trigger = target.trigger;
      if (event.type === "thread.settled" && trigger.kind === "threadSettled") {
        const thread = event.payload;
        const payload = { threadId: thread.id, projectId: thread.projectId, title: thread.title };
        const filters = {
          ...(trigger.projectId === undefined ? {} : { projectId: trigger.projectId }),
          ...(trigger.botId === undefined ? {} : { botId: trigger.botId }),
          ...(trigger.titlePrefix === undefined ? {} : { titlePrefix: trigger.titlePrefix }),
        };
        if (!settledMatches(filters, { ...payload, lineage: thread.lineage })) continue;
        yield* fireTrigger(engine.value, target, {
          kind: "threadSettled",
          occurrence: occurrenceKey.settled(thread.id, stored.sequence),
          label: `thread settled: ${thread.title.slice(0, 80)}`,
          payload,
        });
      }
      if (
        event.type === "thread.pull-request-link-updated" &&
        trigger.kind === "prMerged" &&
        trigger.scope === "linked"
      ) {
        const link = event.payload;
        if (
          link.repository !== trigger.repo ||
          link.snapshot?.state !== "merged" ||
          (trigger.base && link.snapshot.baseBranch !== trigger.base)
        )
          continue;
        const headSha = link.watch?.headSha ?? null;
        yield* fireTrigger(engine.value, target, {
          kind: "prMerged",
          occurrence: occurrenceKey.prMerged(link.repository, link.number, headSha ?? "merged"),
          label: `PR #${link.number} merged`,
          payload: {
            repo: link.repository,
            number: link.number,
            title: link.snapshot.title,
            url: link.url,
            mergeSha: headSha,
          },
        });
      }
    }
  });

  /**
   * Follows one event type from its cursor, live: the stored-event stream keeps going after the
   * replay, so this runs until it fails. A failed start stops it before its cursor moves, and the
   * caller starts it again; the occurrence keys make the replayed fires no-ops.
   */
  const followEvents = Effect.fn("WorkflowTriggers.followEvents")(function* (
    eventType: FollowedEventType,
  ) {
    if (Option.isNone(engine) || Option.isNone(orchestrator)) return;
    const source = `events:${eventType}`;
    const stored = yield* getCursor(source);
    let after: number;
    if (Option.isSome(stored)) after = Number(stored.value);
    else {
      // Nothing from before the sources first started fires: begin at the newest event, and
      // never at 0 for want of a way to find it.
      if (Option.isNone(eventStore)) {
        return yield* Effect.logWarning("workflow event triggers: no event store, not following", {
          eventType,
        });
      }
      after = yield* eventStore.value.latestAgentSequence();
      yield* setCursor(source, String(after));
    }
    yield* orchestrator.value
      .streamStoredEventsFrom({ eventType, afterSequence: after })
      .pipe(
        Stream.runForEach((stored) =>
          fireEvent(stored).pipe(Effect.andThen(setCursor(source, String(stored.sequence)))),
        ),
      );
  }, Effect.provideContext(context));

  const poll = Effect.fn("WorkflowTriggers.poll")(function* (now: Date) {
    if (Option.isNone(engine)) return;
    const targets = yield* listTriggerTargets;
    for (const target of targets) {
      // One trigger's failure (the engine, git, the database) leaves its cursor and the others alone.
      yield* pollTarget(target, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow trigger poll failed", {
            workflowId: target.workflowId,
            triggerId: target.trigger.id,
            cause,
          }),
        ),
      );
    }
  }, Effect.provideContext(context));
  const pollTarget = Effect.fnUntraced(function* (target: TriggerTarget, now: Date) {
    if (Option.isNone(engine)) return;
    {
      const trigger = target.trigger;
      if (trigger.kind === "prMerged" && trigger.scope === "repo") {
        const source = `pr:${target.workflowId}:${trigger.id}`;
        if (!target.enabled) {
          yield* deleteCursor(source);
          return;
        }
        const cursor = yield* getCursor(source);
        const previous = Option.isSome(cursor) ? cursor.value.split("|") : null;
        if (previous && now.getTime() - Date.parse(previous[0] ?? "") < 600000) return;
        const output = yield* (
          options.listPulls
            ? options.listPulls(trigger.repo)
            : spawner.string(
                ChildProcess.make("gh", [
                  "api",
                  `repos/${trigger.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
                ]),
              )
        ).pipe(Effect.timeout("60 seconds"));
        const pulls = yield* decodePulls(output);
        let latest = previous?.[1] ?? "";
        for (const pr of pulls
          .filter((pr) => pr.merged_at && (!trigger.base || pr.base.ref === trigger.base))
          .sort((a, b) => (a.merged_at ?? "").localeCompare(b.merged_at ?? ""))) {
          if (!pr.merged_at) continue;
          if (previous && pr.merged_at > (previous[1] ?? ""))
            yield* fireTrigger(engine.value, target, {
              kind: "prMerged",
              occurrence: occurrenceKey.prMerged(
                trigger.repo,
                pr.number,
                pr.merge_commit_sha ?? "merged",
              ),
              label: `PR #${pr.number} merged`,
              payload: {
                repo: trigger.repo,
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                mergeSha: pr.merge_commit_sha,
              },
            });
          if (pr.merged_at > latest) latest = pr.merged_at;
        }
        yield* setCursor(source, `${now.toISOString()}|${latest || now.toISOString()}`);
        return;
      }
      if (trigger.kind !== "cron" && trigger.kind !== "upstreamTag") return;
      const source = `${trigger.kind === "cron" ? "cron" : "tag"}:${target.workflowId}:${trigger.id}`;
      if (!target.enabled) {
        yield* deleteCursor(source);
        return;
      }
      const cursor = yield* getCursor(source);
      if (trigger.kind === "cron") {
        if (Option.isNone(cursor)) {
          yield* setCursor(source, now.toISOString());
          return;
        }
        const decision = cronDecision({
          triggerId: trigger.id,
          expr: trigger.expr,
          tz: trigger.tz,
          misfire: misfirePolicy(trigger, DEFAULT_HOST_LIMITS.misfire),
          toleranceMs: 60000,
          watermark: new Date(cursor.value),
          now,
        });
        if (decision._tag === "Invalid") yield* Effect.logWarning(decision.message);
        if (decision._tag === "Fire")
          yield* fireTrigger(engine.value, target, {
            kind: "cron",
            occurrence: decision.occurrence,
            label: `${trigger.expr} (${trigger.tz})`,
            payload: { at: decision.at.toISOString() },
          });
        if (decision._tag === "Fire" || decision._tag === "Skip")
          yield* setCursor(source, decision.watermark.toISOString());
      } else {
        const previous = Option.isSome(cursor) ? cursor.value : null;
        const separator = previous?.indexOf("|") ?? -1;
        if (
          previous &&
          now.getTime() - Date.parse(previous.slice(0, separator)) < trigger.pollMinutes * 60000
        )
          return;
        const output = yield* (
          options.listTags
            ? options.listTags(trigger.remote)
            : spawner.string(
                ChildProcess.make("git", ["ls-remote", "--tags", "--refs", trigger.remote]),
              )
        ).pipe(Effect.timeout("60 seconds"), Effect.result);
        if (output._tag === "Failure") {
          yield* Effect.logWarning(output.failure);
          return;
        }
        const tag = latestTag(output.success, trigger.pattern);
        const occurrence = tag
          ? occurrenceKey.tag(trigger.remote, tag.tag, tag.objectSha)
          : (previous?.slice(separator + 1) ?? "");
        if (previous && tag && occurrence !== previous.slice(separator + 1))
          yield* fireTrigger(engine.value, target, {
            kind: "upstreamTag",
            occurrence,
            label: `tag ${tag.tag}`,
            payload: { remote: trigger.remote, tag: tag.tag, sha: tag.objectSha },
          });
        yield* setCursor(source, `${now.toISOString()}|${occurrence}`);
      }
    }
  });
  return { poll, followEvents, available: Option.isSome(engine) };
});
export class WorkflowTriggers extends Context.Service<
  WorkflowTriggers,
  Effect.Success<ReturnType<typeof make>>
>()("t3/bots/workflows/triggers/WorkflowTriggers/WorkflowTriggers") {}
export const layer = Layer.effect(
  WorkflowTriggers,
  Effect.gen(function* () {
    const service = yield* make();
    if (service.available) {
      yield* forkParked(
        Effect.gen(function* () {
          yield* service.poll(new Date(yield* Clock.currentTimeMillis));
        }).pipe(Effect.catchCause(Effect.logWarning), Effect.repeat(Schedule.spaced("30 seconds"))),
      );
      for (const eventType of FOLLOWED_EVENT_TYPES) {
        yield* forkParked(
          service.followEvents(eventType).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow event trigger stopped", { eventType, cause }),
            ),
            Effect.repeat(Schedule.spaced("30 seconds")),
          ),
        );
      }
    } else yield* Effect.logWarning("WorkflowTriggers: WorkflowEngine unavailable");
    return service;
  }),
);
