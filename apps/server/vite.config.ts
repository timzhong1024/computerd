import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@computerd/core": resolve(import.meta.dirname, "../../packages/core/src/index.ts"),
      "@computerd/control-plane": resolve(
        import.meta.dirname,
        "../../packages/control-plane/src/index.ts",
      ),
      "@computerd/mcp": resolve(import.meta.dirname, "../mcp/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    ssr: "src/index.ts",
    target: "node24",
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((moduleName) => `node:${moduleName}`),
        "dockerode",
      ],
      output: {
        entryFileNames: "server.js",
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
  },
});
