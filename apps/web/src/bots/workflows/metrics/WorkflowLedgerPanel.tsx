import { Badge } from "../../../components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../../../components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../../components/ui/table";
import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  WorkflowLedgerId,
  WorkflowLedgerVerdict,
  type EnvironmentId,
  type WorkflowId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEnvironmentQuery } from "../../../state/query";
import { workflowsEnvironment } from "../state";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
const isLedgerId = Schema.is(WorkflowLedgerId);
const isVerdict = Schema.is(WorkflowLedgerVerdict);
const VERDICT_VARIANT = {
  kept: "success",
  validated: "success",
  rejected: "error",
  invalid: "error",
  duplicate: "secondary",
  abandoned: "secondary",
} as const satisfies Record<WorkflowLedgerVerdict, string>;

/** Filterable, cursor-paged experiment ledger. */
export function WorkflowLedgerPanel(props: {
  environmentId: EnvironmentId;
  workflowId?: WorkflowId;
}) {
  const [ledger, setLedger] = useState("");
  const [verdict, setVerdict] = useState("");
  const validLedger = ledger === "" || isLedgerId(ledger);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        What hill-climb and arena steps tried, measured and kept, newest first.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <Input
            aria-label="Ledger id"
            placeholder="Filter by ledger id"
            size="sm"
            value={ledger}
            onChange={(event) => setLedger(event.target.value)}
          />
        </div>
        <div className="w-40">
          <Select value={verdict} onValueChange={(value) => setVerdict(value ?? "")}>
            <SelectTrigger aria-label="Verdict" size="sm">
              <SelectValue>{verdict === "" ? "Any verdict" : verdict}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">Any verdict</SelectItem>
              {["kept", "validated", "rejected", "invalid", "duplicate", "abandoned"].map(
                (value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
        </div>
        {!validLedger ? (
          <span className="text-destructive text-xs">Not a valid ledger id.</span>
        ) : null}
      </div>
      {validLedger ? (
        <LedgerRows
          key={`${ledger}:${verdict}`}
          {...props}
          ledger={isLedgerId(ledger) ? ledger : undefined}
          verdict={isVerdict(verdict) ? verdict : undefined}
        />
      ) : null}
    </div>
  );
}
function LedgerRows(props: {
  environmentId: EnvironmentId;
  workflowId?: WorkflowId;
  ledger?: WorkflowLedgerId | undefined;
  verdict?: WorkflowLedgerVerdict | undefined;
  cursor?: string;
}) {
  const [more, setMore] = useState(false);
  const query = useEnvironmentQuery(
    workflowsEnvironment.ledger({
      environmentId: props.environmentId,
      input: {
        workflowId: props.workflowId,
        ledger: props.ledger,
        verdict: props.verdict,
        cursor: props.cursor,
      },
    }),
  );
  return (
    <>
      {query.error ? (
        <p role="alert" className="text-destructive text-sm">
          {query.error}
        </p>
      ) : null}
      {query.data && query.data.entries.length === 0 && props.cursor === undefined ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
          {props.ledger || props.verdict
            ? "No entries match these filters."
            : "No ledger entries yet. Hill-climb and arena steps record each attempt here."}
        </p>
      ) : query.data ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hypothesis / bar</TableHead>
                <TableHead>Before → after</TableHead>
                <TableHead>SHA</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Run</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.entries.map((entry) => (
                <TableRow key={`${entry.ledger}:${entry.key}`}>
                  <TableCell>
                    <p className="max-w-64 whitespace-normal">{entry.hypothesis}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{entry.barHash}</p>
                  </TableCell>
                  <TableCell>
                    <span className="tabular-nums">
                      {entry.before === null ? "-" : JSON.stringify(entry.before)} →{" "}
                      {entry.after === null ? "-" : JSON.stringify(entry.after)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code>{entry.sha?.slice(0, 8)}</code>
                  </TableCell>
                  <TableCell>
                    <Badge
                      size="sm"
                      variant={entry.verdict ? VERDICT_VARIANT[entry.verdict] : "outline"}
                    >
                      {entry.verdict ?? "Pending"}
                    </Badge>
                  </TableCell>
                  <TableCell>{entry.note}</TableCell>
                  <TableCell>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      render={
                        <Link
                          to="/workflows/$environmentId/runs/$runId"
                          params={{ environmentId: props.environmentId, runId: entry.runId }}
                        />
                      }
                    >
                      Open run
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {query.data.nextCursor ? (
            more ? (
              <LedgerRows {...props} cursor={query.data.nextCursor} />
            ) : (
              <Button size="xs" variant="outline" onClick={() => setMore(true)}>
                Load more
              </Button>
            )
          ) : null}
        </>
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          Loading ledger…
        </p>
      )}
    </>
  );
}
