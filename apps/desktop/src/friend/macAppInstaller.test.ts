// @effect-diagnostics nodeBuiltinImport:off -- These tests build real bundles and zips on disk for the Node-boundary installer.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DESKTOP_UPDATE_ZIP_PATH, type MobileUpdateBuild } from "@t3tools/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import {
  bundlePathOf,
  checkDownloadUrl,
  download,
  install,
  MISMATCH_MESSAGE,
  type MacTools,
  swapBundle,
} from "./macAppInstaller.ts";

const APP = "T3 Code (Beta).app";

/** A temporary directory removed when the test ends. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  onTestFinished(() => NodeFSP.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A scratch home with an installed app and a "zip" (here: a directory the fake extract copies). */
async function setup(options: { readonly zipCommit?: string; readonly zipId?: string } = {}) {
  const root = await tempDir("t3-mac-installer-");
  const home = NodePath.join(root, "home");
  const applications = NodePath.join(root, "Applications");
  const workDir = NodePath.join(home, "Library", "Caches", "t3code-friend-update");
  await NodeFSP.mkdir(workDir, { recursive: true });
  await NodeFSP.mkdir(applications);

  const writeApp = async (dir: string, id: string, commit: string, marker: string) => {
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "id"), id);
    await NodeFSP.writeFile(NodePath.join(dir, "commit"), commit);
    await NodeFSP.writeFile(NodePath.join(dir, "marker"), marker);
  };
  const currentApp = NodePath.join(applications, APP);
  await writeApp(currentApp, "com.t3tools.t3code", "a".repeat(40), "old");

  const commit = "b".repeat(40);
  const payload = NodePath.join(root, "payload");
  await writeApp(
    NodePath.join(payload, APP),
    options.zipId ?? "com.t3tools.t3code",
    options.zipCommit ?? commit,
    "new",
  );
  const zip = NodePath.join(workDir, `${commit}.zip`);
  const zipBytes = NodeCrypto.randomBytes(2048);
  await NodeFSP.writeFile(zip, zipBytes);
  const build: MobileUpdateBuild = {
    commit,
    shortCommit: commit.slice(0, 10),
    commitDate: "2026-10-26T09:00:00-03:00",
    builtAt: "2026-10-26T12:10:00Z",
    size: zipBytes.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(zipBytes).digest("hex"),
  };
  const tools: MacTools = {
    extract: vi.fn(async (_zip: string, dir: string) => {
      await NodeFSP.cp(payload, dir, { recursive: true });
    }),
    bundleId: async (app) => NodeFSP.readFile(NodePath.join(app, "id"), "utf8"),
    bundleCommit: async (app) => NodeFSP.readFile(NodePath.join(app, "commit"), "utf8"),
    stripQuarantine: vi.fn(async () => {}),
  };
  const marker = () => NodeFSP.readFile(NodePath.join(currentApp, "marker"), "utf8");
  const run = (overrides: Partial<MobileUpdateBuild> = {}) =>
    install({
      zip,
      build: { ...build, ...overrides },
      currentApp,
      workDir,
      home,
      stamp: "20261026093015",
      tools,
    });
  return { root, home, currentApp, zip, build, tools, marker, run };
}

