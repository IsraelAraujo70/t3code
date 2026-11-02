import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import {
  BOTS_GUARDED_RPC_SCOPES,
  BOTS_RPC_SCOPES,
  BotId,
  botSideThreadId,
  isCalendarDay,
  KANBAN_WS_METHODS,
  KanbanTicketPatch,
  parseBotThreadId,
  parseBotThreadOwner,
  WORKFLOWS_WS_METHODS,
} from "./bots.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("voiceReaderVoice", () => {
  it("accepts a known voice, or null to defer to the env voice", () => {
    expect(decodeServerSettingsPatch({ voiceReaderVoice: "sol" })).toEqual({
      voiceReaderVoice: "sol",
    });
    expect(decodeServerSettingsPatch({ voiceReaderVoice: null })).toEqual({
      voiceReaderVoice: null,
    });
  });

  it("rejects a voice Codex realtime does not offer, naming the ones it does", () => {
    for (const voiceReaderVoice of ["rio", "Arbor", ""]) {
      expect(() => decodeServerSettingsPatch({ voiceReaderVoice })).toThrow(/"juniper"/);
    }
  });

  it("is unset by default, and reads an unknown stored voice as unset", () => {
    expect(decodeServerSettings({}).voiceReaderVoice).toBeNull();
    expect(decodeServerSettings({ voiceReaderVoice: "rio" }).voiceReaderVoice).toBeNull();
    expect(decodeServerSettings({ voiceReaderVoice: "maple" }).voiceReaderVoice).toBe("maple");
  });
});

describe("kanban RPCs", () => {
  it("guards every kanban write with the operate scope and lets readers subscribe", () => {
    for (const method of Object.values(KANBAN_WS_METHODS)) {
      if (method === KANBAN_WS_METHODS.kanbanSubscribe) {
        expect(BOTS_RPC_SCOPES[method]).toBe(AuthOrchestrationReadScope);
      } else {
        expect(BOTS_GUARDED_RPC_SCOPES[method]).toBe(AuthOrchestrationOperateScope);
      }
    }
  });
});

describe("workflows RPCs", () => {
  it("guards every write, run and gate decision with the operate scope and scopes every read", () => {
    const reads = new Set<string>([
      WORKFLOWS_WS_METHODS.workflowsSubscribe,
      WORKFLOWS_WS_METHODS.workflowsDocumentSubscribe,
      WORKFLOWS_WS_METHODS.workflowsValidate,
      WORKFLOWS_WS_METHODS.workflowsHistory,
      WORKFLOWS_WS_METHODS.workflowsRunsList,
      WORKFLOWS_WS_METHODS.workflowsRunGet,
      WORKFLOWS_WS_METHODS.workflowsRunSubscribe,
      WORKFLOWS_WS_METHODS.workflowsRunStep,
      WORKFLOWS_WS_METHODS.workflowsMetrics,
      WORKFLOWS_WS_METHODS.workflowsLedger,
    ]);
    for (const method of Object.values(WORKFLOWS_WS_METHODS)) {
      const read = reads.has(method);
      expect(BOTS_RPC_SCOPES[method]).toBe(
        read ? AuthOrchestrationReadScope : AuthOrchestrationOperateScope,
      );
      expect(Object.hasOwn(BOTS_GUARDED_RPC_SCOPES, method)).toBe(!read);
    }
    expect(BOTS_GUARDED_RPC_SCOPES[WORKFLOWS_WS_METHODS.workflowsGateDecide]).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});

describe("kanban due dates", () => {
  it("accepts only real calendar days", () => {
    expect(["2026-10-27", "2028-02-29"].map(isCalendarDay)).toEqual([true, true]);
    expect(
      ["2026-99-99", "2026-02-30", "2027-02-29", "2026-1-05", "26-10-27"].map(isCalendarDay),
    ).toEqual([false, false, false, false, false]);
    const decode = Schema.decodeUnknownExit(KanbanTicketPatch);
    expect(decode({ dueDate: "2026-10-27" })._tag).toBe("Success");
    expect(decode({ dueDate: null })._tag).toBe("Success");
    expect(decode({ dueDate: "2026-99-99" })._tag).toBe("Failure");
  });
});

describe("parseBotThreadOwner", () => {
  it("names the bot of a main or side thread, and parseBotThreadId stays main-only", () => {
    const side = botSideThreadId(BotId.make("b_1"), "0123abcd");
    expect(side).toBe("bot:b_1:t-0123abcd");
    expect(parseBotThreadOwner(side)).toEqual({ kind: "side", botId: "b_1" });
    expect(parseBotThreadId(side)).toBeNull();
    expect(parseBotThreadOwner("bot:b_1:3")).toEqual({ kind: "main", botId: "b_1", generation: 3 });
    for (const other of ["bot:b_1:0", "bot:b_1:t-XYZ12345", "bot:b_1:t-0123", "thread-1"]) {
      expect(parseBotThreadOwner(other)).toBeNull();
    }
  });
});
