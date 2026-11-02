// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({ headless: true });
const evidence = JSON.parse(
  await (await import("node:fs/promises")).readFile("../evidence.json", "utf8"),
);
try {
  for (const [i, lib] of ["reactflow"].entries()) {
    const port = 4173 + i;
    const proc = spawn(
      "pnpm",
      ["exec", "vite", "preview", "--port", String(port), "--strictPort"],
      { cwd: new URL("../" + lib + "/", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise((resolve, reject) => {
        proc.stdout.on("data", (d) => {
          if (String(d).includes("Local:")) resolve();
        });
        proc.on("exit", reject);
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(2000);
      const errors = [],
        requests = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("request", (r) => {
        if (!r.url().startsWith("http://localhost")) requests.push(r.url());
      });
      await page.goto(`http://localhost:${port}`);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `../shots/${lib}-desktop.png` });
      const before = await page.locator("body").innerText();
      if (await page.getByRole("button", { name: "Bot patch" }).count())
        await page.getByRole("button", { name: "Bot patch" }).click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `../shots/${lib}-patch.png` });
      const after = await page.locator("body").innerText();
      const acceptance = {};
      const read = async () => JSON.parse(await page.locator("aside pre").innerText());
      const attempt = async (step, fn) => {
        try {
          await fn();
          acceptance[step] = { pass: true };
        } catch (e) {
          acceptance[step] = { pass: false, reason: String(e) };
        }
      };
      await attempt("a", async () => {
        const before = await read();
        const node = page.locator("article").getByText("detect new tag", { exact: false }).first();
        const box = await node.boundingBox({ timeout: 2000 });
        if (!box)
          throw Error(
            "No text hit target; native canvas requires coordinate calibration. Human dragging remains available.",
          );
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 150, { steps: 20 });
        await page.mouse.up();
        const after = await read();
        if (
          after.nodes.find((n) => n.id === "1").position.y ===
          before.nodes.find((n) => n.id === "1").position.y
        )
          throw Error("Drag did not change JSON position");
        if (!(await page.locator("aside").innerText()).includes("Graph valid"))
          throw Error("Graph invalid after drag");
      });
      await attempt("b", async () => {
        if (lib !== "reactflow") {
          await page.keyboard.press("r");
          await page.mouse.move(400, 550);
          await page.mouse.down();
          await page.mouse.move(540, 630, { steps: 10 });
          await page.mouse.up();
          throw Error(
            "Rectangle tool attempted; native canvas binding hit targets not calibrated. Human arrow tool remains available.",
          );
        }
        await page.getByRole("button", { name: "Add agent" }).click();
        const g = await read();
        const id = g.nodes.at(-1).id;
        const source = page.locator('[data-id="' + id + '"] .source');
        const target = page.locator('[data-id="7"] .target');
        await source.dragTo(target);
        const next = await read();
        const edge = next.edges.find((e) => e.from === id && e.to === "7");
        if (!edge) throw Error("Handle drag did not create bound edge");
        acceptance.newEdge = edge.id;
      });
      await attempt("c", async () => {
        if (!acceptance.newEdge) throw Error("Blocked: step b produced no bound edge");
        const point = await page
          .locator('[data-id="' + acceptance.newEdge + '"] .react-flow__edge-interaction')
          .evaluate((el) => {
            const p = el.getPointAtLength(el.getTotalLength() / 2);
            const q = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
            return { x: q.x, y: q.y };
          });
        await page.mouse.click(point.x, point.y);
        await page.locator(".react-flow").evaluate((el) => el.focus());
        await page.keyboard.press("Delete");
        if ((await read()).edges.some((e) => e.id === acceptance.newEdge))
          throw Error("Delete did not remove edge");
      });
      await attempt("d", async () => {
        const count = (await read()).edges.length;
        if (lib === "reactflow") {
          const source = page.locator(".react-flow__handle.source").last();
          const box = await source.boundingBox();
          await page.mouse.move(box.x + 2, box.y + 2);
          await page.mouse.down();
          await page.mouse.move(600, 700, { steps: 10 });
          await page.mouse.up();
        } else {
          await page.keyboard.press("a");
          await page.mouse.move(500, 600);
          await page.mouse.down();
          await page.mouse.move(650, 700, { steps: 10 });
          await page.mouse.up();
        }
        if ((await read()).edges.length !== count) throw Error("Edge count changed");
        if (!(await page.locator("aside").innerText()).includes("Graph valid"))
          throw Error("Graph invalid");
        acceptance.dReason = "dangling edge unrepresentable";
      });
      await attempt("e", async () => {
        const before = await read();
        await page.getByRole("button", { name: "Add note", exact: true }).click();
        const added = await read();
        if (
          JSON.stringify([before.nodes, before.edges]) !==
          JSON.stringify([added.nodes, added.edges])
        )
          throw Error("Strict graph changed");
        if (added.annotations.length !== 1) throw Error("Note missing");
        if (await page.locator(".react-flow__node-note .react-flow__handle").count())
          throw Error("Note has handles");
        await page.getByRole("button", { name: "Round trip", exact: true }).click();
        if (JSON.stringify((await read()).annotations) !== JSON.stringify(added.annotations))
          throw Error("Note lost");
      });
      await page.screenshot({ path: `../shots/${lib}-edited.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`http://localhost:${port}/?readonly=1`);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `../shots/${lib}-readonly.png` });
      evidence[lib] = { acceptance, errors, requests: [...new Set(requests)], before, after };
      await page.close();
    } finally {
      proc.kill("SIGTERM");
    }
  }
} finally {
  await browser.close();
  await writeFile("../evidence.json", JSON.stringify(evidence, null, 2));
}
