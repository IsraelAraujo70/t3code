// @effect-diagnostics nodeBuiltinImport:off - the installer is synchronous file work in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { installThemeSync, THEME_EXTENSION_ID } from "./VsCodeTheme.ts";

const OTHER = { identifier: { id: "someone.other" }, relativeLocation: "someone.other-1.0.0" };

const withExtensionsDir = (run: (dir: string) => void) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-vscode-theme-"));
  try {
    run(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const read = (dir: string, name: string) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8");
interface Entry {
  readonly identifier: { readonly id: string };
  readonly relativeLocation: string;
}
const ourEntries = (dir: string) =>
  (JSON.parse(read(dir, "extensions.json")) as Entry[]).filter(
    (entry) => entry.identifier.id === THEME_EXTENSION_ID,
  );

it("installs once next to other extensions; installing again writes nothing", () =>
  withExtensionsDir((dir) => {
    NodeFS.writeFileSync(NodePath.join(dir, "extensions.json"), JSON.stringify([OTHER]));
    expect(installThemeSync(dir, 0)).toBe(true);
    const manifest = read(dir, "extensions.json");
    const listing = NodeFS.readdirSync(dir).toSorted();
    const [entry] = ourEntries(dir);
    expect(JSON.parse(manifest)[0]).toEqual(OTHER);
    expect(ourEntries(dir)).toHaveLength(1);
    const installed = JSON.parse(read(dir, `${entry!.relativeLocation}/package.json`));
    expect(installed.contributes.configurationDefaults["workbench.preferredDarkColorTheme"]).toBe(
      "T3 Dark",
    );

    expect(installThemeSync(dir, 0)).toBe(false);
    expect(read(dir, "extensions.json")).toBe(manifest);
    expect(NodeFS.readdirSync(dir).toSorted()).toEqual(listing);
  }));

it("replaces an older copy and revives one VS Code marked for deletion", () =>
  withExtensionsDir((dir) => {
    installThemeSync(dir, 0);
    const [current] = ourEntries(dir);
    const stale = `${THEME_EXTENSION_ID}-0.9.0-000000000000`;
    NodeFS.mkdirSync(NodePath.join(dir, stale));
    NodeFS.writeFileSync(
      NodePath.join(dir, "extensions.json"),
      JSON.stringify([OTHER, { identifier: { id: THEME_EXTENSION_ID }, relativeLocation: stale }]),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, ".obsolete"),
      JSON.stringify({ [current!.relativeLocation]: true, [OTHER.relativeLocation]: true }),
    );

    expect(installThemeSync(dir, 0)).toBe(true);
    expect(ourEntries(dir)).toMatchObject([{ relativeLocation: current!.relativeLocation }]);
    expect(JSON.parse(read(dir, "extensions.json"))[0]).toEqual(OTHER);
    expect(NodeFS.existsSync(NodePath.join(dir, stale))).toBe(false);
    expect(JSON.parse(read(dir, ".obsolete"))).toEqual({ [OTHER.relativeLocation]: true });
    expect(installThemeSync(dir, 0)).toBe(false);
  }));
