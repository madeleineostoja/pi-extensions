import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerImplementCommand, runMenuActions } from "./command.js";
import { assertRunCanResume } from "./run.js";

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
  it("offers direct resume for an active paused run", () => {
    expect(runMenuActions("paused", true)).toEqual([
      "Status",
      "Inspect",
      "Resume",
      "Stop",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("paused", false)).toEqual([
      "Status",
      "Inspect",
      "Resume",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("blocked_safety", false)).not.toContain("Resume");
  });

  it("rejects terminal runs before creating a resume actor", () => {
    expect(() => assertRunCanResume("completed")).toThrow("/implement cleanup");
    expect(() => assertRunCanResume("blocked_safety")).toThrow(
      "/implement cleanup",
    );
    expect(() => assertRunCanResume("paused")).not.toThrow();
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
