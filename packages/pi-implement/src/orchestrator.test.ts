import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runImplementation, BlockedError } from "./orchestrator.js";
import { writeGraphJson } from "./graph.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SpawnArgs, SubagentClient, SubagentResult } from "./subagents.js";
import type { RunState } from "./status.js";

class FakeGit implements GitClient {
  commits: string[] = [];
  worktreeCommits: string[] = [];
  statusText = "";
  headValue = "h1";
  worktreeHeadValue = "h1";
  diffText = "diff --git a/file.ts b/file.ts";
  createdBranches: string[] = [];
  addedWorktrees: { path: string; branch: string }[] = [];
  removedWorktrees: string[] = [];
  deletedBranches: string[] = [];
  worktreeChild: FakeGit | undefined;

  async root() {
    return "/repo";
  }
  async head() {
    return this.headValue;
  }
  async status() {
    return this.statusText;
  }
  async isClean() {
    return this.statusText.trim() === "";
  }
  async isCleanExcept() {
    return this.statusText.trim() === "";
  }
  async stageAllExcept() {}
  async hasStagedChanges() {
    return true;
  }
  async stagedDiffStat() {
    return " file.ts | 1 +";
  }
  async stagedNameStatus() {
    return "M\tfile.ts";
  }
  async stagedDiff() {
    return this.diffText;
  }
  worktreeFingerprintText = "worktree";
  restoredFromIndex = 0;
  restoredPatches: string[] = [];
  addWorktreeError?: Error;
  async stagedFingerprint() {
    return `${this.diffText}:${this.statusText}`;
  }
  async worktreeFingerprintExcept() {
    return this.worktreeFingerprintText;
  }
  async restoreWorktreeFromIndexExcept() {
    this.restoredFromIndex++;
    this.worktreeFingerprintText = "worktree";
  }
  async restoreStagedPatch(patch: string) {
    this.restoredPatches.push(patch);
    this.worktreeFingerprintText = "worktree";
  }
  async commit(message: string): Promise<CommandResult> {
    this.commits.push(message);
    this.headValue = `${this.headValue}-commit-${this.commits.length}`;
    return { command: "git commit", exitCode: 0, stdout: "", stderr: "" };
  }
  async reset() {}
  async resetHard(commitSha: string) {
    this.headValue = commitSha;
  }
  async cherryPickNoCommit(commitSha: string): Promise<CommandResult> {
    this.diffText = `diff --git a/${commitSha} b/${commitSha}`;
    return {
      command: "git cherry-pick --no-commit",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
  async cherryPickAbort() {}
  async createTaskBranch(branchName: string, _baseSha: string) {
    this.createdBranches.push(branchName);
  }
  async addWorktree(worktreePath: string, branchName: string) {
    if (this.addWorktreeError) {
      throw this.addWorktreeError;
    }
    this.addedWorktrees.push({ path: worktreePath, branch: branchName });
  }
  async removeWorktree(worktreePath: string) {
    this.removedWorktrees.push(worktreePath);
  }
  async deleteTaskBranch(branchName: string) {
    this.deletedBranches.push(branchName);
  }
  forWorktree(_worktreePath: string): GitClient {
    if (!this.worktreeChild) {
      this.worktreeChild = new FakeGit();
      this.worktreeChild.headValue = this.headValue;
    }
    return this.worktreeChild;
  }
}

class FakeSubagents implements SubagentClient {
  spawns: SpawnArgs[] = [];
  results: SubagentResult[] = [];

  async probe() {
    return { ok: true as const };
  }
  async spawn(args: SpawnArgs) {
    this.spawns.push(args);
    return `agent-${this.spawns.length}`;
  }
  async stop() {}
  async waitFor(_id?: string, _signal?: AbortSignal) {
    const result = this.results.shift();
    if (!result) {
      throw new Error("missing fake result");
    }
    return result;
  }
}

const GOOD_IMPL =
  '<pi-implement-result>{"summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"feat: do thing"}</pi-implement-result>';
const GOOD_REVIEW =
  '<pi-review-result>{"verdict":"approved"}</pi-review-result>';
const GOOD_INTEGRATION_REVIEW =
  '<pi-integration-review-result>{"verdict":"approved"}</pi-integration-review-result>';

function makePaths(dir: string) {
  return {
    baseDir: join(dir, ".pi", "implement"),
    runDir: join(dir, ".pi", "implement", "runs", "r1"),
    runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
    eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
    planSnapshot: join(
      dir,
      ".pi",
      "implement",
      "runs",
      "r1",
      "plan.snapshot.md",
    ),
    tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
    worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
    lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
  };
}

describe("runImplementation", () => {
  it("implements, reviews, marks, and commits one task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];
    const states: Partial<RunState>[] = [];
    let currentState: RunState = { phase: "idle" };

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: (patch) => {
        const resolved =
          typeof patch === "function" ? patch(currentState) : patch;
        currentState = { ...currentState, ...resolved };
        states.push(resolved);
      },
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    expect(git.commits).toEqual(["feat: do thing"]);
    expect(subagents.spawns.map((spawn) => spawn.type)).toEqual([
      "general-purpose",
      "general-purpose",
    ]);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activeSubagentIds: ["agent-1"],
          activeAgentRefs: [
            expect.objectContaining({
              id: "agent-1",
              role: "implementer",
              label: expect.stringContaining("Task 1/1 implementer"),
            }),
          ],
        }),
        expect.objectContaining({
          activeSubagentIds: ["agent-2"],
          activeAgentRefs: [
            expect.objectContaining({
              id: "agent-2",
              role: "reviewer",
              label: expect.stringContaining("Task 1/1 reviewer"),
            }),
          ],
        }),
      ]),
    );
    expect(states.at(-1)).toMatchObject({ phase: "done" });
  });

  it("tracks reviewer requests separately from system failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const implementation =
      '<pi-implement-result>{"summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"fix: do thing"}</pi-implement-result>';
    subagents.results = [
      { status: "completed", result: "not json" },
      { status: "completed", result: implementation },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it"]}</pi-review-result>',
      },
      { status: "completed", result: implementation },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it again"]}</pi-review-result>',
      },
      { status: "completed", result: implementation },
      {
        status: "completed",
        result: GOOD_REVIEW,
      },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(git.commits).toEqual(["fix: do thing"]);
    expect(subagents.spawns).toHaveLength(7);
  });

  it("creates a task branch and worktree in parallel mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];

    const paths = {
      baseDir: join(dir, ".pi", "implement"),
      runDir: join(dir, ".pi", "implement", "runs", "r1"),
      runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
      eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
      planSnapshot: join(
        dir,
        ".pi",
        "implement",
        "runs",
        "r1",
        "plan.snapshot.md",
      ),
      tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
      worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
      lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("parallel task approved");

    expect(git.createdBranches).toHaveLength(1);
    expect(git.createdBranches[0]).toMatch(/^pi-implement\/r1\/t001-/);
    expect(git.addedWorktrees).toHaveLength(1);
    expect(git.addedWorktrees[0]?.path).toContain("worktrees/r1");
    expect(git.removedWorktrees).toHaveLength(0);
    expect(git.deletedBranches).toHaveLength(0);
  });

  it("commits in the task worktree and leaves main HEAD unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];

    const paths = {
      baseDir: join(dir, ".pi", "implement"),
      runDir: join(dir, ".pi", "implement", "runs", "r1"),
      runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
      eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
      planSnapshot: join(
        dir,
        ".pi",
        "implement",
        "runs",
        "r1",
        "plan.snapshot.md",
      ),
      tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
      worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
      lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("parallel task approved");

    // worktree child received the task commit
    expect(git.worktreeChild?.commits).toEqual(["feat: do thing"]);
    // main git did NOT receive a commit (integration is deferred)
    expect(git.commits).toHaveLength(0);
    // main HEAD was not changed by the task-local work
    expect(git.headValue).toBe("h1");
    // integration owns source checklist updates, so task-local approval leaves it unchecked
    expect(readFileSync(planPath, "utf-8")).toContain("- [ ] Do thing");
    const taskDir = join(paths.tasksDir, "t001-do-thing");
    const taskJson = JSON.parse(
      readFileSync(join(taskDir, "task.json"), "utf-8"),
    ) as { status: string; taskCommitSha?: string };
    expect(taskJson.status).toBe("approved");
    expect(taskJson.taskCommitSha).toBe("h1-commit-1");
    expect(readFileSync(join(taskDir, "prompt.md"), "utf-8")).toContain(
      "Do thing",
    );
    expect(readFileSync(join(taskDir, "result.md"), "utf-8")).toContain(
      "pi-implement-result",
    );
    expect(readFileSync(join(taskDir, "review.md"), "utf-8")).toContain(
      "pi-review-result",
    );
    expect(readFileSync(join(taskDir, "diff.patch"), "utf-8")).toContain(
      "diff --git",
    );
  });

  it("blocks if the task worktree is dirty after task commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const child = new FakeGit();
    child.commit = async (message: string): Promise<CommandResult> => {
      child.commits.push(message);
      child.headValue = `${child.headValue}-commit-${child.commits.length}`;
      child.statusText = "M generated.ts";
      return { command: "git commit", exitCode: 0, stdout: "", stderr: "" };
    };
    git.worktreeChild = child;
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];
    const paths = {
      baseDir: join(dir, ".pi", "implement"),
      runDir: join(dir, ".pi", "implement", "runs", "r1"),
      runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
      eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
      planSnapshot: join(
        dir,
        ".pi",
        "implement",
        "runs",
        "r1",
        "plan.snapshot.md",
      ),
      tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
      worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
      lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("task worktree is dirty");
  });

  it("source plan checkbox is not changed during task-local work (before approval)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const initialContent = "# Plan\n\n## Tasks\n\n- [ ] Do thing\n";
    writeFileSync(planPath, initialContent, "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    let contentAfterImpl = "";
    subagents.results = [
      {
        status: "completed",
        result: GOOD_IMPL,
      },
      {
        status: "completed",
        get result() {
          contentAfterImpl = readFileSync(planPath, "utf-8");
          return GOOD_REVIEW;
        },
      },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // Plan checkbox should not have been checked during the review phase
    expect(contentAfterImpl).toContain("- [ ] Do thing");
    // But it should be checked after the full cycle completes
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
  });

  it("blocks and preserves state if implementer changes main HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: GOOD_IMPL,
      },
    ];
    // Simulate implementer changing HEAD
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async () => {
      git.headValue = "h2-changed";
      return originalWaitFor();
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("blocks if a plan artifact is changed before task approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: GOOD_IMPL,
      },
    ];
    // Simulate implementer mutating the plan file
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async () => {
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [x] Do thing\n",
        "utf-8",
      );
      return originalWaitFor();
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("blocks if the main checkout is dirty after the implementer returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: GOOD_IMPL,
      },
    ];
    // Simulate implementer dirtying the main checkout
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async () => {
      git.statusText = "M some-file.ts";
      return originalWaitFor();
    };

    const paths = {
      baseDir: join(dir, ".pi", "implement"),
      runDir: join(dir, ".pi", "implement", "runs", "r1"),
      runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
      eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
      planSnapshot: join(
        dir,
        ".pi",
        "implement",
        "runs",
        "r1",
        "plan.snapshot.md",
      ),
      tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
      worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
      lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("retries with reviewer feedback and prior summary on changes_requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["fix the bug"]}</pi-review-result>',
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(4);
    // Second implementer spawn should have feedback in the prompt
    const secondImplPrompt = subagents.spawns[2]?.prompt ?? "";
    expect(secondImplPrompt).toContain("fix the bug");
    expect(secondImplPrompt).toContain("done"); // priorSummary
  });

  it("retries as system failure when no committable changes are produced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    git.worktreeChild = new FakeGit();
    git.worktreeChild.headValue = "h1";
    // Make the worktree report no staged changes on first attempt
    let callCount = 0;
    git.worktreeChild.hasStagedChanges = async () => {
      callCount++;
      return callCount > 1;
    };
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];

    const paths = {
      baseDir: join(dir, ".pi", "implement"),
      runDir: join(dir, ".pi", "implement", "runs", "r1"),
      runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
      eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
      planSnapshot: join(
        dir,
        ".pi",
        "implement",
        "runs",
        "r1",
        "plan.snapshot.md",
      ),
      tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
      worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
      lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("parallel task approved");

    // Two implementer attempts, one reviewer
    expect(subagents.spawns).toHaveLength(3);
  });

  it("blocks if integration validation or review mutates the staged diff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    writeGraphJson(paths.runDir, {
      version: 1,
      runId: "r1",
      baseSha: "h1",
      planPath,
      planHash: "hash",
      nodes: [
        {
          id: "task-1",
          planIndex: 1,
          title: "Do thing",
          taskHash: "hash",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    });
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_INTEGRATION_REVIEW },
    ];
    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 3) {
        git.diffText = "mutated staged diff";
      }
      return result;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("changed the staged integration diff");
  });

  it("cleans up task branches when worktree setup fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    writeGraphJson(paths.runDir, {
      version: 1,
      runId: "r1",
      baseSha: "h1",
      planPath,
      planHash: "hash",
      nodes: [
        {
          id: "task-1",
          planIndex: 1,
          title: "Do thing",
          taskHash: "hash",
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    });
    const git = new FakeGit();
    git.addWorktreeError = new Error("worktree failed");

    await expect(
      runImplementation({
        git,
        subagents: new FakeSubagents(),
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("Worktree setup failed");
    expect(git.deletedBranches).toContain("pi-implement/r1/task-1");
  });

  it("blocks instead of completing when the parallel scheduler stalls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n",
      "utf-8",
    );
    const paths = makePaths(dir);
    writeGraphJson(paths.runDir, {
      version: 1,
      runId: "r1",
      baseSha: "h1",
      planPath,
      planHash: "hash",
      nodes: [
        {
          id: "first",
          planIndex: 1,
          title: "First",
          taskHash: "hash1",
          dependsOn: ["second"],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "second",
          planIndex: 2,
          title: "Second",
          taskHash: "hash2",
          dependsOn: ["first"],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
      ],
    });

    await expect(
      runImplementation({
        git: new FakeGit(),
        subagents: new FakeSubagents(),
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("Parallel scheduler stalled");
  });
});
