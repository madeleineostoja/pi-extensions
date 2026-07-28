import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerImplementCommand } from "./command.js";

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

describe("/implement command Git boundary", () => {
  it("opens one run-oriented menu for an empty command", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      on() {},
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    };
    registerImplementCommand(pi as never, config);
    const root = mkdtempSync(join(tmpdir(), "pipkin-implement-menu-"));
    temporaryDirectories.add(root);
    const plan = join(root, "plan.md");
    writeFileSync(plan, "# Plan\n\n- [x] Finished\n");
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "plan.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "test"], { cwd: root });
    const selections = ["New run"];
    const menus: string[][] = [];
    const notifications: string[] = [];

    await handler!("", {
      cwd: root,
      hasUI: true,
      mode: "tui",
      ui: {
        input: async () => "plan.md",
        notify: (message: string) => notifications.push(message),
        select: async (_title: string, options: string[]) => {
          menus.push(options);
          return selections.shift();
        },
        setWidget() {},
      },
    });

    expect(menus).toEqual([["New run", "Close"]]);
    expect(menus.flat().every((item) => !item.includes("..."))).toBe(true);
    expect(notifications).toEqual([
      "All plan tasks are already checked; no run was created.",
    ]);
  });
});
