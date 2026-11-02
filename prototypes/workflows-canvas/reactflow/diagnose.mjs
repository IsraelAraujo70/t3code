// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const p = spawn("pnpm", ["exec", "vite", "preview", "--port", "4180", "--strictPort"], {
  cwd: "../tldraw",
});
try {
  await new Promise((r) => p.stdout.on("data", r));
  const b = await chromium.launch();
  const page = await b.newPage();
  page.on("pageerror", (e) => console.log(String(e)));
  await page.goto("http://localhost:4180");
  await page.waitForTimeout(2000);
  console.log((await page.locator("body").innerText()).slice(0, 300));
  await b.close();
} finally {
  p.kill();
}
