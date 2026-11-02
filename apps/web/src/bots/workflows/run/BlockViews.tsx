import type { WorkflowBlockView } from "@t3tools/contracts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { StepStatusBadge } from "../WorkflowStatusBadge";
/** Compact live state for each block kind. */
export function BlockViews({ blocks }: { blocks: readonly WorkflowBlockView[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xs font-medium text-muted-foreground">Blocks</h2>
      {blocks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No blocks in this run.</p>
      ) : null}
      {blocks.map((block) => (
        <section key={block.step} className="space-y-3 rounded-lg border p-4">
          <h3 className="text-xs font-medium text-muted-foreground">
            {block.step} · {block._tag}
          </h3>
          {block._tag === "hillclimb" ? (
            <dl className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Round</dt>
                <dd className="mt-1">{block.round}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Origin</dt>
                <dd className="mt-1">{block.origin?.slice(0, 8) ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Best</dt>
                <dd className="mt-1">{block.best?.objective ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Rounds without gain</dt>
                <dd className="mt-1">{block.roundsWithoutGain}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Attempts</dt>
                <dd className="mt-1">{block.attempts}</dd>
              </div>
            </dl>
          ) : block._tag === "arena" ? (
            <>
              <p className="text-xs text-muted-foreground">
                Base {block.base ?? "Pending"} · grafts {block.grafts.join(", ") || "none"}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Candidate</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {block.candidates.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.id}</TableCell>
                      <TableCell>
                        <StepStatusBadge status={c.status} />
                      </TableCell>
                      <TableCell>{c.score ?? "unknown"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {block.candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">No candidates yet.</p>
              ) : null}
            </>
          ) : block._tag === "graph" ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Leaf</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Owns</TableHead>
                    <TableHead>Dependencies</TableHead>
                    <TableHead>Rework</TableHead>
                    <TableHead>SHA</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {block.leaves.map((leaf) => (
                    <TableRow key={leaf.id}>
                      <TableCell>{leaf.id}</TableCell>
                      <TableCell>
                        <StepStatusBadge status={leaf.status} />
                      </TableCell>
                      <TableCell>{leaf.owns.join(", ") || "none"}</TableCell>
                      <TableCell>{leaf.deps.join(", ") || "none"}</TableCell>
                      <TableCell>{leaf.rework}</TableCell>
                      <TableCell>{leaf.sha?.slice(0, 8) ?? "Pending"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {block.leaves.length === 0 ? (
                <p className="text-xs text-muted-foreground">No leaves yet.</p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Round {block.round} · {block.verdict ?? "Pending"}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Finding</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {block.findings.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>{f.id}</TableCell>
                      <TableCell>
                        <p className="max-w-lg whitespace-normal">{f.summary}</p>
                      </TableCell>
                      <TableCell>{f.state}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {block.findings.length === 0 ? (
                <p className="text-xs text-muted-foreground">No findings yet.</p>
              ) : null}
            </>
          )}
        </section>
      ))}
    </section>
  );
}
