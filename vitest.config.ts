import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: false,
    projects: ["packages/*"],
    environment: "node",
    globals: false,
  },
});
