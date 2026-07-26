import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerImplementCommand } from "./command.js";
import { assertVNextRunCanResume } from "./vnext-command.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("/implement VNext command", () => {
  it("rejects terminal runs before creating a resume actor", () => {
    expect(() => assertVNextRunCanResume("completed")).toThrow(":cleanup");
    expect(() => assertVNextRunCanResume("blocked_safety")).toThrow(":abandon");
    expect(() => assertVNextRunCanResume("paused")).not.toThrow();
  });

  it("returns an all-checked plan as a no-op without allocating a run", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      on() {},
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    };
    registerImplementCommand(pi as never);
    const root = mkdtempSync(join(tmpdir(), "pi-implement-command-"));
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
