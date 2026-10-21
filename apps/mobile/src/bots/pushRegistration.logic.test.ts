import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createBotPushRegistration } from "./pushRegistration.logic";

const environmentId = EnvironmentId.make("bots-host");

function setup() {
  let now = 1_000_000;
  const deps = {
    configure: vi.fn(),
    permission: vi.fn(async () => true),
    readToken: vi.fn(async (): Promise<string | null> => "token-1"),
    register: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
    log: vi.fn(),
    now: () => now,
  };
  return {
    deps,
    controller: createBotPushRegistration(deps),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("direct bot push registration", () => {
  it("registers on reconnect and rotation while throttling foreground refreshes", async () => {
    const { controller, deps, advance } = setup();
    await controller.update(true, environmentId);
    await controller.refresh("foreground");
    expect(deps.register).toHaveBeenCalledTimes(1);
    advance(180_000);
    await controller.refresh("foreground");
    expect(deps.register).toHaveBeenCalledTimes(2);
    await controller.refresh("token", "rotated");
    expect(deps.register).toHaveBeenLastCalledWith({ environmentId, token: "rotated" });
    await controller.update(true, null);
    await controller.update(true, environmentId);
    expect(deps.register).toHaveBeenCalledTimes(4);
  });

  it("retries failed registration on the next trigger without throttling it", async () => {
    const { controller, deps } = setup();
    deps.register.mockRejectedValueOnce(new Error("offline"));
    await controller.update(true, environmentId);
    expect(deps.log).toHaveBeenCalledTimes(1);
    await controller.refresh("foreground");
    expect(deps.register).toHaveBeenCalledTimes(2);
  });

  it("does not register without permission or a connected host", async () => {
    const { controller, deps } = setup();
    await controller.update(true, null);
    expect(deps.permission).not.toHaveBeenCalled();
    deps.permission.mockResolvedValue(false);
    await controller.update(true, environmentId);
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("invalidates token acquisition when disabled and closes the native gate immediately", async () => {
    const { controller, deps } = setup();
    let finishToken: (token: string) => void = () => {};
    let started: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    deps.readToken.mockImplementationOnce(() => {
      started();
      return new Promise<string>((resolve) => {
        finishToken = resolve;
      });
    });
    const registering = controller.update(true, environmentId);
    await reading;
    const disabling = controller.update(false, environmentId);
    expect(deps.configure).toHaveBeenLastCalledWith(false);
    finishToken("late");
    await registering;
    await disabling;
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("unregisters a registration that finishes after opt-out and retries cleanup failures", async () => {
    const { controller, deps } = setup();
    let finish: () => void = () => {};
    let started: () => void = () => {};
    const registering = new Promise<void>((resolve) => {
      started = resolve;
    });
    deps.register.mockImplementationOnce(() => {
      started();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const pending = controller.update(true, environmentId);
    await registering;
    deps.unregister.mockRejectedValueOnce(new Error("offline"));
    const disabled = controller.update(false, environmentId);
    finish();
    await pending;
    await disabled;
    await controller.refresh("foreground");
    expect(deps.unregister).toHaveBeenCalledTimes(2);
    expect(deps.unregister).toHaveBeenLastCalledWith({ environmentId, token: "token-1" });
  });
});
