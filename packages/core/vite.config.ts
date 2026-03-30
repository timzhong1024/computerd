import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
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
