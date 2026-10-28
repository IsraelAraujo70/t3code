// @effect-diagnostics nodeBuiltinImport:off -- The installer streams the download to disk, renames whole app bundles and runs macOS tools at the Node boundary.
// @effect-diagnostics globalFetch:off -- The download streams to disk with progress from Electron's own fetch.
/**
 * Squirrel.Mac refuses unsigned bundles, so this swaps the verified `.app` in with two renames and
 * keeps the old one as `~/t3-app-backup-<timestamp>.app`, like `update-mac-app.sh`. Gatekeeper
 * only assesses quarantined files, and files this process writes carry no quarantine.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";
import * as NodeUtil from "node:util";

import { DESKTOP_UPDATE_ZIP_PATH, type MobileUpdateBuild } from "@t3tools/contracts";

/** A refusal the renderer shows as is. */
class SelfUpdateError extends Error {}

export const MISMATCH_MESSAGE =
  "o arquivo baixado não confere com o publicado. Nada foi instalado.";
const BACKUP_PATTERN = /^t3-app-backup-\d{12}(?:\d{2})?\.app$/;
const BACKUPS_KEPT = 2;

/** The `.app` around a macOS executable (`…/X.app/Contents/MacOS/X`), or null. */
export function bundlePathOf(execPath: string): string | null {
  const macOS = NodePath.dirname(execPath);
  const contents = NodePath.dirname(macOS);
  const bundle = NodePath.dirname(contents);
  return NodePath.basename(macOS) === "MacOS" &&
    NodePath.basename(contents) === "Contents" &&
    bundle.endsWith(".app")
    ? bundle
    : null;
}

/**
 * The zip route of the server the renderer checked, for this build only. The renderer builds the
 * URL because it holds the connection and its ticket; the main process downloads nothing else.
 */
export function checkDownloadUrl(raw: string, build: MobileUpdateBuild): URL {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== DESKTOP_UPDATE_ZIP_PATH ||
    url.searchParams.get("commit") !== build.commit
  ) {
    throw new SelfUpdateError("endereço de download inválido.");
  }
  return url;
}

/** Lowercase hex sha256 and byte size of a file. */
export async function inspectFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  for await (const chunk of NodeFS.createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), size };
}

/** Where the download of `build` lives inside `dir`. */
export const zipPathFor = (dir: string, build: MobileUpdateBuild) =>
  NodePath.join(dir, `${build.commit}.zip`);

/**
 * Downloads `url` into `dir` as `<commit>.zip`, replacing every earlier download. Stops as soon as
 * the server sends more than the manifest's size.
 */
export async function download(input: {
  readonly dir: string;
  readonly url: URL;
  readonly build: MobileUpdateBuild;
  readonly onProgress: (fraction: number | null) => void;
  readonly fetch?: typeof fetch;
}): Promise<string> {
  const { build } = input;
  await NodeFSP.rm(input.dir, { recursive: true, force: true });
  await NodeFSP.mkdir(input.dir, { recursive: true });
  const response = await (input.fetch ?? fetch)(input.url, { cache: "no-store" });
  if (response.status === 409) {
    throw new SelfUpdateError("outra versão foi publicada. Verifique de novo.");
  }
  if (response.status !== 200 || response.body === null) {
    throw new SelfUpdateError(`o servidor respondeu ${response.status}.`);
  }
  const partial = `${zipPathFor(input.dir, build)}.part`;
  let received = 0;
  let reported = -1;
  const counter = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > build.size) {
        callback(new SelfUpdateError(MISMATCH_MESSAGE));
        return;
      }
      const percent = Math.floor((received / build.size) * 100);
      if (percent !== reported) {
        reported = percent;
        input.onProgress(received / build.size);
      }
      callback(null, chunk);
    },
  });
  await NodeStreamPromises.pipeline(
    // DOM and Node type the same web stream differently.
    NodeStream.Readable.fromWeb(response.body as NodeStreamWeb.ReadableStream<Uint8Array>),
    counter,
    NodeFS.createWriteStream(partial),
  );
  const path = zipPathFor(input.dir, build);
  await NodeFSP.rename(partial, path);
  return path;
}

