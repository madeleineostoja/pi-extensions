import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runImplementation,
  BlockedError,
  OverallReviewFollowupError,
  nextOverallReviewArtifactPath,
} from "./orchestrator.js";
import { writeGraphJson } from "./graph.js";
import { readEvents, readTaskJson } from "./state.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SpawnArgs, SubagentClient, SubagentResult } from "./subagents.js";
import type { RunState } from "./status.js";
import { buildPlanBundleManifest } from "./manifest.js";
import { parsePlanFile } from "./plan.js";

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
  rootValue = "/repo";

  async root() {
    return this.rootValue;
  }
  async mainRoot() {
    return this.rootValue;
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
  async diffRange(_baseSha: string, _headSha: string): Promise<string> {
    return this.diffText;
  }
  forWorktree(worktreePath: string): GitClient {
    if (!this.worktreeChild) {
      this.worktreeChild = new FakeGit();
      this.worktreeChild.headValue = this.headValue;
    }
    this.worktreeChild.rootValue = worktreePath;
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

const GOOD_OVERALL_REVIEW =
  '<pi-overall-review-result>{"verdict":"approved"}</pi-overall-review-result>';
const BAD_OVERALL_REVIEW =
  '<pi-overall-review-result>{"verdict":"changes_requested","requiredChanges":["add integration tests"],"recommendationMarkdown":"## Suggested\\n\\nAdd tests."}</pi-overall-review-result>';

describe("nextOverallReviewArtifactPath", () => {
  it("returns a sibling path for the first review", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-artifact-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n", "utf-8");
    expect(nextOverallReviewArtifactPath(planPath)).toBe(
      join(dir, "plan.overall-review.md"),
    );
  });

  it("increments a numeric suffix when the sibling exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-artifact-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n", "utf-8");
    writeFileSync(join(dir, "plan.overall-review.md"), "# First\n", "utf-8");
    expect(nextOverallReviewArtifactPath(planPath)).toBe(
      join(dir, "plan.overall-review-2.md"),
    );
    writeFileSync(join(dir, "plan.overall-review-2.md"), "# Second\n", "utf-8");
    expect(nextOverallReviewArtifactPath(planPath)).toBe(
      join(dir, "plan.overall-review-3.md"),
    );
  });
});

