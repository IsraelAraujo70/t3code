// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { react: fileURLToPath(new URL("./node_modules/react", import.meta.url)) } },
});
