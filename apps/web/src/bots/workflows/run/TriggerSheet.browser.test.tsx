import { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../../test/render";
import { TriggerSheet } from "./TriggerSheet";

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { payload: { message: "hello" }, truncated: false },
    error: null,
  }),
}));
vi.mock("../state", () => ({ workflowsEnvironment: { runTrigger: vi.fn(() => null) } }));

const decodeEnvironmentId = Schema.decodeSync(EnvironmentId);
const decodeRunId = Schema.decodeSync(WorkflowRunId);

it("shows the trigger metadata and payload", async () => {
  await using screen = await render(
    <TriggerSheet
      environmentId={decodeEnvironmentId("local")}
      runId={decodeRunId("wfr_00000000000000000001")}
      trigger={{
        id: "hook",
        kind: "webhook",
        label: "Incoming hook",
        occurrence: "event-1",
        test: true,
        payloadBytes: 19,
      }}
      onClose={() => {}}
    />,
  );
  await expect.element(screen.getByText('"message": "hello"', { exact: false })).toBeVisible();
  await expect.element(screen.getByText("19 bytes")).toBeVisible();
});
