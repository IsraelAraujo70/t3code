import { expect, it } from "@effect/vitest";

import { buildThemeExtension, parseColor, readSources, staleFiles, toHex } from "./vscode-theme.ts";

// Expected values are what Chromium paints for the same CSS.
it.each([
  ["oklch(97% 0 none)", "dark", "#f5f5f5"],
  ["oklch(0.488 0.217 264)", "light", "#1b4ed8"],
  ["color-mix(in srgb, oklch(14.5% 0 none) 97%, #fff)", "dark", "#111111"],
  [
    "color-mix(in oklab, oklch(70.7% 0.165 254.624) 50%, oklch(55.2% 0.016 285.938))",
    "light",
    "#668bbf",
  ],
  ["color-mix(in srgb, oklch(98.5% 0 0) 30%, oklch(21% 0.006 285.885))", "light", "#5c5c5e"],
  ["--alpha(#fff / 8%)", "dark", "#ffffff14"],
  ["rgb(37 63 99 / 20%)", "light", "#253f6333"],
  ["light-dark(#111, #eee)", "dark", "#eeeeee"],
] as const)("%s in %s is %s", (css, appearance, hex) => {
  expect(toHex(parseColor(css, appearance))).toBe(hex);
});

it("the committed VS Code theme matches the app's current palette", async () => {
  expect(staleFiles(buildThemeExtension(await readSources()))).toEqual([]);
});
