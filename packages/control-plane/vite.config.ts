import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@computerd/core": resolve(import.meta.dirname, "../core/src/index.ts"),
    },
  },
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    emptyOutDir: false,
    target: "es2023",
  },
  test: {
    environment: "node",
    globals: true,
  },
});
