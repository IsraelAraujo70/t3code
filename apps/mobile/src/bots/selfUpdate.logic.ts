import type { MobileUpdateBuild, MobileUpdateInfo } from "@t3tools/contracts";

/** The commit this APK was built from (`extra.friendBuild`, written by app.config). */
export interface EmbeddedBuild {
  readonly commit: string;
  readonly commitDate: string;
}

/** Automatic checks (launch, back to foreground) wait this long after the last one. */
export const CHECK_INTERVAL_MS = 15 * 60_000;

/** `extra.friendBuild` when this build carries one: only preview builds do. */
export function readEmbeddedBuild(extra: unknown): EmbeddedBuild | null {
  if (typeof extra !== "object" || extra === null || !("friendBuild" in extra)) return null;
  const build = extra.friendBuild;
  if (typeof build !== "object" || build === null) return null;
  const commit = "commit" in build ? build.commit : undefined;
  const commitDate = "commitDate" in build ? build.commitDate : undefined;
  return typeof commit === "string" &&
    /^[0-9a-f]{40}$/.test(commit) &&
    typeof commitDate === "string"
    ? { commit, commitDate }
    : null;
}

/**
 * The server's build is offered whenever it is another commit than the running one. The server
 * decides what is current: publishing an older build is how a bad one gets rolled back.
 */
export function isUpdateAvailable(
  embedded: EmbeddedBuild | null,
  latest: MobileUpdateBuild | null,
): latest is MobileUpdateBuild {
  return embedded !== null && latest !== null && latest.commit !== embedded.commit;
}

export type SelfUpdatePhase =
  | { readonly type: "idle" }
  | { readonly type: "checking" }
  | { readonly type: "downloading"; readonly fraction: number | null }
  | { readonly type: "verifying" }
  | { readonly type: "installing" };

export interface SelfUpdateSnapshot {
  readonly embedded: EmbeddedBuild | null;
  /** The server's build at the last check; null when nothing is published or never checked. */
  readonly latest: MobileUpdateBuild | null;
  /** When the server last answered a check. */
  readonly checkedAt: number | null;
  readonly phase: SelfUpdatePhase;
  /** The last failure, shown in Settings; cleared by the next success. */
  readonly error: string | null;
  /** The notice was closed for this commit; Settings still offers it. */
  readonly dismissedCommit: string | null;
}

export interface SelfUpdateDeps {
  readonly embedded: EmbeddedBuild | null;
  /** The server's answer, or null when no server to ask is connected. */
  readonly fetchInfo: () => Promise<MobileUpdateInfo | null>;
  /** Whether to go ahead with an install the user asked for (Android's first-time warning). */
  readonly confirmInstall: () => Promise<boolean>;
  /** Downloads `build`'s APK and returns its local path. */
  readonly download: (
    build: MobileUpdateBuild,
    onProgress: (fraction: number | null) => void,
  ) => Promise<string>;
  /** Lowercase hex sha256 and byte size of a local file. */
  readonly inspect: (path: string) => Promise<{ readonly sha256: string; readonly size: number }>;
  /** Hands the APK to the system installer. */
  readonly install: (path: string) => Promise<void>;
  readonly now: () => number;
}

export type CheckReason = "launch" | "foreground" | "manual";

/**
 * The app's self-update: checks the server's published build, and on request downloads it,
 * checks its sha256 and size, and opens the system installer. One operation runs at a time.
 */
export function createSelfUpdate(deps: SelfUpdateDeps) {
  let snapshot: SelfUpdateSnapshot = {
    embedded: deps.embedded,
    latest: null,
    checkedAt: null,
    phase: { type: "idle" },
    error: null,
    dismissedCommit: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SelfUpdateSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const message = (error: unknown) =>
    error instanceof Error && error.message ? error.message : String(error);

  const check = async (reason: CheckReason): Promise<void> => {
    if (deps.embedded === null || snapshot.phase.type !== "idle") return;
    if (
      reason !== "manual" &&
      snapshot.checkedAt !== null &&
      deps.now() - snapshot.checkedAt < CHECK_INTERVAL_MS
    ) {
      return;
    }
    set({ phase: { type: "checking" } });
    try {
      const info = await deps.fetchInfo();
      if (info === null) {
        set({
          phase: { type: "idle" },
          ...(reason === "manual" ? { error: "O servidor do T3 não está conectado." } : {}),
        });
        return;
      }
      set({ phase: { type: "idle" }, latest: info.latest, checkedAt: deps.now(), error: null });
    } catch (error) {
      set({ phase: { type: "idle" }, error: `Não deu para verificar: ${message(error)}` });
    }
  };

  const install = async (): Promise<void> => {
    const build = snapshot.latest;
    if (!isUpdateAvailable(snapshot.embedded, build) || snapshot.phase.type !== "idle") return;
    if (!(await deps.confirmInstall())) return;
    set({ phase: { type: "downloading", fraction: null }, error: null });
    try {
      const path = await deps.download(build, (fraction) =>
        set({ phase: { type: "downloading", fraction } }),
      );
      set({ phase: { type: "verifying" } });
      const file = await deps.inspect(path);
      if (file.sha256 !== build.sha256 || file.size !== build.size) {
        throw new Error("o APK baixado não confere com o publicado. Nada foi instalado.");
      }
      set({ phase: { type: "installing" } });
      await deps.install(path);
      set({ phase: { type: "idle" } });
    } catch (error) {
      set({ phase: { type: "idle" }, error: `Atualização falhou: ${message(error)}` });
    }
  };

  return {
    check,
    install,
    dismiss: () => set({ dismissedCommit: snapshot.latest?.commit ?? null }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

export type SelfUpdate = ReturnType<typeof createSelfUpdate>;
