/** A journal that counts the stored facts its reads hand back, for read-cost regression tests. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Journal } from "../Journal.ts";

export interface FactReads {
  /** Stored facts decoded and returned; a status read counts its at most two facts as two. */
  facts: number;
  /** RunCreated rows `createdRuns` returned. */
  createdRows: number;
}

/** Wraps the journal below it; reset the counters before the part a test measures. */
export const layerCountingJournal = (reads: FactReads) =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const real = yield* Journal;
      return Journal.of({
        ...real,
        read: Effect.fn("CountingJournal.read")(function* (stream: string, afterSeq?: number) {
          const facts = yield* real.read(stream, afterSeq);
          reads.facts += facts.length;
          return facts;
        }),
        get: Effect.fn("CountingJournal.get")(function* (stream: string, key: string) {
          const fact = yield* real.get(stream, key);
          if (Option.isSome(fact)) reads.facts += 1;
          return fact;
        }),
        workflowBacklog: Effect.fn("CountingJournal.workflowBacklog")(function* (
          workflowId: string,
          outcomes: number,
        ) {
          const facts = yield* real.workflowBacklog(workflowId, outcomes);
          reads.facts += facts.length;
          return facts;
        }),
        workflowStatus: Effect.fn("CountingJournal.workflowStatus")(function* (workflowId: string) {
          const status = yield* real.workflowStatus(workflowId);
          reads.facts += 2;
          return status;
        }),
        createdRuns: Effect.fn("CountingJournal.createdRuns")(function* (
          workflowId: string | null,
        ) {
          const rows = yield* real.createdRuns(workflowId);
          reads.createdRows += rows.length;
          return rows;
        }),
      });
    }),
  );
