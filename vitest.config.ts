import { defineConfig } from "vitest/config";

const features = [
  "sandbox",
  "readonly",
  "context",
  "defaults",
  "ui",
  "personality",
  "guidance",
  "lsp",
  "processes",
  "subagents",
  "reference",
  "web",
  "papercuts",
  "btw",
];
const setupFiles = ["./test/support/isolate-agent-dir.ts"];

export default defineConfig({
  test: {
    projects: [
      ...features.map((name) => ({
        test: {
          name,
          include: [`src/extensions/${name}/**/*.test.ts`],
          setupFiles,
          environment: "node",
          globals: false,
        },
      })),
      {
        test: {
          name: "implement-unit",
          include: ["src/extensions/implement/**/*.test.ts"],
          exclude: ["src/extensions/implement/**/*.integration.test.ts"],
          setupFiles,
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "implement-integration",
          include: ["src/extensions/implement/**/*.integration.test.ts"],
          setupFiles,
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "lib",
          include: ["src/lib/**/*.test.ts"],
          setupFiles,
          environment: "node",
          globals: false,
        },
      },
      {
        test: {
          name: "bundle",
          include: ["test/bundle/**/*.test.ts"],
          setupFiles,
          environment: "node",
          globals: false,
          fileParallelism: false,
        },
      },
    ],
  },
});
