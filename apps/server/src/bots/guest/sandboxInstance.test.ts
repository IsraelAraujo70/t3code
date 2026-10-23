import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  GuestId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { parseGuestListen } from "./GuestHttp.ts";
import {
  declaresGuest,
  GUEST_ID_ENV,
  isSandboxedFor,
  SANDBOX_LAUNCHER_PATH,
  sandboxBinaryFor,
} from "./sandboxInstance.ts";

const bia = GuestId.make("bia");
const id = ProviderInstanceId.make("claude_bia");

const instance = (overrides: Partial<ProviderInstanceConfig> = {}): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("claudeAgent"),
  environment: [{ name: GUEST_ID_ENV, value: "bia", sensitive: false }],
  config: { binaryPath: SANDBOX_LAUNCHER_PATH },
  ...overrides,
});

describe("sandbox instances", () => {
  it("withholds MCP from any instance that names a guest, configured right or not", () => {
    assert.isTrue(declaresGuest({ [id]: instance({ config: { binaryPath: "claude" } }) }, id));
    assert.isFalse(declaresGuest({ [id]: instance({ environment: [] }) }, id));
    assert.isFalse(declaresGuest({}, id));
  });

  it("treats duplicate guest entries the way the launched process sees them", () => {
    const duplicated = (first: string, last: string) =>
      instance({
        environment: [
          { name: GUEST_ID_ENV, value: first, sensitive: false },
          { name: GUEST_ID_ENV, value: last, sensitive: false },
        ],
      });
    // The process gets the last value, so a first entry naming the guest proves nothing.
    assert.isNull(sandboxBinaryFor({ [id]: duplicated("bia", "ana") }, id, bia));
    assert.isNull(sandboxBinaryFor({ [id]: duplicated("bia", "bia") }, id, bia));
    assert.isTrue(declaresGuest({ [id]: duplicated("", "ana") }, id));
    assert.isTrue(declaresGuest({ [id]: duplicated("ana", "") }, id));
  });

  it("sandboxes only an enabled claudeAgent instance naming that guest", () => {
    assert.strictEqual(sandboxBinaryFor({ [id]: instance() }, id, bia), SANDBOX_LAUNCHER_PATH);
    assert.isNull(sandboxBinaryFor({ [id]: instance() }, id, GuestId.make("ana")));
    assert.isNull(sandboxBinaryFor({ [id]: instance({ enabled: false }) }, id, bia));
    assert.isNull(
      sandboxBinaryFor({ [id]: instance({ driver: ProviderDriverKind.make("codex") }) }, id, bia),
    );
    assert.isNull(sandboxBinaryFor({ [id]: instance({ config: {} }) }, id, bia));
  });

  it.effect("requires the binary to be the launcher file itself", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isSandboxedFor({ [id]: instance() }, id, bia, "/nonexistent"));
      const elsewhere = instance({ config: { binaryPath: "/usr/bin/env" } });
      assert.isFalse(yield* isSandboxedFor({ [id]: elsewhere }, id, bia, "/nonexistent"));
      const missing = instance({ config: { binaryPath: "/nonexistent/t3-guest-claude" } });
      assert.isFalse(yield* isSandboxedFor({ [id]: missing }, id, bia, "/nonexistent"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("parseGuestListen", () => {
  it("reads host:port and bracketed IPv6", () => {
    assert.deepStrictEqual(parseGuestListen("100.67.31.112:3794"), {
      host: "100.67.31.112",
      port: 3794,
    });
    assert.deepStrictEqual(parseGuestListen("[::1]:80"), { host: "::1", port: 80 });
    assert.isNull(parseGuestListen("3794"));
    assert.isNull(parseGuestListen("host:0"));
    assert.isNull(parseGuestListen("host:70000"));
  });
});
