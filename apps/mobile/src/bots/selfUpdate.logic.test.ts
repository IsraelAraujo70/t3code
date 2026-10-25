import type { MobileUpdateBuild } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CHECK_INTERVAL_MS,
  createSelfUpdate,
  isUpdateAvailable,
  readEmbeddedBuild,
} from "./selfUpdate.logic";

const running = { commit: "a".repeat(40), commitDate: "2026-10-24T10:00:00-03:00" };
const published: MobileUpdateBuild = {
  commit: "b".repeat(40),
  shortCommit: "bbbbbbbbbb",
  commitDate: "2026-10-24T12:00:00-03:00",
  builtAt: "2026-10-24T15:10:00Z",
  size: 1234,
  sha256: "c".repeat(64),
};

function setup(embedded: typeof running | null = running) {
  let now = 1_000_000;
  const deps = {
    embedded,
    fetchInfo: vi.fn(async (): Promise<{ latest: MobileUpdateBuild | null } | null> => ({
      latest: published,
    })),
    confirmInstall: vi.fn(async () => true),
    download: vi.fn(async () => "/cache/friend-update/t3code-friend-bbbbbbbbbb.apk"),
    inspect: vi.fn(async () => ({ sha256: published.sha256, size: published.size })),
    install: vi.fn(async () => {}),
    now: () => now,
  };
  return {
    deps,
    update: createSelfUpdate(deps),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("readEmbeddedBuild", () => {
  it("reads the commit a preview build carries", () => {
    expect(readEmbeddedBuild({ appVariant: "preview", friendBuild: running })).toEqual(running);
  });

  it.each([
    ["no extra", undefined],
    ["a build without one", { appVariant: "production", friendBuild: null }],
    ["a short sha", { friendBuild: { commit: "abc123", commitDate: running.commitDate } }],
  ])("is null for %s", (_name, extra) => {
    expect(readEmbeddedBuild(extra)).toBeNull();
  });
});

describe("isUpdateAvailable", () => {
  it("offers a different commit, newer or older", () => {
    expect(isUpdateAvailable(running, published)).toBe(true);
    expect(isUpdateAvailable(running, { ...published, commitDate: "2020-01-01T00:00:00Z" })).toBe(
      true,
    );
  });

  it("offers nothing for the running commit, an empty server, or a build without a commit", () => {
    expect(isUpdateAvailable(running, { ...published, commit: running.commit })).toBe(false);
    expect(isUpdateAvailable(running, null)).toBe(false);
    expect(isUpdateAvailable(null, published)).toBe(false);
  });
});

describe("createSelfUpdate", () => {
  it("checks on launch, then waits the interval before checking on foreground", async () => {
    const { deps, update, advance } = setup();
    await update.check("launch");
    expect(update.getSnapshot().latest).toEqual(published);
    await update.check("foreground");
    expect(deps.fetchInfo).toHaveBeenCalledTimes(1);
    await update.check("manual");
    expect(deps.fetchInfo).toHaveBeenCalledTimes(2);
    advance(CHECK_INTERVAL_MS);
    await update.check("foreground");
    expect(deps.fetchInfo).toHaveBeenCalledTimes(3);
  });

  it("retries on the next foreground after a failed or unconnected check", async () => {
    const { deps, update } = setup();
    deps.fetchInfo.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(null);
    await update.check("launch");
    expect(update.getSnapshot()).toMatchObject({ checkedAt: null, latest: null });
    expect(update.getSnapshot().error).toContain("timeout");
    await update.check("foreground");
    await update.check("foreground");
    expect(deps.fetchInfo).toHaveBeenCalledTimes(3);
    expect(update.getSnapshot()).toMatchObject({ latest: published, error: null });
  });

  it("never checks in a build without an embedded commit", async () => {
    const { deps, update } = setup(null);
    await update.check("manual");
    expect(deps.fetchInfo).not.toHaveBeenCalled();
  });

  it("installs only a download whose sha256 and size match", async () => {
    const { deps, update } = setup();
    await update.check("launch");
    await update.install();
    expect(deps.download).toHaveBeenCalledWith(published, expect.any(Function));
    expect(deps.install).toHaveBeenCalledWith("/cache/friend-update/t3code-friend-bbbbbbbbbb.apk");
    expect(update.getSnapshot()).toMatchObject({ phase: { type: "idle" }, error: null });

    deps.inspect.mockResolvedValueOnce({ sha256: "d".repeat(64), size: published.size });
    await update.install();
    expect(deps.install).toHaveBeenCalledTimes(1);
    expect(update.getSnapshot().error).toContain("não confere");
  });

  it("downloads nothing when the user backs out of the first-install warning", async () => {
    const { deps, update } = setup();
    await update.check("launch");
    deps.confirmInstall.mockResolvedValueOnce(false);
    await update.install();
    expect(deps.download).not.toHaveBeenCalled();
    expect(update.getSnapshot()).toMatchObject({ phase: { type: "idle" }, error: null });
  });

  it("does nothing when the server has the running commit", async () => {
    const { deps, update } = setup();
    deps.fetchInfo.mockResolvedValueOnce({ latest: { ...published, commit: running.commit } });
    await update.check("launch");
    await update.install();
    expect(deps.download).not.toHaveBeenCalled();
  });
});
