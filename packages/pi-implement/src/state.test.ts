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
import { RunStore } from "./canonical-state.js";
import {
  getStatePaths,
  getBaseDir,
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
  sweepRunArtifacts,
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

function createCanonicalState(
  paths: ReturnType<typeof getStatePaths>,
  run: {
    runId: string;
    repoRoot: string;
    baseSha: string;
    maxConcurrency: number;
  },
  candidates: Array<{
    id: string;
    branchName: string;
    worktreePath: string;
    commitSha: string;
  }> = [],
): void {
  RunStore.create(paths.canonicalRunState!, {
    schemaVersion: 8,
    revision: 0,
    run: {
      id: run.runId,
      target: {
        checkoutRoot: run.repoRoot,
        gitDir: "git-dir",
        commonGitDir: "common-git-dir",
        branchRef: "main",
        startHead: run.baseSha,
      },
      plan: { path: "plan.md", hash: "hash", indexConvention: "zero-based" },
      configuredWorkerConcurrency: run.maxConcurrency,
      effectiveWorkerConcurrency: run.maxConcurrency,
    },
    graph: { tasks: [] },
    runtime: { phase: "completed", tasks: {}, overall: { phase: "completed" } },
    candidates: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        {
          ...candidate,
          sourceBaseSha: run.baseSha,
          baseSha: run.baseSha,
          treeSha: "tree",
          reviewReceipt: {
            id: `review:${candidate.id}`,
            candidateId: candidate.id,
            candidateCommitSha: candidate.commitSha,
            candidateTreeSha: "tree",
            verdict: "approved" as const,
            convergence: {
              round: 0,
              outstandingFindingIds: [],
              bestOutstandingCount: 0,
              evidenceRefs: [],
            },
            assessedAt: "2024-01-15T12:00:00Z",
          },
        },
      ]),
    ),
    taskExecution: {},
    taskMetadata: {},
    reviewConvergence: {},
    workerLeases: [],
    integrationAttempts: [],
    landingReceipts: [],
    projectionDebt: [],
    cleanupDebt: [],
    createdAt: "2024-01-15T12:00:00Z",
    updatedAt: "2024-01-15T12:00:00Z",
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("state paths", () => {
  it("computes correct paths", () => {
    const paths = getStatePaths("/repo", "r20240101-120000");
    const expectedBase = join("/repo", ".pi", "implement");
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

  it("bases state inside the repo", () => {
    expect(getBaseDir("/repo")).toBe(join("/repo", ".pi", "implement"));
  });
});

describe("run IDs", () => {
  it("generates readable collision-resistant run IDs", () => {
    const id = makeRunId(new Date("2024-01-15T09:30:45"));
    expect(id).toMatch(/^r20240115-093045-[a-f0-9]{16}$/);
  });

  it("does not repeat IDs generated in the same second", () => {
    const now = new Date("2024-01-15T09:30:45");
    const ids = new Set(Array.from({ length: 100 }, () => makeRunId(now)));
    expect(ids).toHaveLength(100);
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

  it("blocks on malformed locks without deleting them", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    mkdirSync(join(paths.baseDir, "locks"), { recursive: true });
    writeFileSync(
      paths.lockFile,
      JSON.stringify({ runId: "old-run", runDir: paths.runDir }),
      "utf-8",
    );

    expect(checkRunLock(paths)).toMatchObject({
      active: true,
      reason: expect.stringContaining("malformed lock file"),
    });
    expect(existsSync(paths.lockFile)).toBe(true);
  });

  it("blocks on unreadable lock content without deleting it", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    mkdirSync(join(paths.baseDir, "locks"), { recursive: true });
    writeFileSync(paths.lockFile, "not json", "utf-8");

    expect(checkRunLock(paths)).toMatchObject({
      active: true,
      reason: expect.stringContaining("unreadable lock file"),
    });
    expect(existsSync(paths.lockFile)).toBe(true);
  });

  it("atomically reserves a run ID across linked checkouts", () => {
    const repo = tempRepo();
    const checkoutA = join(repo, "checkout-a");
    const checkoutB = join(repo, "checkout-b");
    const runId = "r20240115-120000-deadbeefdeadbeef";
    const pathsA = getStatePaths(repo, runId, checkoutA);
    const pathsB = getStatePaths(repo, runId, checkoutB);
    const runA = { ...makeRun(repo, runId), checkoutRoot: checkoutA };
    const runB = { ...makeRun(repo, runId), checkoutRoot: checkoutB };

    expect(acquireRunLock(pathsA, runA)).toMatchObject({ ok: true });
    expect(acquireRunLock(pathsB, runB)).toMatchObject({ ok: false });
    expect(existsSync(pathsB.lockFile)).toBe(false);
  });
});

describe("task review state", () => {
  it("retains convergence state when later task updates omit it", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const task = {
      id: "t001-task",
      planIndex: 0,
      title: "Task",
      status: "needs_rework" as const,
      dependsOn: [],
      attempts: 1,
      integrationAttempts: 0,
      review: {
        lastDecision: "required" as const,
        convergence: {
          epoch: 1,
          closedEpochs: [],
          state: {
            round: 1,
            findings: [
              {
                id: "R1",
                summary: "Missing test",
                evidence: "No coverage",
                requiredChange: "Add coverage",
                acceptanceCriteria: ["Case is covered"],
                introducedRound: 0,
                origin: "initial" as const,
              },
            ],
            outstandingIds: ["R1"],
            bestOutstandingCount: 1,
            consecutiveStalledRounds: 0,
          },
        },
      },
    };
    writeTaskJson(paths, task.id, task);
    writeTaskJson(paths, task.id, {
      ...task,
      status: "reviewing",
      review: task.review,
    });

    expect(
      readTaskJson(paths, task.id)?.review?.convergence?.state.outstandingIds,
    ).toEqual(["R1"]);
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

  it("preserves durable candidate and convergence fields through partial task writes", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    writeTaskJson(paths, "t001-test", {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "needs_rework",
      dependsOn: [],
      attempts: 1,
      integrationAttempts: 0,
      candidateBaseSha: "base",
      candidateSha: "candidate",
      candidateTree: "tree",
      trustedCheckpoint: "candidate",
      branchName: "pi-implement/r/t001-test",
      worktreePath: "/worktree",
      discardedBundles: ["/bundle"],
      implementationRound: 2,
      lastTransition: { at: "now", phase: "reviewing" },
    });
    writeTaskJson(paths, "t001-test", {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "reviewing",
      dependsOn: [],
      attempts: 2,
      integrationAttempts: 0,
    });
    expect(readTaskJson(paths, "t001-test")).toMatchObject({
      candidateBaseSha: "base",
      candidateSha: "candidate",
      candidateTree: "tree",
      trustedCheckpoint: "candidate",
      branchName: "pi-implement/r/t001-test",
      worktreePath: "/worktree",
      discardedBundles: ["/bundle"],
      implementationRound: 2,
    });
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

  it("preserves the first source base SHA while allowing the branch base to advance", () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    writeTaskJson(paths, "t001-test", {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "coding",
      dependsOn: [],
      attempts: 0,
      integrationAttempts: 0,
      sourceBaseSha: "source-sha",
      baseSha: "source-sha",
    });
    writeTaskJson(paths, "t001-test", {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "coding",
      dependsOn: [],
      attempts: 1,
      integrationAttempts: 1,
      sourceBaseSha: "incorrect-replacement",
      baseSha: "rework-sha",
    });

    expect(readTaskJson(paths, "t001-test")).toMatchObject({
      sourceBaseSha: "source-sha",
      baseSha: "rework-sha",
    });
  });

  it("writes and reads task.json with reviewed metadata", () => {
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
      status: "approved" as const,
      dependsOn: [],
      attempts: 1,
      integrationAttempts: 0,
      review: {
        lastDecision: "reviewed" as const,
        lastReason: "approved by task reviewer",
        reviewedCount: 1,
      },
    };
    writeTaskJson(paths, "t001-test", task);

    const read = readTaskJson(paths, "t001-test");
    expect(read?.review).toEqual(task.review);
  });

  it("tolerates legacy skipped review metadata", () => {
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
    const legacyTask = {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "approved" as const,
      dependsOn: [],
      attempts: 1,
      integrationAttempts: 0,
      review: {
        lastDecision: "skipped" as const,
        lastReason: "legacy docs-only skip",
        skippedCount: 1,
      },
    };
    writeTaskJson(paths, "t001-test", legacyTask);

    const read = readTaskJson(paths, "t001-test");
    expect(read?.review).toEqual(legacyTask.review);
  });

  it("reads older task.json without review metadata as undefined", () => {
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
    const legacyTask = {
      id: "t001-test",
      planIndex: 0,
      title: "Test task",
      status: "pending" as const,
      dependsOn: [],
      attempts: 0,
      integrationAttempts: 0,
    };
    writeTaskJson(paths, "t001-test", legacyTask);

    const read = readTaskJson(paths, "t001-test");
    expect(read).toEqual(legacyTask);
    expect(read?.review).toBeUndefined();
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

  it("refuses legacy cleanup without canonical ownership", async () => {
    const repo = tempRepo();
    const paths = getStatePaths(repo, "r20240115-120000");
    const run = makeRun(repo);
    createRunState(paths, run, "# Plan\n");

    await expect(cleanupRun(paths)).rejects.toThrow(/canonical run state/i);
    expect(existsSync(paths.runDir)).toBe(true);
  });

  it(
    "removes registered worktrees and task branches during cleanup",
    { timeout: 15000 },
    async () => {
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
        strategyReason: "Planner recommended parallel.",
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
      createCanonicalState(paths, run, [
        {
          id: "candidate:t001-test",
          branchName,
          worktreePath,
          commitSha: run.baseSha,
        },
      ]);

      expect(git(repo, "worktree", "list", "--porcelain")).toContain(
        worktreePath,
      );
      expect(git(repo, "branch", "--list", branchName)).toContain(branchName);

      await cleanupRun(paths);

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

  it(
    "removes the retained overall-review worktree and branch during cleanup",
    { timeout: 15000 },
    async () => {
      const repo = tempRepo();
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test User");
      writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
      git(repo, "add", "README.md");
      git(repo, "commit", "-q", "-m", "chore: init");
      const paths = getStatePaths(repo, "r20240115-120000");
      const run = makeRun(repo);
      createRunState(paths, run, "# Plan\n");
      const branchName = "pi-implement/r20240115-120000/overall-review";
      const worktreePath = join(paths.worktreesDir, "overall-review");
      git(repo, "branch", branchName, "HEAD");
      git(repo, "worktree", "add", "-q", worktreePath, branchName);
      createCanonicalState(paths, run, [
        {
          id: "candidate:overall",
          branchName,
          worktreePath,
          commitSha: git(repo, "rev-parse", "HEAD").trim(),
        },
      ]);

      await cleanupRun(paths);

      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        worktreePath,
      );
      expect(git(repo, "branch", "--list", branchName)).not.toContain(
        branchName,
      );
    },
  );

  it(
    "sweepRunArtifacts deletes orphaned branches and worktrees with no run dir",
    { timeout: 15000 },
    async () => {
      const repo = tempRepo();
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test User");
      writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
      git(repo, "add", "README.md");
      git(repo, "commit", "-q", "-m", "chore: init");

      const orphanId = "r20240115-120000";
      const orphanPaths = getStatePaths(repo, orphanId);
      mkdirSync(orphanPaths.worktreesDir, { recursive: true });
      const orphanBranch = `pi-implement/${orphanId}/t001-orphan`;
      const orphanWorktree = join(orphanPaths.worktreesDir, "t001-orphan");
      git(repo, "branch", orphanBranch, "HEAD");
      git(repo, "worktree", "add", "-q", orphanWorktree, orphanBranch);
      // Intentionally do NOT create the run dir, simulating an already-removed run
      expect(existsSync(orphanPaths.runDir)).toBe(false);

      // A second run that still has its run dir must be left untouched, even
      // though its process is not alive — only a present run dir protects it.
      const liveId = "r20240115-130000";
      const livePaths = getStatePaths(repo, liveId);
      mkdirSync(livePaths.runDir, { recursive: true });
      mkdirSync(livePaths.worktreesDir, { recursive: true });
      const liveBranch = `pi-implement/${liveId}/t001-live`;
      const liveWorktree = join(livePaths.worktreesDir, "t001-live");
      git(repo, "branch", liveBranch, "HEAD");
      git(repo, "worktree", "add", "-q", liveWorktree, liveBranch);

      const result = await sweepRunArtifacts(repo);
      expect(result.worktrees).toBe(1);
      expect(result.branches).toBe(1);

      expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
        orphanWorktree,
      );
      expect(git(repo, "branch", "--list", orphanBranch)).not.toContain(
        orphanBranch,
      );
      expect(git(repo, "worktree", "list", "--porcelain")).toContain(
        liveWorktree,
      );
      expect(git(repo, "branch", "--list", liveBranch)).toContain(liveBranch);
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
