/**
 * The run's kanban card (§10): opt-in by `card.project`, one per run, pointing at the run. Its
 * column follows the run: todo → in_progress → in_review while a gate waits → done. It never
 * links a step thread. Pure.
 */
import type { Intent } from "../facts.ts";
import type { RunState } from "../state.ts";

export type CardColumn = "todo" | "in_progress" | "in_review" | "done";
export type UpsertCardIntent = Extract<Intent, { readonly _tag: "UpsertCard" }>;

/**
 * The column for a run: done once it ended, in_review while a gate is undecided or the run is
 * paused, in_progress once any start was recorded, todo before.
 */
export const cardColumnOf = (run: {
  readonly ended: boolean;
  readonly waiting: boolean;
  readonly started: boolean;
}): CardColumn => {
  return run.ended ? "done" : run.waiting ? "in_review" : run.started ? "in_progress" : "todo";
};

/**
 * The UpsertCard to record when the column differs from the last recorded card intent's column
 * (none recorded yet counts as different), under `card:<n>` with n the count of card intents + 1.
 * Waits while the last one has no result, so the board never sees an older column after a newer one.
 */
export const cardIntent = (
  state: RunState,
  card: { readonly project: string; readonly title: string; readonly runId: string },
  column: CardColumn,
): UpsertCardIntent | null => {
  const entries = [...state.intents.values()].filter((entry) => entry.intent._tag === "UpsertCard");
  const last = entries.reduce<(typeof entries)[number] | undefined>(
    (latest, entry) => (!latest || entry.seq > latest.seq ? entry : latest),
    undefined,
  );
  if (last !== undefined && last.result === null) return null;
  if (last?.intent._tag === "UpsertCard" && last.intent.column === column) return null;
  return {
    _tag: "UpsertCard",
    key: `card:${entries.length + 1}`,
    project: card.project,
    title: card.title,
    column,
    runPath: `/workflows/runs/${card.runId}`,
  };
};
