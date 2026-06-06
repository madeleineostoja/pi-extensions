import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: false,
    projects: ["packages/*", "lib"],
    environment: "node",
    globals: false,
  },
});
