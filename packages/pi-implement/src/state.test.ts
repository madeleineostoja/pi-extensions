import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  getStatePaths,
  getBaseDir,
  encodeRepoRoot,
  makeRunId,
  makeRunIdWithSuffix,
  taskIdFromTask,
  createRunState,
  writeRunJson,
  writeTaskJson,
  appendEvent,
  readEvents,
  readRunJson,
  readTaskJson,
  cleanupRun,
  listRunIds,
  acquireRunLock,
  checkRunLock,
  checkRunLocks,
  releaseRunLock,
} from "./state.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "pi-implement-state-"));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("state paths", () => {
  it("computes correct paths", () => {
    const paths = getStatePaths("/repo", "r20240101-120000");
    const expectedBase = join(getAgentDir(), "pi-implement", "--repo--");
    expect(paths.baseDir).toBe(expectedBase);
    expect(paths.runDir).toBe(join(expectedBase, "runs", "r20240101-120000"));
    expect(paths.runJson).toBe(
      join(expectedBase, "runs", "r20240101-120000", "run.json"),
    );
    expect(paths.eventsJsonl).toBe(
      join(expectedBase, "runs", "r20240101-120000", "events.jsonl"),
    );
    expect(paths.planSnapshot).toBe(
      join(expectedBase, "runs", "r20240101-120000", "plan.snapshot.md"),
    );
    expect(paths.tasksDir).toBe(
      join(expectedBase, "runs", "r20240101-120000", "tasks"),
    );
    expect(paths.worktreesDir).toBe(
      join(expectedBase, "worktrees", "r20240101-120000"),
    );
    expect(paths.locksDir).toBe(join(expectedBase, "locks"));
    expect(paths.lockFile).toMatch(
      new RegExp(
        `${escapeRegExp(join(expectedBase, "locks"))}[/\\\\]checkout-[a-f0-9]{16}\\.lock$`,
      ),
    );
  });

  it("encodes repo root into the base dir", () => {
    expect(encodeRepoRoot("/repo")).toBe("repo");
    expect(getBaseDir("/repo")).toBe(
      join(getAgentDir(), "pi-implement", "--repo--"),
    );
  });
});

describe("run IDs", () => {
  it("generates RFC-shaped run IDs", () => {
    const id = makeRunId(new Date("2024-01-15T09:30:45"));
    expect(id).toBe("r20240115-093045");
  });

  it("adds suffix on collision", () => {
    const existing = new Set(["r20240115-093045"]);
    const id = makeRunIdWithSuffix("r20240115-093045", existing);
    expect(id).toBe("r20240115-093045-1");
  });

  it("increments suffix until unique", () => {
    const existing = new Set(["r20240115-093045", "r20240115-093045-1"]);
    const id = makeRunIdWithSuffix("r20240115-093045", existing);
    expect(id).toBe("r20240115-093045-2");
  });
});

describe("task IDs", () => {
  it("generates deterministic task IDs", () => {
    expect(taskIdFromTask(0, "Add user model")).toBe("t001-add-user-model");
    expect(taskIdFromTask(1, "Fix the bug")).toBe("t002-fix-the-bug");
  });

  it("handles special characters", () => {
    expect(taskIdFromTask(0, "Add [user] model!")).toBe("t001-add-user-model");
  });

  it("falls back for empty title", () => {
    expect(taskIdFromTask(0, "")).toBe("t001-task");
  });
});

function makeRun(repo: string, runId = "r20240115-120000") {
  return {
    version: 1 as const,
    runId,
    mode: "auto" as const,
    strategyReason: "Auto mode selected; effective max concurrency 3.",
    repoRoot: repo,
    planPath: "/repo/plan.md",
    planHash: "abc123",
    baseSha: "def456",
    currentPhase: "preflight",
    maxConcurrency: 3,
    startedAt: "2024-01-15T12:00:00Z",
    updatedAt: "2024-01-15T12:00:00Z",
  };
}

