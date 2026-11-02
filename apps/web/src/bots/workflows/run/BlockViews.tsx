import type { WorkflowBlockView } from "@t3tools/contracts";
import { StepStatusBadge } from "../WorkflowStatusBadge";
/** Compact live state for each block kind. */
export function BlockViews({ blocks }: { blocks: readonly WorkflowBlockView[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((block) => (
        <section key={block.step} className="rounded border p-3">
          <h3>
            {block.step} · {block._tag}
          </h3>
          {block._tag === "hillclimb" ? (
            <p>
              Round {block.round} · origin {block.origin?.slice(0, 8)} · best{" "}
              {block.best?.objective ?? "unknown"} · {block.roundsWithoutGain} rounds without gain ·{" "}
              {block.attempts} attempts
            </p>
          ) : block._tag === "arena" ? (
            <>
              <p>
                Base {block.base} · grafts {block.grafts.join(", ")}
              </p>
              {block.candidates.map((c) => (
                <p key={c.id}>
                  {c.id} <StepStatusBadge status={c.status} /> {c.score ?? "unknown"}
                </p>
              ))}
            </>
          ) : block._tag === "graph" ? (
            block.leaves.map((leaf) => (
              <p key={leaf.id}>
                {leaf.id} <StepStatusBadge status={leaf.status} /> · owns {leaf.owns.join(", ")} ·
                deps {leaf.deps.join(", ")} · rework {leaf.rework} · {leaf.sha?.slice(0, 8)}
              </p>
            ))
          ) : (
            <>
              <p>
                Round {block.round} · {block.verdict}
              </p>
              {block.findings.map((f) => (
                <p key={f.id}>
                  {f.id}: {f.summary} · {f.state}
                </p>
              ))}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