/** The macOS steps, replaced in tests. */
export interface MacTools {
  /** Extracts a zip made by electron-builder (symlinks and modes intact) into `dir`. */
  readonly extract: (zip: string, dir: string) => Promise<void>;
  readonly bundleId: (app: string) => Promise<string>;
  /** `friendBuild.commit` from the bundle's app package.json, or null without one. */
  readonly bundleCommit: (app: string) => Promise<string | null>;
  readonly stripQuarantine: (app: string) => Promise<void>;
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** The real tools. Electron's own fs reads inside the new bundle's app.asar. */
export const macTools: MacTools = {
  extract: async (zip, dir) => {
    await execFile("/usr/bin/ditto", ["-x", "-k", zip, dir]);
  },
  bundleId: async (app) => {
    const { stdout } = await execFile("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      NodePath.join(app, "Contents", "Info.plist"),
    ]);
    return stdout.trim();
  },
  bundleCommit: async (app) => {
    // Electron's asar support covers the synchronous fs API for sure.
    const raw = NodeFS.readFileSync(
      NodePath.join(app, "Contents", "Resources", "app.asar", "package.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("friendBuild" in parsed)) return null;
    const build = parsed.friendBuild;
    return typeof build === "object" &&
      build !== null &&
      "commit" in build &&
      typeof build.commit === "string"
      ? build.commit
      : null;
  },
  stripQuarantine: async (app) => {
    await execFile("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]);
  },
};

/** `YYYYMMDDHHMMSS` in local time, like the backups `update-mac-app.sh` names. */
export function backupStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Puts `next` where `current` is and `current` at `backup`; on failure `current` is back. */
export async function swapBundle(current: string, next: string, backup: string): Promise<void> {
  await NodeFSP.rename(current, backup);
  try {
    await NodeFSP.rename(next, current);
  } catch (error) {
    await NodeFSP.rename(backup, current);
    throw error;
  }
}

/** Keeps the newest `BACKUPS_KEPT` backups in `home`. */
async function pruneBackups(home: string): Promise<void> {
  const names = (await NodeFSP.readdir(home)).filter((name) => BACKUP_PATTERN.test(name));
  for (const name of names.toSorted().toReversed().slice(BACKUPS_KEPT)) {
    const path = NodePath.join(home, name);
    if ((await NodeFSP.lstat(path)).isDirectory()) {
      await NodeFSP.rm(path, { recursive: true, force: true });
    }
  }
}

/**
 * Installs the verified zip over `currentApp`. Every check runs before the running bundle moves;
 * the swap itself is two renames on one volume.
 */
export async function install(input: {
  readonly zip: string;
  readonly build: MobileUpdateBuild;
  readonly currentApp: string;
  /** Scratch directory on the same volume as `currentApp`. */
  readonly workDir: string;
  readonly home: string;
  /** `backupStamp` of now. */
  readonly stamp: string;
  readonly tools: MacTools;
}): Promise<{ readonly backup: string }> {
  const { build, currentApp } = input;
  const file = await inspectFile(input.zip);
  if (file.sha256 !== build.sha256 || file.size !== build.size) {
    throw new SelfUpdateError(MISMATCH_MESSAGE);
  }
  const stage = NodePath.join(input.workDir, `stage-${build.commit}`);
  await NodeFSP.rm(stage, { recursive: true, force: true });
  await NodeFSP.mkdir(stage, { recursive: true });
  await input.tools.extract(input.zip, stage);
  const apps = (await NodeFSP.readdir(stage)).filter((name) => name.endsWith(".app"));
  const name = NodePath.basename(currentApp);
  if (apps.length !== 1 || apps[0] !== name) {
    throw new SelfUpdateError(`o zip não traz só o ${name}. Nada foi instalado.`);
  }
  const next = NodePath.join(stage, name);
  const [nextId, currentId] = await Promise.all([
    input.tools.bundleId(next),
    input.tools.bundleId(currentApp),
  ]);
  if (nextId !== currentId) {
    throw new SelfUpdateError(`o zip traz outro app (${nextId}). Nada foi instalado.`);
  }
  if ((await input.tools.bundleCommit(next)) !== build.commit) {
    throw new SelfUpdateError("o app do zip é de outro commit. Nada foi instalado.");
  }
  await input.tools.stripQuarantine(next);

  const backup = NodePath.join(input.home, `t3-app-backup-${input.stamp}.app`);
  const [appVolume, stageVolume, homeVolume] = await Promise.all([
    NodeFSP.stat(NodePath.dirname(currentApp)),
    NodeFSP.stat(stage),
    NodeFSP.stat(input.home),
  ]);
  if (appVolume.dev !== stageVolume.dev || appVolume.dev !== homeVolume.dev) {
    throw new SelfUpdateError("o app não está no mesmo volume da pasta de usuário.");
  }
  if (NodeFS.existsSync(backup)) {
    throw new SelfUpdateError("já existe um backup com este horário. Tente de novo.");
  }
  await swapBundle(currentApp, next, backup);
  await NodeFSP.rm(stage, { recursive: true, force: true });
  await NodeFSP.rm(input.zip, { force: true });
  await pruneBackups(input.home).catch(() => undefined);
  return { backup };
}
