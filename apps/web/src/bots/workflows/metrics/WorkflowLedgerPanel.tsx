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
      <label>
        Ledger id
        <Input value={ledger} onChange={(event) => setLedger(event.target.value)} />
      </label>
      <label>
        Verdict
        <select value={verdict} onChange={(event) => setVerdict(event.target.value)}>
          <option value="">All</option>
          {["kept", "validated", "rejected", "invalid", "duplicate", "abandoned"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      {validLedger ? (
        <LedgerRows
          key={`${ledger}:${verdict}`}
          {...props}
          ledger={isLedgerId(ledger) ? ledger : undefined}
          verdict={isVerdict(verdict) ? verdict : undefined}
        />
      ) : (
        <p>Enter a valid ledger id.</p>
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
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th>Hypothesis / bar</th>
                <th>Before → after</th>
                <th>SHA</th>
                <th>Verdict</th>
                <th>Note</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {query.data.entries.map((entry) => (
                <tr key={`${entry.ledger}:${entry.key}`}>
                  <td>
                    {entry.hypothesis}
                    <br />
                    {entry.barHash}
                  </td>
                  <td>
                    {JSON.stringify(entry.before)} → {JSON.stringify(entry.after)}
                  </td>
                  <td>{entry.sha?.slice(0, 8)}</td>
                  <td>
                    <span className="rounded border px-2">{entry.verdict ?? "Pending"}</span>
                  </td>
                  <td>{entry.note}</td>
                  <td>
                    <Link
                      to="/workflows/$environmentId/runs/$runId"
                      params={{ environmentId: props.environmentId, runId: entry.runId }}
                    >
                      Open run
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data.nextCursor ? (
            more ? (
              <LedgerRows {...props} cursor={query.data.nextCursor} />
            ) : (
              <Button onClick={() => setMore(true)}>Load more</Button>
            )
          ) : null}
          {query.data.entries.length === 0 ? <p>No ledger entries.</p> : null}
        </>
      ) : (
        <p>Loading ledger…</p>
      )}
    </>
  );
}
