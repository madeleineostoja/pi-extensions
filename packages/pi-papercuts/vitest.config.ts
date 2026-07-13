import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude:
      process.env.PAPERCUT_WORKER_ROOT === undefined
        ? ["src/store-worker.test.ts"]
        : [],
  },
  resolve: {
    alias: {
      "@pi-extensions/lib": "../../lib/src/index.ts",
    },
  },
});
