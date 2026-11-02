import { Link } from "@tanstack/react-router";
import type { EnvironmentId, WorkflowDocument, WorkflowRunId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { randomUUID } from "../../../lib/utils";
import { commandFailureMessage } from "../../botsSettingsShared";
import { workflowsEnvironment } from "../state";

/** Shows captured webhook input and runs an explicit test with that event. */
export function WebhookTriggerPanel({
  environmentId,
  document,
  triggerId,
}: {
  environmentId: EnvironmentId;
  document: WorkflowDocument;
  triggerId: string;
}) {
  const [listening, setListening] = useState(false);
  const [run, setRun] = useState<WorkflowRunId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = document.triggers.find((trigger) => trigger.id === triggerId);
  const sample = useEnvironmentQuery(
    summary
      ? workflowsEnvironment.triggerSample({
          environmentId,
          input: { workflowId: document.workflowId, triggerId },
        })
      : null,
  );
  const listener = useEnvironmentQuery(
    listening
      ? workflowsEnvironment.triggerListen({
          environmentId,
          input: { workflowId: document.workflowId, triggerId },
        })
      : null,
  );
  const event = listener.data;
  const refreshSample = sample.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the persisted sample after the capture subscription emits
  useEffect(() => {
    if (event?._tag === "Captured") refreshSample();
  }, [event, refreshSample]);
  const captured = event?._tag === "Captured" ? event.sample : sample.data;
  const { copyToClipboard } = useCopyToClipboard({ target: "webhook" });
  const runStart = useAtomCommand(workflowsEnvironment.runStart);
  const canListen = useAtomValue(workflowsEnvironment.triggerListenPermission(environmentId));
  const canRun = useAtomValue(workflowsEnvironment.runStart.permissionAtom(environmentId));
  const paths: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (paths.length >= 30) return;
    paths.push(path);
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  if (captured) walk(captured.payload, "trigger");
  return (
    <div className="space-y-2">
      {summary?.webhookUrl ? (
        <>
          <p>{summary.webhookUrl}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyToClipboard(summary.webhookUrl ?? "")}
          >
            Copy URL
          </Button>
        </>
      ) : (
        <p>Save to get the URL</p>
      )}
      {captured && (
        <details>
          <summary>
            Last event · {captured.at} {captured.test ? "test" : ""}
          </summary>
          <pre>{JSON.stringify(captured.payload, null, 2)}</pre>
        </details>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!summary || (!listening && !canListen)}
        onClick={() => setListening(!listening)}
      >
        {listening ? "Stop" : "Listen for test event"}
      </Button>
      {event?._tag === "Listening" && (
        <p>Listening until {new Date(event.expiresAt).toLocaleTimeString()}</p>
      )}
      {event?._tag === "Expired" && <p>No event arrived</p>}
      {listening && listener.error ? <p role="alert">{listener.error}</p> : null}
      <p>Events can take up to 10 s to arrive.</p>
      <Button
        size="sm"
        disabled={!captured || !summary || !canRun}
        onClick={() =>
          void runStart({
            environmentId,
            input: {
              workflowId: document.workflowId,
              clientRequestId: randomUUID(),
              testTrigger: triggerId,
            },
          }).then((result) =>
            result._tag === "Success"
              ? setRun(result.value.runId)
              : setError(commandFailureMessage(result) ?? "Could not start the run."),
          )
        }
      >
        Run with this event
      </Button>
      {run && (
        <Link to="/workflows/$environmentId/runs/$runId" params={{ environmentId, runId: run }}>
          View run
        </Link>
      )}
      {error && <p role="alert">{error}</p>}
      {paths.slice(0, 30).map((path) => (
        <Button
          key={path}
          size="xs"
          variant="outline"
          onClick={() => void copyToClipboard(`{{ ${path} }}`)}
        >
          {path}
        </Button>
      ))}
    </div>
  );
}
