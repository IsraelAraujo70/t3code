// @effect-diagnostics globalDateInEffect:off deterministicKeys:off - Poll accepts explicit Date watermarks; the service key follows the workflow trigger contract.
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
import { cronDecision, misfirePolicy, latestTag, occurrenceKey } from "./occurrence.ts";

export const make = Effect.fn("WorkflowTriggers.make")(function* (
  options: {
    readonly engine?: Pick<WorkflowEngine["Service"], "start">;
    readonly listTags?: (remote: string) => Effect.Effect<string, Error>;
  } = {},
) {
  const provided = yield* Effect.serviceOption(WorkflowEngine);
  const engine = options.engine ? Option.some(options.engine) : provided;
  const context = yield* Effect.context<SqlClient.SqlClient | Journal>();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const poll = Effect.fn("WorkflowTriggers.poll")(function* (now: Date) {
    if (Option.isNone(engine)) return;
    for (const target of yield* listTriggerTargets) {
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
  return { poll, available: Option.isSome(engine) };
});
export class WorkflowTriggers extends Context.Service<
  WorkflowTriggers,
  Effect.Success<ReturnType<typeof make>>
>()("t3/bots/workflows/triggers/WorkflowTriggers/WorkflowTriggers") {}
export const layer = Layer.effect(
  WorkflowTriggers,
  Effect.gen(function* () {
    const service = yield* make();
    if (service.available)
      yield* forkParked(
        Effect.gen(function* () {
          yield* service.poll(new Date(yield* Clock.currentTimeMillis));
        }).pipe(Effect.catchCause(Effect.logWarning), Effect.repeat(Schedule.spaced("30 seconds"))),
      );
    else yield* Effect.logWarning("WorkflowTriggers: WorkflowEngine unavailable");
    return service;
  }),
);
