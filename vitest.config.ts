import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pi-extensions/lib": `${root}lib/src/index.ts`,
    },
  },
  test: {
    isolate: false,
    projects: ["packages/*", "lib"],
    environment: "node",
    globals: false,
  },
});
