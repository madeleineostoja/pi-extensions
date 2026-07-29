import { defineConfig } from "vitest/config";

const features = [
  "guard",
  "readonly",
  "shell-guard",
  "context",
  "defaults",
  "ui",
  "personality",
  "lsp",
  "subagents",
  "papercuts",
  "btw",
  "caffeinate",
];

export default defineConfig({
  test: {
    projects: [
      ...features.map((name) => ({
        test: {
          name,
          include: [`src/extensions/${name}/**/*.test.ts`],
          environment: "node",
          globals: false,
        },
      })),
      {
        test: {
          name: "implement-unit",
          include: ["src/extensions/implement/**/*.test.ts"],
          exclude: [
            "src/extensions/implement/**/*.integration.test.ts",
            "src/extensions/implement/**/*.e2e.test.ts",
          ],
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "implement-integration",
          include: ["src/extensions/implement/**/*.integration.test.ts"],
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "implement-e2e",
          include: ["src/extensions/implement/**/*.e2e.test.ts"],
          environment: "node",
          globals: false,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.mjs"],
          environment: "node",
          globals: false,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "lib",
          include: ["src/lib/**/*.test.ts"],
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "bundle",
          include: ["test/bundle/**/*.test.ts"],
          environment: "node",
          globals: false,
          fileParallelism: false,
        },
      },
    ],
  },
});
