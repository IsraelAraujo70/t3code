import { defineConfig } from "vite-plus";
import "vite-plus/test/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
