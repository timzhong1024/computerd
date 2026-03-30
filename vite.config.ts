import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  run: {
    cache: {
      scripts: true,
    },
  },
});