describe("run locks", () => {
  it("acquires and releases the run lock", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = makeRun(repo);

    expect(acquireRunLock(paths, run)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(paths.lockFile, "utf-8"))).toMatchObject({
      runId: run.runId,
      pid: process.pid,
    });
    expect(acquireRunLock(paths, run)).toMatchObject({ ok: false });

    releaseRunLock(paths, run.runId);

    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it("uses separate locks for separate checkouts", () => {
    const repo = tempRepo();
    const checkoutA = join(repo, "checkout-a");
    const checkoutB = join(repo, "checkout-b");
    const pathsA = getStatePaths(repo, "r20240115-120000", checkoutA);
    const pathsB = getStatePaths(repo, "r20240115-120001", checkoutB);
    const runA = { ...makeRun(repo), checkoutRoot: checkoutA };
    const runB = {
      ...makeRun(repo, "r20240115-120001"),
      checkoutRoot: checkoutB,
    };

    expect(pathsA.lockFile).not.toBe(pathsB.lockFile);
    expect(acquireRunLock(pathsA, runA)).toMatchObject({ ok: true });
    expect(acquireRunLock(pathsB, runB)).toMatchObject({ ok: true });
    expect(acquireRunLock(pathsA, runA)).toMatchObject({ ok: false });

    const locks = checkRunLocks(pathsA);
    expect(locks.active).toHaveLength(2);
    expect(locks.active.map((entry) => entry.reason).join("\n")).toContain(
      `checkout ${checkoutA}`,
    );
    expect(locks.active.map((entry) => entry.reason).join("\n")).toContain(
      `checkout ${checkoutB}`,
    );
  });

  it("removes stale locks from dead processes", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    mkdirSync(join(paths.baseDir, "locks"), { recursive: true });
    writeFileSync(
      paths.lockFile,
      JSON.stringify({
        version: 1,
        runId: "old-run",
        runDir: "/missing",
        startedAt: "2024-01-15T12:00:00Z",
        pid: 99999999,
        hostname: hostname(),
      }),
      "utf-8",
    );

    const check = checkRunLock(paths);

    expect(check).toMatchObject({ active: false });
    expect(check.active === false && check.staleRemoved).toContain(
      "process 99999999",
    );
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it("treats legacy pid-less locks as stale", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    mkdirSync(join(paths.baseDir, "locks"), { recursive: true });
    writeFileSync(
      paths.lockFile,
      JSON.stringify({ runId: "old-run", runDir: paths.runDir }),
      "utf-8",
    );

    expect(checkRunLock(paths)).toMatchObject({ active: false });
    expect(existsSync(paths.lockFile)).toBe(false);
  });
});

