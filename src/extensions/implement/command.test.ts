import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerImplementCommand, runMenuActions } from "./command.js";

const config = {
  path: "/agent/pipkin/config.json",
  issues: [],
  config: {
    models: {
      utility: { model: "test/utility", thinking: "minimal" },
      low: { model: "test/low", thinking: "low" },
      medium: { model: "test/medium", thinking: "medium" },
      high: { model: "test/high", thinking: "high" },
    },
    implement: { workerConcurrency: 3 },
  },
} as const;

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("/implement command", () => {
  it("offers terminal and interrupted retained runs cleanup without continue", () => {
    expect(runMenuActions("failed", true)).toEqual([
      "Status",
      "Inspect",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("failed", false)).toEqual([
      "Status",
      "Inspect",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("incomplete", true)).toEqual([
      "Status",
      "Inspect",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("running", false)).toEqual([
      "Status",
      "Inspect",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("stopping", false)).toEqual([
      "Status",
      "Inspect",
      "Clean up",
      "Back",
    ]);
  });

  it("returns an all-checked plan as a no-op without allocating a run", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      on() {},
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    };
    registerImplementCommand(pi as never, config);
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-command-"));
    temporaryDirectories.add(root);
    const plan = join(root, "plan.md");
    writeFileSync(plan, "# Plan\n\n- [x] Finished\n");
    const notifications: Array<{ message: string; level: string }> = [];

    await handler!("plan.md", {
      cwd: root,
      mode: "print",
      ui: {
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
      },
    });

    expect(notifications).toEqual([
      {
        message: "All plan tasks are already checked; no run was created.",
        level: "info",
      },
    ]);
  });
});
