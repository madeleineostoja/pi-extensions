import { defineConfig } from "vitest/config";

const features = [
  "sandbox",
  "edit-approval",
  "guard",
  "context",
  "defaults",
  "ui",
  "personality",
  "lsp",
  "subagents",
  "papercuts",
  "handoff",
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
          name: "implement",
          include: ["src/extensions/implement/**/*.test.ts"],
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
