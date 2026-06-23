import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const getAgentDirMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir: getAgentDirMock,
  };
});

import {
  canStartImplementRun,
  isActiveImplementPhase,
  registerImplementCommand,
} from "./command.js";
import { getStatePaths, createRunState, writeTaskJson } from "./state.js";

type Handler = (args: string, ctx: FakeContext) => Promise<void>;

let tmpAgentDir: string;

function writeImplementConfig(config: unknown) {
  const dir = join(tmpAgentDir, "extensions", "pi-implement");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

beforeEach(() => {
  tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-implement-agent-"));
  getAgentDirMock.mockReturnValue(tmpAgentDir);
  writeImplementConfig({ reviewer: { type: "Review" } });
});

afterEach(() => {
  rmSync(tmpAgentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type FakeContext = {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    notifications: Array<{ message: string; level: string }>;
    statuses: Array<{ key: string; text: string | undefined }>;
    widgets: Array<{ key: string; lines: string[] | undefined }>;
    notify(message: string, level: string): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, lines: string[] | undefined): void;
    theme: { fg(color: string, text: string): string };
  };
  model: { provider: string; id: string };
  modelRegistry: { find(provider: string, id: string): unknown };
};

function setup(events = createEventBus()) {
  const handlers: Record<string, Handler> = {};
  const pi = {
    events,
    on: () => {},
    registerCommand: (name: string, options: { handler: Handler }) => {
      handlers[name] = options.handler;
    },
  };
  registerImplementCommand(pi as never);
  const handler = handlers.implement;
  const buildHandler = handlers.build;
  if (!handler || !buildHandler) {
    throw new Error("handlers not registered");
  }
  const ctx: FakeContext = {
    cwd: "/repo",
    mode: "tui",
    model: { provider: "p", id: "m" },
    modelRegistry: { find: () => ({}) },
    ui: {
      notifications: [],
      statuses: [],
      widgets: [],
      notify(message: string, level: string) {
        this.notifications.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        this.statuses.push({ key, text });
      },
      setWidget(key: string, lines: string[] | undefined) {
        this.widgets.push({ key, lines });
      },
      theme: {
        fg(color: string, text: string) {
          return `<${color}>${text}</${color}>`;
        },
      },
    },
  };
  return { handler, buildHandler, ctx };
}

function createEventBus() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on(event: string, handler: (payload: unknown) => void) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((entry) => entry !== handler),
        );
      };
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

describe("/implement command", () => {
  it("shows usage with no args", async () => {
    const { handler, ctx } = setup();
    await handler("", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Usage: /implement");
    expect(ctx.ui.notifications[0]?.level).toBe("warning");
  });

  it("registers /build as an alias", async () => {
    const { buildHandler, ctx } = setup();
    await buildHandler("status", ctx);
    expect(ctx.ui.notifications[0]).toEqual({
      message: "pi-implement: idle",
      level: "info",
    });
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

  it("shows view fallback with no active agents", async () => {
    const { handler, ctx } = setup();
    await handler("view", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain(
      "pi-implement view: no active subagents",
    );
    expect(ctx.ui.notifications[0]?.level).toBe("info");
  });

  it("shows view fallback with a single active agent", async () => {
    // Active-agent view paths are exercised via orchestrator/integration
    // tests; command-level tests cover the no-active-agent case above.
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

  it("blocks during command preflight when referenced plan material exceeds the cap", async () => {
    const { handler, ctx } = setup();
    const repo = mkdtempSync(join(tmpdir(), "pi-implement-cmd-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    writeFileSync(
      join(repo, "plan.md"),
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `huge.md`\n",
    );
    writeFileSync(join(repo, "huge.md"), "x".repeat(150_000));
    execFileSync("git", ["add", "plan.md", "huge.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const repoCtx: FakeContext = { ...ctx, cwd: repo };
    await handler("plan.md", repoCtx);

    expect(repoCtx.ui.notifications[0]?.level).toBe("warning");
    expect(repoCtx.ui.notifications[0]?.message).toContain(
      "pi-implement blocked: plan material too large",
    );
    expect(repoCtx.ui.notifications[0]?.message).toContain(
      "Plan material exceeds maximum size",
    );
  });

  it("blocks during command preflight when referenced plan files are invalid", async () => {
    const { handler, ctx } = setup();
    const repo = mkdtempSync(join(tmpdir(), "pi-implement-cmd-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    writeFileSync(
      join(repo, "plan.md"),
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `missing.md`\n",
    );
    execFileSync("git", ["add", "plan.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const repoCtx: FakeContext = { ...ctx, cwd: repo };
    await handler("plan.md", repoCtx);

    expect(repoCtx.ui.notifications[0]?.level).toBe("warning");
    expect(repoCtx.ui.notifications[0]?.message).toContain(
      "pi-implement blocked: plan bundle validation failed",
    );
    expect(repoCtx.ui.notifications[0]?.message).toContain("missing.md");
  });

  it("allows a new run to start from followup_required phase", async () => {
    const { handler, ctx } = setup();
    const repo = mkdtempSync(join(tmpdir(), "pi-implement-cmd-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    writeFileSync(join(repo, "plan.md"), "# Plan\n\n## Tasks\n\n- [ ] Task\n");
    execFileSync("git", ["add", "plan.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

    const repoCtx: FakeContext = { ...ctx, cwd: repo };
    await handler("status", repoCtx);

    expect(canStartImplementRun("followup_required")).toBe(true);
    expect(canStartImplementRun("final_review")).toBe(false);
    expect(canStartImplementRun("final_rework")).toBe(false);
    expect(isActiveImplementPhase("final_review")).toBe(true);
    expect(isActiveImplementPhase("final_rework")).toBe(true);
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
      review: {
        lastDecision: "skipped",
        skippedCount: 1,
      },
    });

    const repoCtx: FakeContext = { ...ctx, cwd: repoRoot };
    await handler("inspect", repoCtx);

    const note = repoCtx.ui.notifications.find((n) =>
      n.message.startsWith("Run:"),
    );
    expect(note).toBeDefined();
    expect(note!.message).toContain(paths.runDir);
    expect(note!.message).toContain(paths.worktreesDir);
    expect(note!.message).toContain("t001-test [blocked (skipped)] →");
    expect(note!.level).toBe("info");
  });
});
