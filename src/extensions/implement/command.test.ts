import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  implementMenuActions,
  readImplementPlanExcerpt,
  registerImplementCommand,
  runMenuActions,
} from "./command.js";
import type { RunListing } from "./controls.js";
import type { RunState } from "./store.js";

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
  it("offers one top-level cleanup action for completed run history", () => {
    const runs = [
      {
        kind: "run",
        runId: "completed-1",
        state: { phase: "completed" } as RunState,
      },
      {
        kind: "run",
        runId: "failed-1",
        state: { phase: "failed" } as RunState,
      },
      { kind: "historical", runId: "legacy" },
      {
        kind: "run",
        runId: "completed-2",
        state: { phase: "completed" } as RunState,
      },
    ] satisfies RunListing[];

    expect(implementMenuActions(runs)).toEqual([
      "New run",
      "Clean completed runs (2)",
      "Close",
    ]);
    expect(implementMenuActions(runs.slice(1, 3))).toEqual([
      "New run",
      "Close",
    ]);
  });

  it("offers terminal and interrupted retained runs cleanup without continue", () => {
    expect(runMenuActions("failed", true)).toEqual([
      "Details",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("failed", false)).toEqual([
      "Details",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("incomplete", true)).toEqual([
      "Details",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("running", false)).toEqual([
      "Details",
      "Clean up",
      "Back",
    ]);
    expect(runMenuActions("stopping", false)).toEqual([
      "Details",
      "Clean up",
      "Back",
    ]);
  });

  it("uses only a bounded beginning of the root plan for session naming", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-command-"));
    temporaryDirectories.add(root);
    const plan = join(root, "plan.md");
    writeFileSync(
      plan,
      Array.from({ length: 100 }, (_, index) =>
        index === 0 ? "# Managed processes" : `line-${index}-${"x".repeat(5)}`,
      ).join("\n"),
    );

    const excerpt = await readImplementPlanExcerpt(root, "plan.md");

    expect(excerpt).toContain("# Managed processes");
    expect(excerpt).toContain("line-79-");
    expect(excerpt).not.toContain("line-80-");
    expect(excerpt.length).toBeLessThanOrEqual(4_000);
  });

  it("returns an all-checked plan as a no-op without allocating a run", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const setSessionName = vi.fn();
    const pi = {
      on() {},
      setSessionName,
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
    expect(setSessionName).not.toHaveBeenCalled();
  });
});
