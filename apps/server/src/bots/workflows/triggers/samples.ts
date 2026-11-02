/** Last trigger events and durable acknowledgement of webhook test deliveries. */
import {
  WorkflowRunId,
  type WorkflowTriggerSample,
  type WorkflowTriggerListenEvent,
  WorkflowsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import { Journal, type WorkflowJournalError } from "../Journal.ts";
import { WorkflowDefinitions } from "../definitions/WorkflowDefinitions.ts";

/** How long a listen waits for a delivery. */
export const LISTEN_WINDOW_MS = 120_000;
export type CaptureResult = "fire" | "captured" | "replayed";
export class TriggerSamples extends Context.Service<
  TriggerSamples,
  {
    readonly latest: (
      workflowId: string,
      triggerId: string,
    ) => Effect.Effect<Option.Option<WorkflowTriggerSample>, WorkflowJournalError>;
    readonly listen: (
      workflowId: string,
      triggerId: string,
    ) => Stream.Stream<WorkflowTriggerListenEvent, WorkflowsError>;
    readonly capture: (input: {
      readonly workflowId: string;
      readonly triggerId: string;
      readonly deliveryId: string;
      readonly payload: Schema.Json;
    }) => Effect.Effect<CaptureResult, WorkflowJournalError>;
  }
>()("t3/bots/workflows/triggers/samples/TriggerSamples") {}

export const layer = Layer.effect(
  TriggerSamples,
  Effect.gen(function* () {
    const journal = yield* Journal;
    const definitions = yield* WorkflowDefinitions;
    const listeners = new Map<string, Set<Deferred.Deferred<WorkflowTriggerSample>>>();
    const key = (workflowId: string, triggerId: string) => JSON.stringify([workflowId, triggerId]);
    const latest = Effect.fn("TriggerSamples.latest")(function* (
      workflowId: string,
      triggerId: string,
    ) {
      return Option.map(yield* journal.triggerSample(workflowId, triggerId), (sample) => ({
        triggerId,
        at: sample.at,
        test: sample.test,
        runId: sample.runId === null ? null : WorkflowRunId.make(sample.runId),
        payload: sample.payload,
      }));
    });
    return TriggerSamples.of({
      latest,
      capture: Effect.fn("TriggerSamples.capture")(function* (input) {
        if (yield* journal.isTestDelivery(input.deliveryId)) return "replayed";
        const waiting = listeners.get(key(input.workflowId, input.triggerId));
        if (!waiting?.size) return "fire";
        const result = yield* journal.captureTestDelivery(input);
        if (result === "replayed") return result;
        const sample = yield* latest(input.workflowId, input.triggerId);
        if (Option.isSome(sample)) {
          // Only the listeners present now: one that registers while they wake waits for the next.
          const present = Array.from(waiting);
          for (const listener of present) waiting.delete(listener);
          for (const listener of present) yield* Deferred.succeed(listener, sample.value);
        }
        return "captured";
      }),
      listen: (workflowId, triggerId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const document = yield* definitions.document(workflowId);
            const trigger = document.triggers.find(
              (entry) => entry.id === triggerId && entry.kind === "webhook",
            );
            if (!trigger)
              return yield* new WorkflowsError({
                code: "not-found",
                message: "Webhook trigger not found.",
              });
            if (!trigger.webhookUrl)
              return yield* new WorkflowsError({
                code: "unavailable",
                message: "The webhook URL is not ready yet.",
              });
            const listener = yield* Deferred.make<WorkflowTriggerSample>();
            const id = key(workflowId, triggerId);
            const expiresAt = DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + LISTEN_WINDOW_MS),
            );
            return Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => {
                  const waiting = listeners.get(id) ?? new Set();
                  waiting.add(listener);
                  listeners.set(id, waiting);
                }),
                () =>
                  Effect.sync(() => {
                    const waiting = listeners.get(id);
                    waiting?.delete(listener);
                    if (waiting?.size === 0) listeners.delete(id);
                  }),
              ).pipe(
                Effect.as(
                  Stream.succeed<WorkflowTriggerListenEvent>({
                    _tag: "Listening",
                    url: trigger.webhookUrl,
                    expiresAt,
                  }).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Deferred.await(listener).pipe(
                          Effect.map((sample): WorkflowTriggerListenEvent => ({
                            _tag: "Captured",
                            sample,
                          })),
                          Effect.timeoutOrElse({
                            duration: LISTEN_WINDOW_MS,
                            orElse: () =>
                              Effect.succeed<WorkflowTriggerListenEvent>({ _tag: "Expired" }),
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
        ),
    });
  }),
);
