import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { registerImplementCommand } from "./command.js";
import { getStatePaths, createRunState, writeTaskJson } from "./state.js";

type Handler = (args: string, ctx: FakeContext) => Promise<void>;

type FakeContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notifications: Array<{ message: string; level: string }>;
    statuses: Array<{ key: string; text: string | undefined }>;
    notify(message: string, level: string): void;
    setStatus(key: string, text: string | undefined): void;
  };
  model: { provider: string; id: string };
  modelRegistry: { find(provider: string, id: string): unknown };
};

function setup() {
  let handler: Handler | undefined;
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: () => {},
    registerCommand: (name: string, options: { handler: Handler }) => {
      if (name === "implement") {
        handler = options.handler;
      }
    },
  };
  registerImplementCommand(pi as never);
  if (!handler) {
    throw new Error("handler not registered");
  }
  const ctx: FakeContext = {
    cwd: "/repo",
    hasUI: true,
    model: { provider: "p", id: "m" },
    modelRegistry: { find: () => ({}) },
    ui: {
      notifications: [],
      statuses: [],
      notify(message: string, level: string) {
        this.notifications.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        this.statuses.push({ key, text });
      },
    },
  };
  return { handler, ctx };
}

describe("/implement command", () => {
  it("shows usage with no args", async () => {
    const { handler, ctx } = setup();
    await handler("", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Usage: /implement");
    expect(ctx.ui.notifications[0]?.level).toBe("warning");
  });

  it("reports idle status", async () => {
    const { handler, ctx } = setup();
    await handler("status", ctx);
    expect(ctx.ui.notifications[0]).toEqual({
      message: "pi-implement: idle",
      level: "info",
    });
  });

  it("shows usage for unknown flags", async () => {
    const { handler, ctx } = setup();
    await handler("--unknown plan.md", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Usage");
    expect(ctx.ui.notifications[0]?.level).toBe("warning");
  });

  it("shows usage for plan path with spaces", async () => {
    const { handler, ctx } = setup();
    await handler("path to plan.md", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Usage");
    expect(ctx.ui.notifications[0]?.level).toBe("warning");
  });

  it("shows usage for --parallel without integer", async () => {
    const { handler, ctx } = setup();
    await handler("--parallel abc plan.md", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("positive integer");
    expect(ctx.ui.notifications[0]?.level).toBe("warning");
  });

  it("inspect reports no run when idle and no history", async () => {
    const { handler, ctx } = setup();
    const repo = mkdtempSync(join(tmpdir(), "pi-implement-cmd-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    writeFileSync(join(repo, "f.md"), "# F\n");
    execFileSync("git", ["add", "f.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const repoCtx: FakeContext = { ...ctx, cwd: repo };
    await handler("inspect", repoCtx);
    expect(repoCtx.ui.notifications[0]).toEqual({
      message: "pi-implement inspect: no run found.",
      level: "info",
    });
  });

  it("inspect prints run dirs and task statuses from disk", async () => {
    const { handler, ctx } = setup();
    const repo = mkdtempSync(join(tmpdir(), "pi-implement-cmd-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    writeFileSync(join(repo, "f.md"), "# F\n");
    execFileSync("git", ["add", "f.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    // Resolve the real repo root so getStatePaths matches git.root()
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();

    const runId = "r20240115-120000";
    const paths = getStatePaths(repoRoot, runId);
    const run = {
      version: 1 as const,
      runId,
      mode: "auto" as const,
      strategyReason: "auto",
      repoRoot,
      planPath: join(repoRoot, "plan.md"),
      planHash: "abc",
      baseSha: "abc",
      currentPhase: "preflight",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };
    createRunState(paths, run, "# Plan\n");
    writeTaskJson(paths, "t001-test", {
      id: "t001-test",
      planIndex: 0,
      title: "Test",
      status: "blocked",
      dependsOn: [],
      attempts: 1,
      integrationAttempts: 0,
      worktreePath: join(paths.worktreesDir, "t001-test"),
      branchName: `pi-implement/${runId}/t001-test`,
    });

    const repoCtx: FakeContext = { ...ctx, cwd: repoRoot };
    await handler("inspect", repoCtx);

    const note = repoCtx.ui.notifications.find((n) =>
      n.message.startsWith("Run:"),
    );
    expect(note).toBeDefined();
    expect(note!.message).toContain(paths.runDir);
    expect(note!.message).toContain(paths.worktreesDir);
    expect(note!.message).toContain("t001-test [blocked] →");
    expect(note!.level).toBe("info");
  });
});