describe("runImplementation", () => {
  it("blocks before spawning implementers when manifest validation failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `missing.md`\n",
      "utf-8",
    );
    const manifest = buildPlanBundleManifest(planPath, parsePlanFile(planPath));
    const git = new FakeGit();
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
    expect(subagents.spawns).toHaveLength(0);
  });

  it("implements, reviews, marks, and commits one task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
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
    expect(currentState.checkpointQueue).toEqual(
      expect.arrayContaining([
        "\u00b7 Task 1/1 implementer \u00b7 Do thing started",
        "\u00b7 Task 1/1 implementation finished: done",
        "\u00b7 Task 1/1 verification: tests: passed",
        "\u00b7 Task 1/1 reviewer \u00b7 Do thing started",
        "\u2713 Task 1/1 review approved",
        "\u00b7 Task 1/1 committing: feat: do thing",
        "\u2713 Task 1/1 landed @ h1-comm",
      ]),
    );
    expect(states.at(-1)).toMatchObject({ phase: "done" });
  });

  it("reviewer prompt includes sibling tasks as out-of-scope context but implementer prompt does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task one\n- [x] Task two\n",
      "utf-8",
    );
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
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

    expect(subagents.spawns).toHaveLength(3);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";

    expect(implPrompt).not.toContain("Task two");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- [x] Task two");
    expect(reviewerPrompt).toContain(
      "Completing a sibling task's own deliverable is scope creep",
    );
  });

  it("index-style plan: implementer and reviewer prompts include referenced material, implementer does not see sibling tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task one\n  - Plan: `sub.md`\n- [ ] Task two\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Subplan\n\nAcceptance: do it.\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";
    const overallReviewPrompt = subagents.spawns[4]?.prompt ?? "";

    // Implementer prompt
    expect(implPrompt).toContain("## Referenced Plan Material");
    expect(implPrompt).toContain("### sub.md");
    expect(implPrompt).toContain("# Subplan");
    expect(implPrompt).toContain("Acceptance: do it.");
    expect(implPrompt).not.toContain("## Out-of-Scope Sibling Tasks");
    expect(implPrompt).not.toContain("Task two");

    // Reviewer prompt
    expect(reviewerPrompt).toContain("## Referenced Plan Material");
    expect(reviewerPrompt).toContain("### sub.md");
    expect(reviewerPrompt).toContain("# Subplan");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- [ ] Task two");

    // Overall reviewer prompt
    expect(overallReviewPrompt).toContain("## Referenced Plan Material");
    expect(overallReviewPrompt).toContain("### sub.md");
    expect(overallReviewPrompt).toContain("# Subplan");
  });

  it("two unchecked tasks: reviewer prompt lists task 2 as out-of-scope but implementer prompt does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task one\n- [ ] Task two\n",
      "utf-8",
    );
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
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

    expect(subagents.spawns).toHaveLength(5);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";

    expect(implPrompt).not.toContain("Task two");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- [ ] Task two");
    expect(reviewerPrompt).toContain(
      "Completing a sibling task's own deliverable is scope creep",
    );
    expect(reviewerPrompt).toContain(
      "Request changes if the staged diff substantially implements an unselected sibling task",
    );
    expect(reviewerPrompt).toContain('"verdict": "changes_requested"');

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [x] Task one");
    expect(updatedPlan).toContain("- [x] Task two");
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
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

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
        currentState =
          typeof patch === "function"
            ? { ...currentState, ...patch(currentState) }
            : { ...currentState, ...patch };
      },
      shouldStop: () => false,
    });

    expect(currentState.checkpointQueue).toEqual(
      expect.arrayContaining([
        "\u00b7 Task 1/1 implementation finished: Response did not include <pi-implement-result> output.",
        "\u00b7 Task 1/1 review changes requested: tighten it",
        "\u00b7 Task 1/1 review changes requested: tighten it again",
      ]),
    );
    expect(git.commits).toEqual(["fix: do thing"]);
    expect(subagents.spawns).toHaveLength(8);
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
      { status: "completed", result: GOOD_OVERALL_REVIEW },
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
      { status: "completed", result: GOOD_OVERALL_REVIEW },
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

    expect(subagents.spawns).toHaveLength(5);
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
    // Second implementer prompt should include the improved diagnostic message
    const secondImplPrompt = subagents.spawns[1]?.prompt ?? "";
    expect(secondImplPrompt).toContain("already_satisfied");
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

  it("runs an approved overall review after serial tasks land", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.runJson,
      JSON.stringify({
        version: 1,
        runId: "r1",
        mode: "serial",
        strategyReason: "serial",
        repoRoot: dir,
        planPath,
        planHash: "hash",
        baseSha: "old-sha",
        currentPhase: "preflight",
        maxConcurrency: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const git = new FakeGit();
    git.headValue = "base-sha";
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    let currentState: RunState = { phase: "idle" };

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: (patch) => {
        currentState =
          typeof patch === "function"
            ? { ...currentState, ...patch(currentState) }
            : { ...currentState, ...patch };
      },
      shouldStop: () => false,
    });

    expect(currentState.phase).toBe("done");
    expect(subagents.spawns).toHaveLength(3);
    const overallPrompt = subagents.spawns[2]?.prompt ?? "";
    expect(overallPrompt).toContain("pi-implement overall reviewer");
    expect(overallPrompt).toContain("old-sha");
  });

  it("throws OverallReviewFollowupError when overall review requests changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.runJson,
      JSON.stringify({
        version: 1,
        runId: "r1",
        mode: "serial",
        strategyReason: "serial",
        repoRoot: dir,
        planPath,
        planHash: "hash",
        baseSha: "old-sha",
        currentPhase: "preflight",
        maxConcurrency: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const git = new FakeGit();
    git.headValue = "base-sha";
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: BAD_OVERALL_REVIEW },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const artifactPath = join(dir, "plan.overall-review.md");
    expect(existsSync(artifactPath)).toBe(true);
    const content = readFileSync(artifactPath, "utf-8");
    expect(content).toContain("changes_requested");
    expect(content).toContain("add integration tests");
    expect(content).toContain("## Suggested");
    expect(content).toContain("old-sha");
  });

  it("skips overall review when baseSha equals headSha", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [x] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();

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

    expect(subagents.spawns).toHaveLength(0);
  });

  it("blocks if overall reviewer changes HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.runJson,
      JSON.stringify({
        version: 1,
        runId: "r1",
        mode: "serial",
        strategyReason: "serial",
        repoRoot: dir,
        planPath,
        planHash: "hash",
        baseSha: "old-sha",
        currentPhase: "preflight",
        maxConcurrency: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const git = new FakeGit();
    git.headValue = "base-sha";
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 3) {
        git.headValue = "mutated";
      }
      return result;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("overall reviewer changed HEAD");
  });

  it("blocks if overall reviewer changes a plan artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.runJson,
      JSON.stringify({
        version: 1,
        runId: "r1",
        mode: "serial",
        strategyReason: "serial",
        repoRoot: dir,
        planPath,
        planHash: "hash",
        baseSha: "old-sha",
        currentPhase: "preflight",
        maxConcurrency: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const git = new FakeGit();
    git.headValue = "base-sha";
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 3) {
        writeFileSync(planPath, "# Mutated\n", "utf-8");
      }
      return result;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("overall reviewer changed a plan artifact");
  });

  it("blocks if overall reviewer changes staged state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.runJson,
      JSON.stringify({
        version: 1,
        runId: "r1",
        mode: "serial",
        strategyReason: "serial",
        repoRoot: dir,
        planPath,
        planHash: "hash",
        baseSha: "old-sha",
        currentPhase: "preflight",
        maxConcurrency: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const git = new FakeGit();
    git.headValue = "base-sha";
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 3) {
        git.diffText = "mutated";
      }
      return result;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("overall reviewer changed staged state");
  });

  it("blocks if overall reviewer changes worktree state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(
      paths.runJson,
      JSON.stringify({
        version: 1,
        runId: "r1",
        mode: "serial",
        strategyReason: "serial",
        repoRoot: dir,
        planPath,
        planHash: "hash",
        baseSha: "old-sha",
        currentPhase: "preflight",
        maxConcurrency: 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const git = new FakeGit();
    git.headValue = "base-sha";
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 3) {
        git.worktreeFingerprintText = "mutated";
      }
      return result;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("overall reviewer changed worktree state");
  });

  it("runs an approved overall review after parallel tasks land", async () => {
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
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    let currentState: RunState = { phase: "idle" };

    await runImplementation({
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
      updateState: (patch) => {
        currentState =
          typeof patch === "function"
            ? { ...currentState, ...patch(currentState) }
            : { ...currentState, ...patch };
      },
      shouldStop: () => false,
      verifyCommand: "echo ok",
    });

    expect(currentState.phase).toBe("done");
    expect(subagents.spawns).toHaveLength(3);
    const overallPrompt = subagents.spawns[2]?.prompt ?? "";
    expect(overallPrompt).toContain("pi-implement overall reviewer");
    expect(overallPrompt).toContain("h1");
  });

  it("throws OverallReviewFollowupError when parallel overall review requests changes", async () => {
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
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: BAD_OVERALL_REVIEW },
    ];

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
        verifyCommand: "echo ok",
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const artifactPath = join(dir, "plan.overall-review.md");
    expect(existsSync(artifactPath)).toBe(true);
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

  it("serial already-satisfied approved marks done without commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';
    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    git.hasStagedChanges = async () => false;

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [x] Do it");
    expect(git.commits).toHaveLength(0);

    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";
    expect(reviewerPrompt).toContain("There is no staged candidate diff");
    expect(reviewerPrompt).toContain("Current HEAD:");

    const taskJson = readTaskJson(paths, "t001-do-it");
    expect(taskJson?.status).toBe("satisfied");

    const events = readEvents(paths);
    expect(
      events.some(
        (e) => e.type === "task_satisfied" && e.taskId === "t001-do-it",
      ),
    ).toBe(true);
  });

  it("serial already-satisfied approved blocks and leaves checkbox unchecked when worktree is dirty after approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';
    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];

    git.hasStagedChanges = async () => false;
    git.isCleanExcept = async () => false;

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
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

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [ ] Do it");
    expect(git.commits).toHaveLength(0);
  });

  it("serial already-satisfied rejected retries with feedback then commits normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';
    const CHANGES_REQUESTED =
      '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["Add a missing test case."]}</pi-review-result>';
    const EXPLICIT_CHANGED_IMPL =
      '<pi-implement-result>{"outcome":"changed","summary":"fixed","verification":[{"command":"npm test","result":"passed","rationale":"covers change"}],"commitMessage":"feat: do thing"}</pi-implement-result>';

    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
      { status: "completed", result: CHANGES_REQUESTED },
      { status: "completed", result: EXPLICIT_CHANGED_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    let stagedCallCount = 0;
    git.hasStagedChanges = async () => {
      stagedCallCount++;
      return stagedCallCount > 1;
    };

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [x] Do it");
    expect(git.commits).toHaveLength(1);

    const secondImplPrompt = subagents.spawns[2]?.prompt ?? "";
    expect(secondImplPrompt).toContain("Add a missing test case.");
  });

  it("explicit outcome changed still stages reviews and commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const EXPLICIT_CHANGED_IMPL =
      '<pi-implement-result>{"outcome":"changed","summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"feat: do thing"}</pi-implement-result>';

    subagents.results = [
      { status: "completed", result: EXPLICIT_CHANGED_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [x] Do it");
    expect(git.commits).toHaveLength(1);
  });

  it("serial no-staged changed blocks with improved message after retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const EXPLICIT_CHANGED_IMPL =
      '<pi-implement-result>{"outcome":"changed","summary":"done","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"feat: do thing"}</pi-implement-result>';

    subagents.results = [
      { status: "completed", result: EXPLICIT_CHANGED_IMPL },
      { status: "completed", result: EXPLICIT_CHANGED_IMPL },
    ];

    git.hasStagedChanges = async () => false;

    let caught: Error | undefined;
    try {
      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught).toBeInstanceOf(BlockedError);
    expect(caught?.message).toContain("system retry limit reached");
    expect(caught?.message).toContain("already_satisfied");
    expect(caught?.message).toContain("Likely causes");
  });

  it("serial already-satisfied with staged changes blocks without retrying dirty mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';

    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(
      "Implementer reported already_satisfied but produced staged changes",
    );

    expect(subagents.spawns).toHaveLength(1);
    expect(readFileSync(planPath, "utf-8")).toContain("- [ ] Do it");
    expect(git.commits).toHaveLength(0);
  });

  it("serial already-satisfied changes_requested blocks if reviewer dirtied checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';
    const CHANGES_REQUESTED =
      '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["Add a missing test case."]}</pi-review-result>';

    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
      { status: "completed", result: CHANGES_REQUESTED },
    ];

    git.hasStagedChanges = async () => false;
    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 2) {
        git.statusText = "M some-file.ts";
      }
      return result;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("reviewer dirtied the serial checkout");

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [ ] Do it");
    expect(git.commits).toHaveLength(0);
  });

  it("serial already-satisfied approved rolls back checkbox if worktree becomes dirty after marking done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';

    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];

    git.hasStagedChanges = async () => false;
    let cleanCallCount = 0;
    git.isCleanExcept = async () => {
      cleanCallCount++;
      // Return true for pre-mark checks (initial + loop start + boundary + pre-mark),
      // then false after markTaskDone to simulate post-mark dirtiness.
      return cleanCallCount <= 4;
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("satisfied task marked done but worktree became dirty");

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [ ] Do it");
    expect(git.commits).toHaveLength(0);
  });
});