describe("run state lifecycle", () => {
  it("creates run state with all files", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = {
      version: 1 as const,
      runId: "r20240115-120000",
      mode: "auto" as const,
      strategyReason: "Auto mode selected; effective max concurrency 3.",
      repoRoot: repo,
      planPath: "/repo/plan.md",
      planHash: "abc123",
      baseSha: "def456",
      currentPhase: "preflight",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };

    createRunState(paths, run, "# Plan\n");

    expect(existsSync(paths.runJson)).toBe(true);
    expect(existsSync(paths.planSnapshot)).toBe(true);
    expect(existsSync(paths.eventsJsonl)).toBe(true);
    expect(existsSync(paths.tasksDir)).toBe(true);
    expect(existsSync(paths.worktreesDir)).toBe(true);
    expect(existsSync(paths.lockFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.lockFile, "utf-8"))).toMatchObject({
      runId: "r20240115-120000",
      runDir: paths.runDir,
      startedAt: "2024-01-15T12:00:00Z",
    });
  });

  it("writes and reads run.json", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = {
      version: 1 as const,
      runId: "r20240115-120000",
      mode: "auto" as const,
      strategyReason: "Auto mode selected; effective max concurrency 3.",
      repoRoot: repo,
      planPath: "/repo/plan.md",
      planHash: "abc123",
      baseSha: "def456",
      currentPhase: "coding",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };

    createRunState(paths, run, "# Plan\n");
    writeRunJson(paths, { ...run, currentPhase: "reviewing" });

    const read = readRunJson(paths);
    expect(read?.currentPhase).toBe("reviewing");
  });

  it("writes and reads task.json", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = {
      version: 1 as const,
      runId: "r20240115-120000",
      mode: "auto" as const,
      strategyReason: "Auto mode selected; effective max concurrency 3.",
      repoRoot: repo,
      planPath: "/repo/plan.md",
      planHash: "abc123",
      baseSha: "def456",
      currentPhase: "preflight",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };

    createRunState(paths, run, "# Plan\n");
    const task = {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "pending" as const,
      dependsOn: [],
      attempts: 0,
      integrationAttempts: 0,
    };
    writeTaskJson(paths, "t001-test", task);

    const read = readTaskJson(paths, "t001-test");
    expect(read).toEqual(task);
  });

  it("appends and reads events", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = {
      version: 1 as const,
      runId: "r20240115-120000",
      mode: "auto" as const,
      strategyReason: "Auto mode selected; effective max concurrency 3.",
      repoRoot: repo,
      planPath: "/repo/plan.md",
      planHash: "abc123",
      baseSha: "def456",
      currentPhase: "preflight",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };

    createRunState(paths, run, "# Plan\n");
    appendEvent(paths, {
      type: "strategy_selected",
      reason: "auto",
      mode: "auto",
    });
    appendEvent(paths, { type: "task_started", taskId: "t001" });
    appendEvent(paths, {
      type: "task_approved",
      taskId: "t001",
      commitSha: "abc",
    });
    appendEvent(paths, {
      type: "integration_failed",
      taskId: "t001",
      reason: "hook",
    });
    appendEvent(paths, {
      type: "task_landed",
      taskId: "t001",
      commitSha: "def",
    });
    appendEvent(paths, { type: "cleanup_failed", reason: "busy" });

    const events = readEvents(paths);
    expect(events).toHaveLength(6);
    expect(events[0].type).toBe("strategy_selected");
    expect(events[1].type).toBe("task_started");
    expect(events[2].type).toBe("task_approved");
    expect(events[3].type).toBe("integration_failed");
    expect(events[4].type).toBe("task_landed");
    expect(events[5].type).toBe("cleanup_failed");
    expect(events[0].timestamp).toBeDefined();
  });

  it("cleans up run directory", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = {
      version: 1 as const,
      runId: "r20240115-120000",
      mode: "auto" as const,
      strategyReason: "Auto mode selected; effective max concurrency 3.",
      repoRoot: repo,
      planPath: "/repo/plan.md",
      planHash: "abc123",
      baseSha: "def456",
      currentPhase: "preflight",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };

    createRunState(paths, run, "# Plan\n");
    expect(existsSync(paths.runDir)).toBe(true);
    expect(existsSync(paths.lockFile)).toBe(true);

    cleanupRun(paths);
    expect(existsSync(paths.runDir)).toBe(false);
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it(
    "removes registered worktrees and task branches during cleanup",
    { timeout: 15000 },
    () => {
      const repo = tempRepo();
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test User");
      writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
      git(repo, "add", "README.md");
      git(repo, "commit", "-q", "-m", "chore: init");

      const paths = getStatePaths(repo, "r20240115-120000");
      const run = {
        version: 1 as const,
        runId: "r20240115-120000",
        mode: "parallel" as const,
        strategyReason: "Parallel mode requested.",
        repoRoot: repo,
        planPath: join(repo, "plan.md"),
        planHash: "abc123",
        baseSha: git(repo, "rev-parse", "HEAD").trim(),
        currentPhase: "preflight",
        maxConcurrency: 3,
        startedAt: "2024-01-15T12:00:00Z",
        updatedAt: "2024-01-15T12:00:00Z",
      };
      createRunState(paths, run, "# Plan\n");
      const branchName = "pi-implement/r20240115-120000/t001-test";
      const worktreePath = join(paths.worktreesDir, "t001-test");
      git(repo, "branch", branchName, run.baseSha);
      git(repo, "worktree", "add", "-q", worktreePath, branchName);
      writeTaskJson(paths, "t001-test", {
        id: "t001-test",
        planIndex: 0,
        title: "Test",
        status: "approved",
        dependsOn: [],
        attempts: 1,
        integrationAttempts: 0,
        baseSha: run.baseSha,
        worktreePath,
        branchName,
      });

      expect(git(repo, "worktree", "list", "--porcelain")).toContain(
        worktreePath,
      );
      expect(git(repo, "branch", "--list", branchName)).toContain(branchName);

      cleanupRun(paths);

      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        worktreePath,
      );
      expect(git(repo, "branch", "--list", branchName)).not.toContain(
        branchName,
      );
      expect(existsSync(paths.runDir)).toBe(false);
      expect(existsSync(paths.lockFile)).toBe(false);
    },
  );

  it("lists run IDs", () => {
    const repo = tempRepo();
    const paths1 = getStatePaths(repo, "r20240115-120000");
    const paths2 = getStatePaths(repo, "r20240115-130000");
    const run = {
      version: 1 as const,
      runId: "r20240115-120000",
      mode: "auto" as const,
      strategyReason: "Auto mode selected; effective max concurrency 3.",
      repoRoot: repo,
      planPath: "/repo/plan.md",
      planHash: "abc123",
      baseSha: "def456",
      currentPhase: "preflight",
      maxConcurrency: 3,
      startedAt: "2024-01-15T12:00:00Z",
      updatedAt: "2024-01-15T12:00:00Z",
    };

    createRunState(paths1, run, "# Plan\n");
    createRunState(paths2, { ...run, runId: "r20240115-130000" }, "# Plan\n");

    const ids = listRunIds(repo);
    expect(ids.sort()).toEqual(["r20240115-120000", "r20240115-130000"]);
  });
});
