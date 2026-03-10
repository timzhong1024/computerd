import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      external: (id) =>
        id.startsWith("node:") || id === "@computerd/core" || id === "playwright-core",
    },
    target: "es2023",
  },
  test: {
    environment: "node",
    globals: true,
  },
});
