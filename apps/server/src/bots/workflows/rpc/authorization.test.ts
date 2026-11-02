import { expect, it } from "@effect/vitest";
import { RPC_REQUIRED_SCOPES } from "../../../auth/RpcAuthorization.ts";

it("requires write scope for workflow mutations and read scope for inspection", () => {
  for (const method of [
    "bots.workflows.save",
    "bots.workflows.setEnabled",
    "bots.workflows.run.start",
    "bots.workflows.run.control",
    "bots.workflows.gate.decide",
  ] as const) {
    expect(RPC_REQUIRED_SCOPES[method]).not.toBe("orchestration:read");
  }
  expect(RPC_REQUIRED_SCOPES["bots.workflows.subscribe"]).toBe("orchestration:read");
  expect(RPC_REQUIRED_SCOPES["bots.workflows.validate"]).toBe("orchestration:read");
});
