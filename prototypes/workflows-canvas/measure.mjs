// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import fs from "node:fs";
import path from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
const result = {};
for (const lib of ["excalidraw", "reactflow", "tldraw"]) {
  const dir = new URL(lib + "/dist/assets/", import.meta.url);
  const groups = {
    js: [0, 0, 0],
    lazy: [0, 0, 0],
    css: [0, 0, 0],
    fonts: [0, 0, 0],
    other: [0, 0, 0],
  };
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const b = fs.readFileSync(new URL(f, dir));
    const key = f.endsWith(".js")
      ? "js"
      : f.endsWith(".css")
        ? "css"
        : /\.(woff2?|ttf|otf)$/.test(f)
          ? "fonts"
          : "other";
    const sizes = [b.length, gzipSync(b).length, brotliCompressSync(b).length];
    sizes.forEach((v, i) => (groups[key][i] += v));
    if (f.endsWith(".js") && !f.startsWith("index-"))
      sizes.forEach((v, i) => (groups.lazy[i] += v));
  }
  result[lib] = groups;
}
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync(new URL("measurements.json", import.meta.url), JSON.stringify(result, null, 2));
