import type { EnvironmentId } from "@t3tools/contracts";

type Target =
  | { readonly kind: "disabled" | "offline" }
  | { readonly kind: "connected"; readonly environmentId: EnvironmentId };

interface Registration {
  readonly environmentId: EnvironmentId;
  readonly token: string;
}

/** Serializes registration and opt-out so a late registration cannot undo an opt-out. */
export function createBotPushRegistration(deps: {
  readonly configure: (enabled: boolean) => void;
  readonly permission: () => Promise<boolean>;
  readonly readToken: () => Promise<string | null>;
  readonly register: (registration: Registration) => Promise<void>;
  readonly unregister: (registration: Registration) => Promise<void>;
  readonly log: (error: unknown) => void;
  readonly now: () => number;
}) {
  let target: Target = { kind: "offline" };
  let revision = 0;
  let lastRegistration: Registration | null = null;
  let lastSuccess: number | null = null;
  let queue = Promise.resolve();

  const enqueue = (operation: () => Promise<void>) => {
    queue = queue.then(operation).catch(deps.log);
    return queue;
  };

  const refresh = (reason: "connect" | "foreground" | "token", observedToken?: string) => {
    const current = target;
    const version = revision;
    return enqueue(async () => {
      if (version !== revision) return;
      if (current.kind === "disabled") {
        if (lastRegistration) {
          await deps.unregister(lastRegistration);
          lastRegistration = null;
        }
        return;
      }
      if (current.kind !== "connected") return;
      if (reason === "foreground" && lastSuccess !== null && deps.now() - lastSuccess < 180_000) {
        return;
      }
      if (!(await deps.permission()) || version !== revision) return;
      const token = observedToken ?? (await deps.readToken());
      if (!token || version !== revision) return;
      const registration = { environmentId: current.environmentId, token };
      await deps.register(registration);
      lastRegistration = registration;
      lastSuccess = deps.now();
    });
  };

  return {
    /** Applies a connection/preference transition and retries without the foreground throttle. */
    update(enabled: boolean, environmentId: EnvironmentId | null) {
      revision += 1;
      target = !enabled
        ? { kind: "disabled" }
        : environmentId === null
          ? { kind: "offline" }
          : { kind: "connected", environmentId };
      deps.configure(enabled);
      return refresh("connect");
    },
    refresh,
    /** Invalidates queued work without removing the durable server registration. */
    dispose() {
      revision += 1;
      target = { kind: "offline" };
    },
  };
}
