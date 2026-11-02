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

/** Filterable, cursor-paged experiment ledger. */
export function WorkflowLedgerPanel(props: {
  environmentId: EnvironmentId;
  workflowId?: WorkflowId;
}) {
  const [ledger, setLedger] = useState("");
  const [verdict, setVerdict] = useState("");
  const validLedger = ledger === "" || isLedgerId(ledger);
  return (
    <div className="space-y-4">
      <h2 className="text-xs font-medium text-muted-foreground">Experiment ledger</h2>
      <div className="grid max-w-lg gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-xs text-muted-foreground">
          Ledger id
          <Input value={ledger} onChange={(event) => setLedger(event.target.value)} />
        </label>
        <label className="space-y-2 text-xs text-muted-foreground">
          Verdict
          <Select value={verdict} onValueChange={(value) => setVerdict(value ?? "")}>
            <SelectTrigger aria-label="Verdict">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All</SelectItem>
              {["kept", "validated", "rejected", "invalid", "duplicate", "abandoned"].map(
                (value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
        </label>
      </div>
      {validLedger ? (
        <LedgerRows
          key={`${ledger}:${verdict}`}
          {...props}
          ledger={isLedgerId(ledger) ? ledger : undefined}
          verdict={isVerdict(verdict) ? verdict : undefined}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Enter a valid ledger id.</p>
      )}
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
      {query.error ? <p role="alert">{query.error}</p> : null}
      {query.data ? (
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
                    {entry.before === null ? "unknown" : JSON.stringify(entry.before)} →{" "}
                    {entry.after === null ? "unknown" : JSON.stringify(entry.after)}
                  </TableCell>
                  <TableCell>{entry.sha?.slice(0, 8)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{entry.verdict ?? "Pending"}</Badge>
                  </TableCell>
                  <TableCell>{entry.note}</TableCell>
                  <TableCell>
                    <Button
                      size="xs"
                      variant="outline"
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
          {query.data.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ledger entries.</p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Loading ledger…</p>
      )}
    </>
  );
}
