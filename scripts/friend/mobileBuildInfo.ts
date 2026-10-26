// @effect-diagnostics nodeBuiltinImport:off - app.config runs this before any Effect runtime exists.
/**
 * The commit a fork app is built from, so the app can compare itself with the build its server
 * publishes: `extra.friendBuild` in the APK (`apps/mobile/app.config.ts`) and `friendBuild` in the
 * Mac app's package.json (`scripts/build-desktop-artifact.ts`). The build scripts refuse a dirty
 * checkout, so HEAD is what the app contains.
 */
import * as NodeChildProcess from "node:child_process";

export interface FriendBuildInfo {
  /** Full sha. */
  readonly commit: string;
  /** Committer date, ISO 8601. */
  readonly commitDate: string;
}

/** HEAD of the checkout around `cwd`, or null outside a git checkout. */
export function readFriendBuildInfo(cwd: string = import.meta.dirname): FriendBuildInfo | null {
  try {
    const [commit, commitDate] = NodeChildProcess.execFileSync(
      "git",
      ["show", "-s", "--format=%H%n%cI", "HEAD"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n");
    return commit && commitDate ? { commit, commitDate } : null;
  } catch {
    return null;
  }
}
