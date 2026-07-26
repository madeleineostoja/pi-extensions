import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pi-extensions/lib": "../../lib/src/index.ts",
    },
  },
});
