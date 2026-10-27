import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "./auth.ts";
import { BOTS_GUARDED_RPC_SCOPES, BOTS_RPC_SCOPES, KANBAN_WS_METHODS } from "./bots.ts";
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