describe("install", () => {
  it("swaps in the new bundle and keeps the old one as a backup", async () => {
    const t = await setup();
    const { backup } = await t.run();
    expect(await t.marker()).toBe("new");
    expect(backup).toBe(NodePath.join(t.home, "t3-app-backup-20261026093015.app"));
    expect(await NodeFSP.readFile(NodePath.join(backup, "marker"), "utf8")).toBe("old");
    expect(t.tools.stripQuarantine).toHaveBeenCalledOnce();
    expect(NodeFS.existsSync(t.zip)).toBe(false);
  });

  it.each([
    ["sha256", { sha256: "0".repeat(64) }],
    ["size", { size: 1 }],
  ])("refuses a zip whose %s does not match and touches nothing", async (_name, overrides) => {
    const t = await setup();
    await expect(t.run(overrides)).rejects.toThrow(MISMATCH_MESSAGE);
    expect(t.tools.extract).not.toHaveBeenCalled();
    expect(await t.marker()).toBe("old");
    expect((await NodeFSP.readdir(t.home)).filter((name) => name.endsWith(".app"))).toEqual([]);
  });

  it.each([
    ["another app", { zipId: "com.example.other" }, "outro app"],
    ["another commit", { zipCommit: "c".repeat(40) }, "outro commit"],
  ])("refuses a zip holding %s", async (_name, options, message) => {
    const t = await setup(options);
    await expect(t.run()).rejects.toThrow(message);
    expect(await t.marker()).toBe("old");
  });

  it("keeps the two newest backups", async () => {
    const t = await setup();
    for (const stamp of ["20261020080000", "20261021080000", "20261022080000"]) {
      await NodeFSP.mkdir(NodePath.join(t.home, `t3-app-backup-${stamp}.app`));
    }
    await t.run();
    expect(
      (await NodeFSP.readdir(t.home)).filter((name) => name.endsWith(".app")).toSorted(),
    ).toEqual(["t3-app-backup-20261022080000.app", "t3-app-backup-20261026093015.app"]);
  });
});

describe("swapBundle", () => {
  it("puts the running bundle back when the new one cannot move in", async () => {
    const t = await setup();
    const missing = NodePath.join(t.root, "missing.app");
    const backup = NodePath.join(t.home, "t3-app-backup-20261026093015.app");
    await expect(swapBundle(t.currentApp, missing, backup)).rejects.toThrow();
    expect(await t.marker()).toBe("old");
    expect(NodeFS.existsSync(backup)).toBe(false);
  });
});

describe("download", () => {
  const build: MobileUpdateBuild = {
    commit: "d".repeat(40),
    shortCommit: "dddddddddd",
    commitDate: "2026-10-26T09:00:00-03:00",
    builtAt: "2026-10-26T12:10:00Z",
    size: 4,
    sha256: "e".repeat(64),
  };
  const url = new URL(`http://omarchy:3773${DESKTOP_UPDATE_ZIP_PATH}?commit=${build.commit}`);
  const fetchReturning = (response: Response) => vi.fn(async () => response) as typeof fetch;

  it("writes the zip and reports progress", async () => {
    const dir = await tempDir("t3-mac-download-");
    const onProgress = vi.fn();
    const path = await download({
      dir,
      url,
      build,
      onProgress,
      fetch: fetchReturning(new Response(new Uint8Array([1, 2, 3, 4]))),
    });
    expect(await NodeFSP.readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it.each([
    ["a newer publish", new Response("x", { status: 409 }), "outra versão foi publicada"],
    ["more bytes than published", new Response(new Uint8Array(8)), MISMATCH_MESSAGE],
  ])("stops on %s", async (_name, response, message) => {
    const dir = await tempDir("t3-mac-download-");
    await expect(
      download({ dir, url, build, onProgress: () => {}, fetch: fetchReturning(response) }),
    ).rejects.toThrow(message);
  });

  it.each([
    ["another path", `http://omarchy:3773/api/other?commit=${build.commit}`],
    ["another commit", `http://omarchy:3773${DESKTOP_UPDATE_ZIP_PATH}?commit=${"0".repeat(40)}`],
    ["a file URL", `file://${DESKTOP_UPDATE_ZIP_PATH}?commit=${build.commit}`],
  ])("downloads nothing from %s", (_name, raw) => {
    expect(() => checkDownloadUrl(raw, build)).toThrow("endereço de download inválido.");
  });
});

describe("bundlePathOf", () => {
  it("finds the .app around the executable", () => {
    expect(bundlePathOf(`/Applications/${APP}/Contents/MacOS/T3 Code (Beta)`)).toBe(
      `/Applications/${APP}`,
    );
    expect(bundlePathOf("/usr/bin/electron")).toBeNull();
  });
});
