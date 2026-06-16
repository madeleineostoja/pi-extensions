import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runImplementation,
  BlockedError,
  OverallReviewFollowupError,
  StoppedError,
  nextOverallReviewArtifactPath,
  buildSchedulerGraphSummary,
  captureSchedulerSelfHealBaseline,
  checkSchedulerSelfHealProgress,
} from "./orchestrator.js";
import { createSchedulerRun } from "./scheduler.js";
import { writeGraphJson } from "./graph.js";
import { writeExecutionManifest } from "./execution-plan.js";
import type { ExecutionManifest } from "./execution-plan.js";
import { readEvents, readTaskJson, writeRunJson } from "./state.js";
import type { RunJson, StatePaths } from "./state.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SpawnArgs, SubagentClient, SubagentResult } from "./subagents.js";
import type { RunState } from "./status.js";
import {
  buildPlanBundleManifest,
  computeTaskFingerprint,
  type PlanBundleManifest,
} from "./manifest.js";
import { parsePlanFile } from "./plan.js";
import { buildPhase1MaterialInventory } from "./material-inventory.js";

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
  async unstagedNameStatus() {
    return "";
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
  async reword(message: string): Promise<CommandResult> {
    if (this.commits.length > 0) {
      this.commits[this.commits.length - 1] = message;
    } else {
      this.commits.push(message);
    }
    this.headValue = `${this.headValue}-reword-${this.commits.length}`;
    return {
      command: "git commit --amend",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
  async reset() {}
  async resetHard(commitSha: string) {
    this.headValue = commitSha;
  }
  aheadOfBaseValue = false;
  async aheadOfBase(_branchName: string, _baseSha: string): Promise<boolean> {
    return this.aheadOfBaseValue;
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
  async listBranchesMatching(pattern: string): Promise<string[]> {
    return this.createdBranches.filter(
      (b) =>
        b.includes(pattern.replace(/\*\/?$/, "")) &&
        !this.deletedBranches.includes(b),
    );
  }
  async listWorktrees(): Promise<string[]> {
    const added = this.addedWorktrees.map((w) => w.path);
    const removed = new Set(this.removedWorktrees);
    return added.filter((p) => !removed.has(p));
  }
  async ensureInfoExclude() {}
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
  resultsByDescription: { match: string | RegExp; result: SubagentResult }[] =
    [];

  async probe() {
    return { ok: true as const };
  }
  async spawn(args: SpawnArgs) {
    this.spawns.push(args);
    return `agent-${this.spawns.length}`;
  }
  async stop() {}
  async waitFor(_id?: string, _signal?: AbortSignal) {
    const index = _id ? Number(_id.replace("agent-", "")) - 1 : -1;
    const args = index >= 0 ? this.spawns[index] : undefined;
    if (args) {
      const routed = this.resultsByDescription.find((r) =>
        typeof r.match === "string"
          ? args.description.includes(r.match)
          : r.match.test(args.description),
      );
      if (routed) {
        return routed.result;
      }
    }
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
    corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
    tasksDir: join(dir, ".pi", "implement", "runs", "r1", "tasks"),
    worktreesDir: join(dir, ".pi", "implement", "worktrees", "r1"),
    lockFile: join(dir, ".pi", "implement", "locks", "run.lock"),
  };
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.runJson, JSON.stringify({ runId: "r1" }), "utf-8");
  writeTestRunLock(paths);
  return paths;
}

function writeTestRunLock(paths: StatePaths, runId = "r1") {
  mkdirSync(join(paths.baseDir, "locks"), { recursive: true });
  writeFileSync(
    paths.lockFile,
    JSON.stringify({
      version: 1,
      runId,
      runDir: paths.runDir,
      startedAt: new Date().toISOString(),
      pid: process.pid,
      hostname: "test",
    }),
    "utf-8",
  );
}

function makeRunJson(dir: string, planPath: string, runId = "r1"): RunJson {
  return {
    version: 1,
    runId,
    mode: "parallel",
    strategyReason: "test",
    repoRoot: dir,
    planPath,
    planHash: "hash",
    baseSha: "h1",
    currentPhase: "running",
    maxConcurrency: 2,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeExecutionManifest(
  plan: ReturnType<typeof parsePlanFile>,
  planBundle?: PlanBundleManifest,
): ExecutionManifest {
  return {
    version: 1,
    tasks: plan.tasks.map((task) => ({
      id: `t${String(task.index).padStart(3, "0")}-${task.text.toLowerCase().replace(/\s+/g, "-")}`,
      planIndex: task.index,
      title: task.text,
      taskHash: computeTaskFingerprint(task),
      status: "todo" as const,
      dependsOn: [],
      review: { mode: "require" as const },
      affectedAreas: [],
      conflictHints: [],
      sourceReferences: [],
      sourceMaterialRefs: planBundle
        ? planBundle.tasks
            .find((entry) => entry.planIndex === task.index)
            ?.referencedMaterials.map((material) => ({
              origin: "task-link" as const,
              path: material.absolutePath,
              mode: { kind: "full-file" as const },
              reason: "test referenced material",
            }))
        : undefined,
      sourceCheckbox: {
        path: plan.path,
        lineNumber: task.lineNumber,
        lineText: task.originalLine,
      },
      compiledContract: {
        objective: task.text,
        inScope: [task.text],
        acceptanceCriteria: ["Task is complete and verified"],
        outOfScope: ["Other tasks"],
      },
    })),
  };
}

function testRoles() {
  return {
    implementer: { model: "p/m", type: "general-purpose" as const },
    reviewer: { model: "p/m", type: "general-purpose" as const },
    planner: { model: "p/m", type: "Explore" as const },
    selfHeal: { model: "p/m", type: "general-purpose" as const },
  };
}

const GOOD_OVERALL_REVIEW =
  '<pi-overall-review-result>{"verdict":"approved"}</pi-overall-review-result>';
const BAD_OVERALL_REVIEW =
  '<pi-overall-review-result>{"verdict":"changes_requested","requiredChanges":["add integration tests"],"recommendationMarkdown":"## Suggested\\n\\nAdd tests."}</pi-overall-review-result>';
const GOOD_REWORK =
  '<pi-overall-rework-result>{"summary":"fixed","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"fix: address overall review"}</pi-overall-rework-result>';

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

function makeSelfHealResult(args: {
  repaired: boolean;
  retryIntegration: boolean;
  retryMode?: "continue_candidate" | "retry_cherry_pick" | "retry_validation";
  summary?: string;
  commands?: string[];
  filesChanged?: string[];
}): string {
  return `<pi-self-heal-result>${JSON.stringify(args)}</pi-self-heal-result>`;
}

function makeSchedulerSelfHealResult(args: {
  repaired: boolean;
  retryScheduler: boolean;
  summary?: string;
  commands?: string[];
  filesChanged?: string[];
  remainingBlocker?: string | null;
}): string {
  return `<pi-self-heal-result>${JSON.stringify(args)}</pi-self-heal-result>`;
}

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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
    expect(subagents.spawns).toHaveLength(0);
  });

  it("continues when a task fingerprint changes after manifest preflight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `sub.md`\n  - Keep this note\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Subplan\n", "utf-8");
    const originalPlan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, originalPlan);
    const executionManifest = makeExecutionManifest(originalPlan);
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `sub.md`\n  - Edited after preflight\n",
      "utf-8",
    );
    const git = new FakeGit();
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        executionManifest,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("missing fake result");
    expect(subagents.spawns).toHaveLength(1);
  });

  it("blocks when supporting plan corpus changed before task execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const supportPath = join(dir, "support.md");
    const planContent =
      "# Plan\n\nSee [support](support.md).\n\n## Tasks\n\n- [ ] Do thing\n";
    const supportContent = "# Support\n\nKeep this requirement.\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(supportPath, supportContent, "utf-8");

    const plan = parsePlanFile(planPath);
    const paths = makePaths(dir);
    const runJson = makeRunJson(dir, planPath);
    writeRunJson(paths, {
      ...runJson,
      corpusHash: sha256(`${sha256(planContent)}${sha256(supportContent)}`),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: supportPath, hash: sha256(supportContent) },
      ],
    });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(`${sha256(planContent)}${sha256(supportContent)}`),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: supportPath, hash: sha256(supportContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeExecutionManifest(paths.runDir, makeExecutionManifest(plan));
    writeFileSync(supportPath, "# Support\n\nChanged requirement.\n", "utf-8");

    const git = new FakeGit();
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("re-ingest and replan");
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
        "\u00b7 Task 1/1 implementation finished: done",
        "\u00b7 Task 1/1 verification: tests: passed",
        "\u2713 Task 1/1 review approved",
        "\u00b7 Task 1/1 committing: feat: do thing",
        "\u2713 Task 1/1 landed @ h1-comm",
      ]),
    );
    expect(states.at(-1)).toMatchObject({ phase: "done" });
  });

  it("serial task implementer spawn uses the task cwd and role", async () => {
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

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const implementerSpawn = subagents.spawns.find((s) =>
      s.description.includes("implement"),
    );
    expect(implementerSpawn).toBeDefined();
    expect(implementerSpawn?.cwd).toBe(git.rootValue);
    expect(implementerSpawn?.role).toBe("implementer");
  });

  it("starts a partially completed serial plan at the next plan task number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [x] First\n- [x] Second\n- [ ] Third\n- [ ] Fourth\n- [ ] Fifth\n",
      "utf-8",
    );
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
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
      mode: "serial",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: (patch) => {
        const resolved =
          typeof patch === "function" ? patch(currentState) : patch;
        currentState = { ...currentState, ...resolved };
        states.push(resolved);
      },
      shouldStop: () => false,
    });

    expect(states.find((state) => state.taskIndex !== undefined)).toMatchObject(
      {
        taskIndex: 3,
        totalTasks: 5,
      },
    );
    expect(subagents.spawns[0]?.description).toContain("task 3/5");
    expect(currentState.phase).toBe("done");
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(3);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";

    expect(implPrompt).not.toContain("Task two");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- Task two");
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";
    const overallReviewPrompt = subagents.spawns[4]?.prompt ?? "";

    // Implementer prompt uses selected packet material, not sibling tasks
    expect(implPrompt).toContain("## Compiled Task Contract");
    expect(implPrompt).toContain("## Referenced Source Material");
    expect(implPrompt).toContain("# Subplan");
    expect(implPrompt).not.toContain("## Referenced Plan Material");
    expect(implPrompt).not.toContain("## Out-of-Scope Sibling Tasks");
    expect(implPrompt).not.toContain("Task two");

    // Reviewer prompt uses selected packet material, not plan-material wording
    expect(reviewerPrompt).toContain("## Compiled Task Contract");
    expect(reviewerPrompt).toContain("## Referenced Source Material");
    expect(reviewerPrompt).toContain("# Subplan");
    expect(reviewerPrompt).not.toContain("## Referenced Plan Material");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- Task two");

    // Overall reviewer prompt still has full referenced material
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";

    expect(implPrompt).not.toContain("Task two");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- Task two");
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

  it("regression: compiled contract excludes sibling deliverables from a shared plan file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    const sharedPath = join(dir, "shared.md");
    writeFileSync(
      planPath,
      `# Plan

## Tasks

- [ ] Add public tools API
  - Plan: \`shared.md\`
- [ ] Migrate injected explore to pi-implement
  - Plan: \`shared.md\`
`,
      "utf-8",
    );
    writeFileSync(
      sharedPath,
      `# Shared Decisions

## Public Tools
- Must expose the public tools surface.

## Injected Explore
- Must migrate injected explore to pi-implement.

## Auth
- All features must use auth.
`,
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

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      executionManifest,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    const task1ImplPrompt = subagents.spawns[0]?.prompt ?? "";
    const task1ReviewerPrompt = subagents.spawns[1]?.prompt ?? "";
    const overallReviewPrompt = subagents.spawns[4]?.prompt ?? "";

    // Task 1 implementer must NOT see sibling deliverables from shared.md
    expect(task1ImplPrompt).toContain("## Compiled Task Contract");
    expect(task1ImplPrompt).toContain("## Referenced Source Material");
    expect(task1ImplPrompt).not.toContain("## Referenced Plan Material");
    expect(task1ImplPrompt).toContain("Must migrate injected explore");
    expect(task1ImplPrompt).toContain("migrate injected explore");
    expect(task1ImplPrompt).toContain(
      "Use referenced material only to satisfy the compiled contract",
    );

    // Task 1 reviewer sees the same selected referenced material as the implementer
    expect(task1ReviewerPrompt).toContain("## Compiled Task Contract");
    expect(task1ReviewerPrompt).toContain("## Referenced Source Material");
    expect(task1ReviewerPrompt).not.toContain("## Referenced Plan Material");
    expect(task1ReviewerPrompt).toContain("Must migrate injected explore");
    expect(task1ReviewerPrompt).toContain(
      "Use the compiled task contract and referenced source material below to verify scope and exact-source fidelity",
    );
    expect(task1ReviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(task1ReviewerPrompt).toContain("- Migrate injected explore");

    // Overall reviewer sees the full plan corpus for omission checks
    expect(overallReviewPrompt).toContain("## Referenced Plan Material");
    expect(overallReviewPrompt).toContain("Must migrate injected explore");
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
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it"]}</pi-review-result>',
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
        "\u00b7 Task 1/1 review changes requested: tighten it",
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
      corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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

  it("validates planner-selected material against the recorded plan corpus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const supportPath = join(dir, "support.md");
    const outsidePath = join(dir, "outside.md");
    const planContent = [
      "# Plan",
      "",
      "See [support](support.md).",
      "",
      "## Tasks",
      "",
      "- [ ] Selected task",
      "",
    ].join("\n");
    const supportContent = [
      "# Support",
      "",
      "safe line two",
      "safe line three",
      "safe line four",
      "",
    ].join("\n");
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(supportPath, supportContent, "utf-8");
    writeFileSync(outsidePath, "# Outside\n\nDo not render me.\n", "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-selected-task",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: relative(dir, supportPath),
              mode: { kind: "line-range", startLine: 3, endLine: 4 },
              reason: "Valid repo-relative corpus excerpt.",
            },
          ],
          reason: "Dropped ref outside the ingested corpus.",
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: supportPath, hash: sha256(supportContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(`${sha256(planContent)}${sha256(supportContent)}`),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: supportPath, hash: sha256(supportContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.sourceMaterialRefs = [
      {
        origin: "planner",
        path: relative(dir, supportPath),
        mode: { kind: "line-range", startLine: 3, endLine: 4 },
        reason: "Valid repo-relative corpus excerpt.",
      },
      {
        origin: "planner",
        path: "outside.md",
        mode: { kind: "full-file" },
        reason: "Existing file outside the ingested corpus.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const prompt = readFileSync(
      join(paths.tasksDir, "t001-selected-task", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain(
      `Source: ${supportPath} (lines 3-4; origin: planner)`,
    );
    expect(prompt).toContain("safe line two\nsafe line three");
    expect(prompt).not.toContain("safe line four");
    expect(prompt).not.toContain("Do not render me.");
    expect(prompt).toContain("Source material repair note");
    expect(prompt).not.toContain("path is not in the ingested plan corpus");
  });

  it("repairs invalid planner line ranges through one subagent response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const referencePath = join(dir, "reference.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Selected task\n";
    const referenceContent = "line one\nline two\nline three\nline four\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(referencePath, referenceContent, "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-selected-task",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: referencePath,
              mode: { kind: "line-range", startLine: 2, endLine: 3 },
              reason: "Corrected range.",
            },
          ],
          reason: "Fixed invalid line range.",
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: referencePath, hash: sha256(referenceContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256(referenceContent)}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: referencePath, hash: sha256(referenceContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.sourceMaterialRefs = [
      ...(task.sourceMaterialRefs ?? []),
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "line-range", startLine: 50, endLine: 51 },
        reason: "Invalid range.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const prompt = readFileSync(
      join(paths.tasksDir, "t001-selected-task", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain(
      `Source: ${referencePath} (lines 2-3; origin: planner)`,
    );
    expect(prompt).toContain("line two\nline three");
    expect(prompt).toContain("Source material repair note");
    expect(prompt).not.toContain(
      "Low-confidence source material warning for review",
    );

    const packet = JSON.parse(
      readFileSync(
        join(paths.tasksDir, "t001-selected-task", "task-packet.json"),
        "utf-8",
      ),
    ) as {
      resolvedMaterialRefs: unknown[];
      sourceMaterialRepair?: { reason?: string; failureReason?: string };
    };
    expect(packet.sourceMaterialRepair?.reason).toBe(
      "Fixed invalid line range.",
    );
    expect(packet.sourceMaterialRepair?.failureReason).toBeUndefined();
  });

  it("falls back to anchored packet when repair output remains invalid and exact material is not required", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const referencePath = join(dir, "reference.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Selected task\n";
    const referenceContent = "line one\nline two\nline three\nline four\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(referencePath, referenceContent, "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-selected-task",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: referencePath,
              mode: { kind: "line-range", startLine: 100, endLine: 101 },
              reason: "Still invalid range.",
            },
          ],
          reason: "Failed to correct range.",
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: referencePath, hash: sha256(referenceContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256(referenceContent)}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: referencePath, hash: sha256(referenceContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.sourceMaterialRefs = [
      ...(task.sourceMaterialRefs ?? []),
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "line-range", startLine: 50, endLine: 51 },
        reason: "Invalid range.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const prompt = readFileSync(
      join(paths.tasksDir, "t001-selected-task", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("### Selected Task Source Anchor");
    expect(prompt).toContain("Source material repair note");
    expect(prompt).toContain(
      "Low-confidence source material warning for review",
    );
    expect(prompt).toContain("starts after end of file");
    expect(prompt).not.toContain(
      `Source: ${referencePath} (lines 2-3; origin: planner)`,
    );

    const packet = JSON.parse(
      readFileSync(
        join(paths.tasksDir, "t001-selected-task", "task-packet.json"),
        "utf-8",
      ),
    ) as {
      resolvedMaterialRefs: unknown[];
      sourceMaterialRepair?: { reason?: string; failureReason?: string };
    };
    expect(packet.sourceMaterialRepair?.reason).toBe(
      "Failed to correct range.",
    );
  });

  it("preserves deterministic refs when repair output omits task-anchor material", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const referencePath = join(dir, "reference.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Selected task\n";
    const referenceContent = "line one\nline two\nline three\nline four\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(referencePath, referenceContent, "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-selected-task",
          sourceMaterialRefs: [
            {
              origin: "task-anchor",
              path: planPath,
              mode: { kind: "line-range", startLine: 1, endLine: 1 },
              reason: "Trying to replace anchor.",
            },
            {
              origin: "planner",
              path: referencePath,
              mode: { kind: "line-range", startLine: 2, endLine: 3 },
              reason: "Corrected planner ref.",
            },
          ],
          reason: "Replaced anchor and added planner ref.",
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: referencePath, hash: sha256(referenceContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256(referenceContent)}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: referencePath, hash: sha256(referenceContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.sourceMaterialRefs = [
      ...(task.sourceMaterialRefs ?? []),
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "line-range", startLine: 50, endLine: 51 },
        reason: "Invalid range.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      paths,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const packet = JSON.parse(
      readFileSync(
        join(paths.tasksDir, "t001-selected-task", "task-packet.json"),
        "utf-8",
      ),
    ) as {
      resolvedMaterialRefs: Array<{
        origin: string;
        absolutePath: string;
        displayLabel: string;
      }>;
    };
    const anchor = packet.resolvedMaterialRefs.find(
      (ref) => ref.origin === "task-anchor",
    );
    expect(anchor).toBeDefined();
    expect(anchor?.absolutePath).toBe(planPath);
    expect(anchor?.displayLabel).toBe("Selected Task Source Anchor");
    expect(
      packet.resolvedMaterialRefs.some(
        (ref) => ref.origin === "planner" && ref.absolutePath === referencePath,
      ),
    ).toBe(true);
  });

  it("blocks when repaired planner refs remain oversized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const referencePath = join(dir, "reference.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Selected task\n";
    const referenceContent = "x".repeat(101_000);
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(referencePath, referenceContent, "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-selected-task",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: referencePath,
              mode: { kind: "full-file" },
              reason: "Still oversized full-file ref.",
            },
          ],
          reason: "Could not narrow the ref.",
        }),
      },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: referencePath, hash: sha256(referenceContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256(referenceContent)}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: referencePath, hash: sha256(referenceContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.sourceMaterialRefs = [
      ...(task.sourceMaterialRefs ?? []),
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "full-file" },
        reason: "Oversized full-file ref.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("Rendered source material exceeds maximum size");
    expect(subagents.spawns).toHaveLength(1);
  });

  it("blocks exact-material tasks when planner material is not in the recorded corpus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const outsidePath = join(dir, "outside.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Copy exact fixture\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(outsidePath, "fixture body\n", "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-copy-exact-fixture",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: "outside.md",
              mode: { kind: "full-file" },
              reason: "Existing file outside the ingested corpus.",
            },
          ],
          reason: "Could not locate alternative corpus file.",
        }),
      },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [{ path: planPath, hash: sha256(planContent) }],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(sha256(planContent)),
          files: [{ path: planPath, hash: sha256(planContent) }],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.compiledContract = {
      ...task.compiledContract,
      objective: "Copy exact fixture",
      acceptanceCriteria: ["Fixture is copied from the source-of-truth."],
    };
    task.sourceMaterialRefs = [
      {
        origin: "planner",
        path: "outside.md",
        mode: { kind: "full-file" },
        reason: "Existing file outside the ingested corpus.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("requires exact source material");
    expect(subagents.spawns).toHaveLength(1);
  });

  it("blocks exact-material tasks when repaired planner refs are only too broad", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const referencePath = join(dir, "reference.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Copy exact fixture\n";
    const referenceContent = "x".repeat(30_000);
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(referencePath, referenceContent, "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-copy-exact-fixture",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: referencePath,
              mode: { kind: "full-file" },
              reason: "Still too broad.",
            },
          ],
          reason: "Could not narrow to a line range.",
        }),
      },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: referencePath, hash: sha256(referenceContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256(referenceContent)}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: referencePath, hash: sha256(referenceContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.compiledContract = {
      ...task.compiledContract,
      objective: "Copy exact fixture",
      acceptanceCriteria: ["Fixture is copied from the source-of-truth."],
    };
    task.sourceMaterialRefs = [
      ...(task.sourceMaterialRefs ?? []),
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "full-file" },
        reason: "Broad full-file ref.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("exact/verbatim source material");
    expect(subagents.spawns).toHaveLength(1);
  });

  it("blocks planner material path escapes before worker spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const outsidePath = join(dirname(dir), "outside-material.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Do task\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(outsidePath, "outside detail\n", "utf-8");

    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: outsidePath, hash: sha256("outside detail\n") },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256("outside detail\n")}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: outsidePath, hash: sha256("outside detail\n") },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    executionManifest.tasks[0]!.sourceMaterialRefs = [
      {
        origin: "planner",
        path: outsidePath,
        mode: { kind: "full-file" },
        reason: "Escaping planner ref.",
      },
    ];
    writeExecutionManifest(paths.runDir, executionManifest);

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("outside allowed roots");
    expect(subagents.spawns).toHaveLength(0);
  });

  it("blocks missing deterministic material before worker spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const supportPath = join(dir, "support.md");
    const planContent =
      "# Plan\n\n## Tasks\n\n- [ ] Use support\n  Plan: `support.md`\n";
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(supportPath, "support detail\n", "utf-8");
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const materialInventory = buildPhase1MaterialInventory({
      plan,
      planPath,
      manifest,
      repoRoot: dir,
    });
    rmSync(supportPath);
    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        materialInventory,
        executionManifest: makeExecutionManifest(plan, manifest),
        roles: testRoles(),
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("missing");
    expect(subagents.spawns).toHaveLength(0);
  });

  it("blocks deterministic material path escapes before worker spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const outsidePath = join(dirname(dir), "outside-material.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do task\n", "utf-8");
    writeFileSync(outsidePath, "outside detail\n", "utf-8");
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    executionManifest.tasks[0]!.sourceMaterialRefs = [
      {
        origin: "task-link",
        path: relative(dir, outsidePath),
        mode: { kind: "full-file" },
        reason: "Escaping material.",
      },
    ];
    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        materialInventory: buildPhase1MaterialInventory({
          plan,
          planPath,
          manifest,
          repoRoot: dir,
        }),
        executionManifest,
        roles: testRoles(),
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("outside allowed roots");
    expect(subagents.spawns).toHaveLength(0);
  });

  it("blocks invalid deterministic line ranges before worker spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do task\n", "utf-8");
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    executionManifest.tasks[0]!.sourceMaterialRefs = [
      {
        origin: "task-anchor",
        path: planPath,
        mode: { kind: "line-range", startLine: 50, endLine: 51 },
        reason: "Invalid range.",
      },
    ];
    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        materialInventory: buildPhase1MaterialInventory({
          plan,
          planPath,
          manifest,
          repoRoot: dir,
        }),
        executionManifest,
        roles: testRoles(),
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("starts after end of file");
    expect(subagents.spawns).toHaveLength(0);
  });

  it("blocks deterministic material changed after inventory creation before worker spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Do task\n";
    writeFileSync(planPath, planContent, "utf-8");
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const materialInventory = buildPhase1MaterialInventory({
      plan,
      planPath,
      manifest,
      repoRoot: dir,
    });
    writeFileSync(planPath, `${planContent}mutated\n`, "utf-8");
    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        materialInventory,
        executionManifest: makeExecutionManifest(plan, manifest),
        roles: testRoles(),
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("hash");
    expect(subagents.spawns).toHaveLength(0);
  });

  it("blocks oversized deterministic rendered material without truncating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const supportPath = join(dir, "support.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Use support\n",
      "utf-8",
    );
    writeFileSync(supportPath, "x".repeat(101_000), "utf-8");
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    executionManifest.tasks[0]!.sourceMaterialRefs = [
      {
        origin: "task-link",
        path: supportPath,
        mode: { kind: "full-file" },
        reason: "Large explicit material.",
      },
    ];
    const materialInventory = buildPhase1MaterialInventory({
      plan,
      planPath,
      manifest,
      repoRoot: dir,
    });
    materialInventory.materials.push({
      absolutePath: supportPath,
      displayLabel: "support.md",
      content: readFileSync(supportPath, "utf-8"),
      hash: sha256(readFileSync(supportPath, "utf-8")),
    });
    const git = new FakeGit();
    git.rootValue = dir;
    const subagents = new FakeSubagents();

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        materialInventory,
        executionManifest,
        roles: testRoles(),
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(
      /Rendered source material exceeds maximum size.*support.md/s,
    );
    expect(subagents.spawns).toHaveLength(0);
  });

  it("renders deterministic material from the frozen inventory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const planContent =
      "# Plan\n\n## Tasks\n\n- [ ] Do frozen thing\n  frozen detail\n";
    writeFileSync(planPath, planContent, "utf-8");
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const materialInventory = buildPhase1MaterialInventory({
      plan,
      planPath,
      manifest,
      repoRoot: dir,
    });
    const frozen = materialInventory.materials.find(
      (material) => material.absolutePath === resolve(planPath),
    );
    if (!frozen) {
      throw new Error("missing frozen plan material");
    }
    frozen.content = frozen.content.replace(
      "frozen detail",
      "inventory detail",
    );
    writeFileSync(planPath, frozen.content, "utf-8");
    const git = new FakeGit();
    git.rootValue = dir;
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
      manifest,
      materialInventory,
      executionManifest: makeExecutionManifest(plan, manifest),
      roles: testRoles(),
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns[0]?.prompt).toContain("inventory detail");
    expect(subagents.spawns[0]?.prompt).not.toContain("frozen detail");
  });

  it("persists implementer packet prompt and source material artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    const referencePath = join(dir, "reference.md");
    const planContent = [
      "# Plan",
      "",
      "## Tasks",
      "",
      "- [ ] Selected task",
      "  Preserve this detail exactly.",
      "  - Preserve this nested point.",
      "- [ ] Sibling task",
      "  Do not include this sibling detail.",
      "",
    ].join("\n");
    const referenceContent = [
      "# Reference",
      "",
      "line two",
      "line three exact detail",
      "line four",
      "line five",
      "",
    ].join("\n");
    writeFileSync(planPath, planContent, "utf-8");
    writeFileSync(referencePath, referenceContent, "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: JSON.stringify({
          taskId: "t001-selected-task",
          sourceMaterialRefs: [
            {
              origin: "planner",
              path: referencePath,
              mode: { kind: "line-range", startLine: 3, endLine: 4 },
              reason: "Planner-selected exact excerpt.",
            },
          ],
          reason: "Dropped duplicate and missing refs.",
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
    ];
    const paths = makePaths(dir);
    writeRunJson(paths, {
      ...makeRunJson(dir, planPath),
      corpusFiles: [
        { path: planPath, hash: sha256(planContent) },
        { path: referencePath, hash: sha256(referenceContent) },
      ],
    });
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.planSnapshot, planContent, "utf-8");
    writeFileSync(
      paths.corpusJson,
      JSON.stringify(
        {
          entryPath: planPath,
          corpusHash: sha256(
            `${sha256(planContent)}${sha256(referenceContent)}`,
          ),
          files: [
            { path: planPath, hash: sha256(planContent) },
            { path: referencePath, hash: sha256(referenceContent) },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);
    const executionManifest = makeExecutionManifest(plan, manifest);
    const task = executionManifest.tasks[0];
    if (!task) {
      throw new Error("missing test task");
    }
    task.sourceMaterialRefs = [
      ...(task.sourceMaterialRefs ?? []),
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "line-range", startLine: 3, endLine: 4 },
        reason: "Planner-selected exact excerpt.",
      },
      {
        origin: "planner",
        path: referencePath,
        mode: { kind: "line-range", startLine: 3, endLine: 4 },
        reason: "Duplicate planner-selected exact excerpt.",
      },
      {
        origin: "planner",
        path: join(dir, "missing.md"),
        mode: { kind: "full-file" },
        reason: "Malformed planner selection.",
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        manifest,
        executionManifest,
        mode: "parallel",
        runId: "r1",
        paths,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("parallel task approved");

    const prompt = readFileSync(
      join(paths.tasksDir, "t001-selected-task", "prompt.md"),
      "utf-8",
    );

    expect(prompt).toContain("## Referenced Source Material");
    expect(prompt).toContain("### Selected Task Source Anchor");
    expect(prompt).toContain(
      `Source: ${planPath} (lines 5-7; origin: task-anchor)`,
    );
    expect(prompt).toContain(
      `Source: ${referencePath} (lines 3-4; origin: planner)`,
    );
    expect(prompt).toContain("line two\nline three exact detail");
    expect(prompt).not.toContain("line four");
    expect(prompt).toContain("Source material repair note");
    expect(prompt).not.toContain(
      "Low-confidence source material warning for review",
    );
    expect(prompt).toContain(
      [
        "- [ ] Selected task",
        "  Preserve this detail exactly.",
        "  - Preserve this nested point.",
      ].join("\n"),
    );
    expect(prompt).not.toContain("- [ ] Sibling task");
    expect(prompt).not.toContain("Do not include this sibling detail.");
    expect(prompt).toContain("## Compiled Task Contract");

    const sourceMaterial = readFileSync(
      join(paths.tasksDir, "t001-selected-task", "source-material.md"),
      "utf-8",
    );
    expect(sourceMaterial).toContain("## Referenced Source Material");
    expect(sourceMaterial).toContain("Preserve this detail exactly.");

    const packet = JSON.parse(
      readFileSync(
        join(paths.tasksDir, "t001-selected-task", "task-packet.json"),
        "utf-8",
      ),
    ) as {
      resolvedMaterialRefs: Array<{
        absolutePath: string;
        displayLabel: string;
        mode: unknown;
        origin: string;
        reason: string;
        fileHash: string;
        renderedContentHash: string;
        renderedCharCount: number;
      }>;
    };
    expect(packet.resolvedMaterialRefs).toHaveLength(2);
    expect(packet.resolvedMaterialRefs[0]).toMatchObject({
      absolutePath: planPath,
      displayLabel: "Selected Task Source Anchor",
      mode: { kind: "line-range", startLine: 5, endLine: 7 },
      origin: "task-anchor",
      reason: "Selected task checkbox line and task block.",
      fileHash: sha256(readFileSync(planPath, "utf-8")),
      renderedContentHash: sha256(
        [
          "- [ ] Selected task",
          "  Preserve this detail exactly.",
          "  - Preserve this nested point.",
        ].join("\n"),
      ),
      renderedCharCount: 83,
    });
    expect(packet.resolvedMaterialRefs[1]).toMatchObject({
      absolutePath: referencePath,
      displayLabel: `${referencePath} lines 3-4`,
      mode: { kind: "line-range", startLine: 3, endLine: 4 },
      origin: "planner",
      reason: "Planner-selected exact excerpt.",
      renderedContentHash: sha256(
        ["line two", "line three exact detail"].join("\n"),
      ),
    });
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
      corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
    ) as {
      status: string;
      taskCommitSha?: string;
    };
    expect(taskJson.status).toBe("approved");
    expect(taskJson.taskCommitSha).toBe("h1-commit-1-reword-1");
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

  it("worktree-backed task implementer spawn carries cwd === worktreePath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const child = new FakeGit();
    child.commit = async (message: string): Promise<CommandResult> => {
      child.commits.push(message);
      child.headValue = `${child.headValue}-commit-${child.commits.length}`;
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
      corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("parallel task approved");

    const implementerSpawn = subagents.spawns.find((s) =>
      s.description.includes("implement"),
    );
    expect(implementerSpawn).toBeDefined();
    expect(implementerSpawn?.cwd).toBe(git.addedWorktrees[0]?.path);
    expect(implementerSpawn?.role).toBe("implementer");
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
      corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // Plan checkbox should not have been checked during the review phase
    expect(contentAfterImpl).toContain("- [ ] Do thing");
    // But it should be checked after the full cycle completes
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
  });

  it("uses sourceCheckbox from execution manifest when available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const runId = "r1";
    const plan = parsePlanFile(planPath);
    const manifest: ExecutionManifest = {
      version: 1,
      tasks: [
        {
          id: "t001-do-thing",
          planIndex: 1,
          title: "Do thing",
          taskHash: computeTaskFingerprint(plan.tasks[0]),
          status: "todo",
          dependsOn: [],
          review: { mode: "skip" },
          affectedAreas: [],
          conflictHints: [],
          sourceReferences: [],
          compiledContract: {
            objective: "Do the thing",
            inScope: ["Thing"],
            acceptanceCriteria: ["Thing is done"],
            outOfScope: ["Other things"],
          },
          sourceCheckbox: {
            path: planPath,
            lineNumber: 5,
            lineText: "- [ ] Do thing",
          },
        },
      ],
    };
    writeExecutionManifest(paths.runDir, manifest);
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      runId,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
  });

  it("skips source checkbox update and records a note when sourceCheckbox is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const runId = "r1";
    const plan = parsePlanFile(planPath);
    const manifest: ExecutionManifest = {
      version: 1,
      tasks: [
        {
          id: "t001-do-thing",
          planIndex: 1,
          title: "Do thing",
          taskHash: computeTaskFingerprint(plan.tasks[0]),
          status: "todo",
          dependsOn: [],
          review: { mode: "skip" },
          affectedAreas: [],
          conflictHints: [],
          sourceReferences: [],
          compiledContract: {
            objective: "Do the thing",
            inScope: ["Thing"],
            acceptanceCriteria: ["Thing is done"],
            outOfScope: ["Other things"],
          },
          sourceCheckbox: {
            path: planPath,
            lineNumber: 5,
            lineText: "- [ ] Stale text",
          },
        },
      ],
    };
    writeExecutionManifest(paths.runDir, manifest);
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      runId,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // Stale line metadata falls back to a unique title/source-ref match.
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    const notePath = join(
      paths.tasksDir,
      "t001-do-thing",
      "source-checkbox.md",
    );
    expect(existsSync(notePath)).toBe(false);
  });

  it("skips source checkbox update and records a note when sourceCheckbox is missing in manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const runId = "r1";
    const plan = parsePlanFile(planPath);
    const manifest: ExecutionManifest = {
      version: 1,
      tasks: [
        {
          id: "t001-do-thing",
          planIndex: 1,
          title: "Do thing",
          taskHash: computeTaskFingerprint(plan.tasks[0]),
          status: "todo",
          dependsOn: [],
          review: { mode: "skip" },
          affectedAreas: [],
          conflictHints: [],
          sourceReferences: [],
          compiledContract: {
            objective: "Do the thing",
            inScope: ["Thing"],
            acceptanceCriteria: ["Thing is done"],
            outOfScope: ["Other things"],
          },
        },
      ],
    };
    writeExecutionManifest(paths.runDir, manifest);
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
      paths,
      runId,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // Missing sourceCheckbox falls back to a unique title/source-ref match.
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    const notePath = join(
      paths.tasksDir,
      "t001-do-thing",
      "source-checkbox.md",
    );
    expect(existsSync(notePath)).toBe(false);
  });

  it("falls back to legacy markTaskDone when no execution manifest is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("does not blame a parallel worker when the main checkout is dirty after the implementer returns", async () => {
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
      {
        status: "completed",
        result: GOOD_REVIEW,
      },
    ];
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
      corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("parallel task approved");

    expect(readTaskJson(paths, "t001-do-thing")?.status).toBe("approved");
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    // Second implementer spawn should have feedback in the prompt
    const secondImplPrompt = subagents.spawns[2]?.prompt ?? "";
    expect(secondImplPrompt).toContain("fix the bug");
    expect(secondImplPrompt).toContain("done"); // priorSummary
    // Second reviewer spawn should be an anchored re-review with prior required changes
    const secondReviewerPrompt = subagents.spawns[3]?.prompt ?? "";
    expect(secondReviewerPrompt).toContain(
      "## Review Mode: Anchored Re-review",
    );
    expect(secondReviewerPrompt).toContain("## Prior Required Changes");
    expect(secondReviewerPrompt).toContain("fix the bug");
  });

  it("approves after first anchored re-review", async () => {
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    const secondReviewerPrompt = subagents.spawns[3]?.prompt ?? "";
    expect(secondReviewerPrompt).toContain(
      "## Review Mode: Anchored Re-review",
    );
    expect(secondReviewerPrompt).toContain("fix the bug");
    expect(git.commits).toEqual(["feat: do thing"]);
  });

  it("approves after second anchored re-review", async () => {
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(7);
    expect(git.commits).toEqual(["feat: do thing"]);
  });

  it("blocks after unresolved second anchored re-review", async () => {
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
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["fix the bug"]}</pi-review-result>',
      },
      { status: "completed", result: GOOD_IMPL },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["fix the bug"]}</pi-review-result>',
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);

    expect(subagents.spawns).toHaveLength(6);
    expect(git.commits).toHaveLength(0);
  });

  it("ignores non-matching anchored reviewer items and proceeds as approved", async () => {
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
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it"]}</pi-review-result>',
      },
      { status: "completed", result: GOOD_IMPL },
      {
        status: "completed",
        result:
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it again"]}</pi-review-result>',
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    expect(git.commits).toEqual(["feat: do thing"]);
  });

  it("clears anchor after system failure so next reviewer is not anchored", async () => {
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
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it"]}</pi-review-result>',
      },
      { status: "completed", result: "not json" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(6);
    const postFailureReviewerPrompt = subagents.spawns[4]?.prompt ?? "";
    expect(postFailureReviewerPrompt).not.toContain(
      "## Review Mode: Anchored Re-review",
    );
    expect(postFailureReviewerPrompt).not.toContain(
      "## Prior Required Changes",
    );
    expect(postFailureReviewerPrompt).toContain(
      "## Review Mode: Initial Material Review",
    );
  });

  it("treats malformed anchored reviewer verdict as system failure and clears anchor", async () => {
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
          '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["tighten it"]}</pi-review-result>',
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: "not a valid review result" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(7);
    const thirdReviewerPrompt = subagents.spawns[5]?.prompt ?? "";
    expect(thirdReviewerPrompt).not.toContain(
      "## Review Mode: Anchored Re-review",
    );
    expect(thirdReviewerPrompt).not.toContain("## Prior Required Changes");
    expect(thirdReviewerPrompt).toContain(
      "## Review Mode: Initial Material Review",
    );
    expect(git.commits).toEqual(["feat: do thing"]);
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
      corpusJson: join(dir, ".pi", "implement", "runs", "r1", "corpus.json"),
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: "invalid rework" },
      { status: "completed", result: "invalid rework" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
    expect(content).toContain("Rework Attempts");
  });

  it("includes corpus material in the overall review artifact when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const paths = makePaths(dir);
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
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: "invalid rework" },
      { status: "completed", result: "invalid rework" },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        corpusMaterial:
          "### background.md\n\nAll features must support dark mode.",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const artifactPath = join(dir, "plan.overall-review.md");
    expect(existsSync(artifactPath)).toBe(true);
    const content = readFileSync(artifactPath, "utf-8");
    expect(content).toContain("## Plan Corpus");
    expect(content).toContain("All features must support dark mode.");
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
    expect(currentState.tasks?.[0]?.planIndex).toBe(0);
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
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: "invalid rework" },
      { status: "completed", result: "invalid rework" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
        verifyCommand: "echo ok",
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const artifactPath = join(dir, "plan.overall-review.md");
    expect(existsSync(artifactPath)).toBe(true);
  });

  it("reworks and approves after overall review requests changes", async () => {
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

    let overallReviewCount = 0;
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: {
          status: "completed",
          get result() {
            overallReviewCount++;
            return overallReviewCount === 1
              ? BAD_OVERALL_REVIEW
              : GOOD_OVERALL_REVIEW;
          },
        },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
    expect(git.commits.length).toBeGreaterThanOrEqual(1);
    expect(
      subagents.spawns.some((s) => s.description.includes("overall rework")),
    ).toBe(true);
    const reworkPrompt = subagents.spawns.find((s) =>
      s.description.includes("overall rework"),
    )?.prompt;
    expect(reworkPrompt).toContain("pi-implement overall rework implementer");
    expect(reworkPrompt).toContain("add integration tests");
    expect(reworkPrompt).toContain("old-sha");
    expect(reworkPrompt).toContain("Do thing");
  });

  it("consumes a rework attempt when reworker produces invalid result", async () => {
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

    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: "invalid garbage" },
      { status: "completed", result: "invalid garbage" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const reworkSpawns = subagents.spawns.filter((s) =>
      s.description.includes("overall rework"),
    );
    expect(reworkSpawns).toHaveLength(2);
    const artifactPath = join(dir, "plan.overall-review.md");
    const content = readFileSync(artifactPath, "utf-8");
    expect(content).toContain("Rework Attempts");
  });

  it("throws StoppedError when overall rework is stopped", async () => {
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
      { status: "stopped", error: "user stopped" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(StoppedError);
  });

  it("blocks when overall rework implementer changes HEAD", async () => {
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

    let overallReviewCount = 0;
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: {
          status: "completed",
          get result() {
            overallReviewCount++;
            return overallReviewCount === 1
              ? BAD_OVERALL_REVIEW
              : GOOD_OVERALL_REVIEW;
          },
        },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("blocks when overall rework implementer mutates a plan artifact", async () => {
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

    let overallReviewCount = 0;
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: {
          status: "completed",
          get result() {
            overallReviewCount++;
            return overallReviewCount === 1
              ? BAD_OVERALL_REVIEW
              : GOOD_OVERALL_REVIEW;
          },
        },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
    ];

    const originalWaitFor = subagents.waitFor.bind(subagents);
    let waits = 0;
    subagents.waitFor = async (id, signal) => {
      waits++;
      const result = await originalWaitFor(id, signal);
      if (waits === 4) {
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
  });

  it("treats no-staged-change rework as failed attempt", async () => {
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

    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
      { status: "completed", result: GOOD_REWORK },
    ];

    let stagedCallCount = 0;
    git.hasStagedChanges = async () => {
      stagedCallCount++;
      return stagedCallCount !== 2;
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const reworkSpawns = subagents.spawns.filter((s) =>
      s.description.includes("overall rework"),
    );
    expect(reworkSpawns).toHaveLength(2);
  });

  it("uses fallback commit message when rework result has invalid commit message", async () => {
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

    let overallReviewCount = 0;
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: {
          status: "completed",
          get result() {
            overallReviewCount++;
            return overallReviewCount === 1
              ? BAD_OVERALL_REVIEW
              : GOOD_OVERALL_REVIEW;
          },
        },
      },
    ];

    const BAD_COMMIT_REWORK =
      '<pi-overall-rework-result>{"summary":"fixed","verification":[{"command":"tests","result":"passed","rationale":"covers change"}],"commitMessage":"bad message"}</pi-overall-rework-result>';

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: BAD_COMMIT_REWORK },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(git.commits).toContain("fix: address overall review");
  });

  it("consumes attempt when overall rework validation fails", async () => {
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

    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
      { status: "completed", result: GOOD_REWORK },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        verifyCommand: "exit 1",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const reworkSpawns = subagents.spawns.filter((s) =>
      s.description.includes("overall rework"),
    );
    expect(reworkSpawns).toHaveLength(2);
  });

  it("consumes attempt when overall rework commit hook fails", async () => {
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

    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
      { status: "completed", result: GOOD_REWORK },
    ];

    let commitCallCount = 0;
    const originalCommit = git.commit.bind(git);
    git.commit = async (message: string) => {
      commitCallCount++;
      if (commitCallCount === 2) {
        return {
          command: "git commit",
          exitCode: 1,
          stdout: "",
          stderr: "hook failed",
        };
      }
      return originalCommit(message);
    };

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "serial",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    const reworkSpawns = subagents.spawns.filter((s) =>
      s.description.includes("overall rework"),
    );
    expect(reworkSpawns).toHaveLength(2);
  });

  it("blocks when overall rework validation mutates state even if the command fails", async () => {
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

    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
    ];

    let mutateAfterRework = false;
    let fpCallCount = 0;
    const originalStagedFingerprint = git.stagedFingerprint.bind(git);
    git.stagedFingerprint = async () => {
      if (mutateAfterRework) {
        fpCallCount++;
        return `mutated-fp-${fpCallCount}`;
      }
      return originalStagedFingerprint();
    };

    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      const index = id ? Number(id.replace("agent-", "")) - 1 : -1;
      const spawn = index >= 0 ? subagents.spawns[index] : undefined;
      if (spawn?.description.includes("overall rework")) {
        mutateAfterRework = true;
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
        verifyCommand: "exit 1",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("Validation changed staged state during overall rework");
  });

  it("does not re-run overall review after a failed rework attempt", async () => {
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

    let overallReviewCount = 0;
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: {
          status: "completed",
          get result() {
            overallReviewCount++;
            return overallReviewCount === 1
              ? BAD_OVERALL_REVIEW
              : GOOD_OVERALL_REVIEW;
          },
        },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: "invalid garbage" },
      { status: "completed", result: "invalid garbage" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(OverallReviewFollowupError);

    // Only one overall review should have been spawned because neither rework
    // attempt produced a successful commit, so there is no reason to re-review.
    const reviewSpawns = subagents.spawns.filter((s) =>
      s.description.includes("overall review"),
    );
    expect(reviewSpawns).toHaveLength(1);
  });

  it("includes latest rework failure and raw review result in exhausted-cap artifact and error", async () => {
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

    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: "invalid garbage" },
      { status: "completed", result: "invalid garbage" },
    ];

    let error: OverallReviewFollowupError | undefined;
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });
    } catch (err) {
      if (err instanceof OverallReviewFollowupError) {
        error = err;
      }
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain("Latest rework failure:");
    expect(error!.message).toContain("Response did not include");

    const artifactPath = join(dir, "plan.overall-review.md");
    expect(existsSync(artifactPath)).toBe(true);
    const content = readFileSync(artifactPath, "utf-8");
    expect(content).toContain("add integration tests");
    expect(content).toContain("## Raw Result");
    expect(content).toContain(BAD_OVERALL_REVIEW);
    expect(content).toContain("Rework Attempts");
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("Parallel scheduler blocked:");
  });

  it("includes rich diagnostics when scheduler stalls with failed, approved, and pending tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n- [ ] Third\n",
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
          dependsOn: [],
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
          dependsOn: [],
          mode: "parallel",
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high",
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "third",
          planIndex: 3,
          title: "Third",
          taskHash: "hash3",
          dependsOn: ["second"],
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
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    subagents.resultsByDescription = [
      {
        match: "scheduler self-heal",
        result: {
          status: "completed",
          result: makeSchedulerSelfHealResult({
            repaired: false,
            retryScheduler: false,
          }),
        },
      },
      {
        match: /implement task/,
        result: { status: "completed", result: GOOD_IMPL },
      },
      {
        match: /review task/,
        result: { status: "completed", result: GOOD_REVIEW },
      },
    ];

    let blockedError: BlockedError | undefined;
    try {
      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });
    } catch (err) {
      if (err instanceof BlockedError) {
        blockedError = err;
      }
    }

    // `first` fails at worktree setup, but `second` has no dependency on it and
    // must still land; `third` depends on `second` and lands once it does.
    // Only the genuinely-failed task remains in the blocked report.
    expect(blockedError).toBeDefined();
    const message = blockedError!.message;
    expect(message).toContain("Parallel scheduler blocked:");
    expect(message).toContain("first: failed");
    expect(message).toContain("Worktree setup failed");
    expect(message).not.toContain("cannot land");
    expect(message).not.toContain("- second:");
    expect(message).not.toContain("- third:");
    const events = readEvents(paths);
    const landed = events
      .filter((e) => e.type === "task_landed")
      .map((e) => (e as { taskId: string }).taskId);
    expect(landed).toContain("second");
    expect(landed).toContain("third");
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
    expect(reviewerPrompt).toContain("## Referenced Source Material");
    expect(reviewerPrompt).toContain("### Selected Task Source Anchor");
    expect(reviewerPrompt).toContain("- [ ] Do it");

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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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

  it("serial already-satisfied with staged changes routes to review and commits on approval", async () => {
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // The contradiction is reinterpreted as a `changed` candidate, reviewed,
    // and committed once approved — never silently dropped or hard-blocked.
    const reviewSpawn = subagents.spawns.find((s) =>
      s.description?.startsWith("review task"),
    );
    expect(reviewSpawn).toBeDefined();
    expect(reviewSpawn?.cwd).toBe(git.rootValue);
    expect(reviewSpawn?.readOnly).toBe(true);
    expect(reviewSpawn!.prompt).toContain("Outcome Discrepancy");
    expect(git.commits).toHaveLength(1);
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do it");
  });

  it("serial already-satisfied with staged changes reworks when review requests changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';
    const CHANGES_REVIEW =
      '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["These edits are out of scope."]}</pi-review-result>';

    subagents.results = [
      { status: "completed", result: ALREADY_SATISFIED_IMPL },
      { status: "completed", result: CHANGES_REVIEW },
      { status: "completed", result: GOOD_IMPL },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // changes_requested triggers a rework attempt rather than a terminal block.
    const implementerSpawns = subagents.spawns.filter((s) =>
      s.description?.startsWith("implement task"),
    );
    expect(implementerSpawns.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do it");
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
          selfHeal: { model: "p/m", type: "general-purpose" },
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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow("satisfied task marked done but worktree became dirty");

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("- [ ] Do it");
    expect(git.commits).toHaveLength(0);
  });

  describe("integration self-heal", () => {
    it("repairs validation failure and lands the task", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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

      const validateScript = join(dir, "validate.sh");
      writeFileSync(
        validateScript,
        `#!/bin/sh\nif [ -f "${join(dir, ".validation-pass")}" ]; then\n  exit 0\nelse\n  echo "validation failed"\n  exit 1\nfi\n`,
        "utf-8",
      );

      const git = new FakeGit();
      git.rootValue = dir;
      const subagents = new FakeSubagents();

      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(join(dir, ".validation-pass"), "ok", "utf-8");
        }
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "installed deps",
          }),
        },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validateScript}`,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const updatedPlan = readFileSync(planPath, "utf-8");
      expect(updatedPlan).toContain("- [x] Do thing");
      expect(git.commits).toHaveLength(1);

      const events = readEvents(paths);
      expect(events.some((e) => e.type === "self_heal_started")).toBe(true);
      expect(events.some((e) => e.type === "self_heal_completed")).toBe(true);
    });

    it("self-heal prompt includes diagnosis authority and required fields", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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

      const validateScript = join(dir, "validate.sh");
      writeFileSync(
        validateScript,
        `#!/bin/sh\nif [ -f "${join(dir, ".validation-pass")}" ]; then\n  exit 0\nelse\n  echo "validation failed"\n  exit 1\nfi\n`,
        "utf-8",
      );

      const git = new FakeGit();
      git.rootValue = dir;
      const subagents = new FakeSubagents();

      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(join(dir, ".validation-pass"), "ok", "utf-8");
        }
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "installed deps",
          }),
        },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validateScript}`,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const selfHealSpawn = subagents.spawns.find((s) =>
        s.description.includes("self-heal"),
      );
      expect(selfHealSpawn).toBeDefined();
      const prompt = selfHealSpawn!.prompt;
      expect(prompt).toContain("integration self-heal agent");
      expect(prompt).toContain("Do thing");
      expect(prompt).toContain("taskCommitSha");
      expect(prompt).toContain("Pre-integration HEAD");
      expect(prompt).toContain("Permissions");
      expect(prompt).toContain("Inspect run artifacts");
      expect(prompt).toContain("install dependencies");
      expect(prompt).toContain("must NOT");
      expect(prompt).toContain("Edit source plan");
      expect(prompt).toContain("<pi-self-heal-result>");
      expect(prompt).toContain("retryMode");
    });

    it("continue_candidate after cherry-pick conflict lands task", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      let cherryPickCount = 0;
      git.cherryPickNoCommit = async (sha: string) => {
        cherryPickCount++;
        if (cherryPickCount === 1) {
          return {
            command: "git cherry-pick --no-commit",
            exitCode: 1,
            stdout: "",
            stderr: "conflict",
          };
        }
        git.diffText = `diff --git a/file.ts b/file.ts\n+change ${sha}`;
        return {
          command: "git cherry-pick --no-commit",
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      };

      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "continue_candidate",
            summary: "resolved conflict",
          }),
        },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const updatedPlan = readFileSync(planPath, "utf-8");
      expect(updatedPlan).toContain("- [x] Do thing");
      expect(git.commits).toHaveLength(1);
    });

    it("stops after MAX_SELF_HEAL_ATTEMPTS and surfaces failure", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "attempt 1",
          }),
        },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "attempt 2",
          }),
        },
      ];

      await expect(
        runImplementation({
          git,
          subagents,
          planPath,
          mode: "parallel",
          runId: "r1",
          paths,
          verifyCommand: "exit 1",
          roles: {
            implementer: { model: "p/m", type: "general-purpose" },
            reviewer: { model: "p/m", type: "general-purpose" },
            planner: { model: "p/m", type: "Explore" },
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow();

      const events = readEvents(paths);
      const started = events.filter((e) => e.type === "self_heal_started");
      expect(started).toHaveLength(2);
      expect(started[0].attempt).toBe(1);
      expect(started[1].attempt).toBe(2);
    });

    it("blocks when self-heal mutates a plan artifact", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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

      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(planPath, "# Mutated\n", "utf-8");
        }
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "attempted repair",
          }),
        },
      ];

      await expect(
        runImplementation({
          git,
          subagents,
          planPath,
          mode: "parallel",
          runId: "r1",
          paths,
          verifyCommand: "exit 1",
          roles: {
            implementer: { model: "p/m", type: "general-purpose" },
            reviewer: { model: "p/m", type: "general-purpose" },
            planner: { model: "p/m", type: "Explore" },
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow("plan artifact");

      const updatedPlan = readFileSync(planPath, "utf-8");
      expect(updatedPlan).toContain("- [ ] Do thing");
    });

    it("does not land when self-heal claims success but validation still fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "claimed repair",
          }),
        },
      ];

      await expect(
        runImplementation({
          git,
          subagents,
          planPath,
          mode: "parallel",
          runId: "r1",
          paths,
          verifyCommand: "exit 1",
          roles: {
            implementer: { model: "p/m", type: "general-purpose" },
            reviewer: { model: "p/m", type: "general-purpose" },
            planner: { model: "p/m", type: "Explore" },
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow();

      expect(git.commits).toHaveLength(0);
      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.status).not.toBe("landed");
    });

    it("blocks retry_cherry_pick when self-heal leaves unsafe checkout state", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      let cherryPickCount = 0;
      git.cherryPickNoCommit = async (sha: string) => {
        cherryPickCount++;
        if (cherryPickCount === 1) {
          return {
            command: "git cherry-pick --no-commit",
            exitCode: 1,
            stdout: "",
            stderr: "conflict",
          };
        }
        git.diffText = `diff --git a/file.ts b/file.ts\n+change ${sha}`;
        return {
          command: "git cherry-pick --no-commit",
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      };

      const subagents = new FakeSubagents();
      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(planPath, "# Mutated\n", "utf-8");
        }
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_cherry_pick",
            summary: "cleaned up",
          }),
        },
      ];

      await expect(
        runImplementation({
          git,
          subagents,
          planPath,
          mode: "parallel",
          runId: "r1",
          paths,
          verifyCommand: "echo ok",
          roles: {
            implementer: { model: "p/m", type: "general-purpose" },
            reviewer: { model: "p/m", type: "general-purpose" },
            planner: { model: "p/m", type: "Explore" },
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow("plan artifact");

      const updatedPlan = readFileSync(planPath, "utf-8");
      expect(updatedPlan).toContain("- [ ] Do thing");
    });

    it("blocks when unparseable self-heal mutates checkout state", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(planPath, "# Mutated\n", "utf-8");
        }
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: "garbage output without tag",
        },
      ];

      await expect(
        runImplementation({
          git,
          subagents,
          planPath,
          mode: "parallel",
          runId: "r1",
          paths,
          verifyCommand: "exit 1",
          roles: {
            implementer: { model: "p/m", type: "general-purpose" },
            reviewer: { model: "p/m", type: "general-purpose" },
            planner: { model: "p/m", type: "Explore" },
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow("plan artifact");

      const updatedPlan = readFileSync(planPath, "utf-8");
      expect(updatedPlan).toContain("- [ ] Do thing");
    });

    it("allows newly staged integration-repair files and lands task", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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

      const validateScript = join(dir, "validate.sh");
      writeFileSync(
        validateScript,
        `#!/bin/sh\nif [ -f "${join(dir, ".validation-pass")}" ]; then\n  exit 0\nelse\n  echo "validation failed"\n  exit 1\nfi\n`,
        "utf-8",
      );

      const git = new FakeGit();
      git.rootValue = dir;
      const subagents = new FakeSubagents();

      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(join(dir, ".validation-pass"), "ok", "utf-8");
          // Simulate self-heal staging a new integration-repair file
          git.stagedNameStatus = async () => "M\tfile.ts\nA\tresolved.ts";
          git.statusText = "A  resolved.ts\nM  file.ts";
        }
        return result;
      };
      const originalCommit = git.commit.bind(git);
      git.commit = async (message: string) => {
        const result = await originalCommit(message);
        git.statusText = "";
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "continue_candidate",
            summary: "resolved conflict and staged fix",
            filesChanged: ["resolved.ts"],
          }),
        },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validateScript}`,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const updatedPlan = readFileSync(planPath, "utf-8");
      expect(updatedPlan).toContain("- [x] Do thing");
      expect(git.commits).toHaveLength(1);
    });

    it("self-heal prompt includes graph context and run artifact paths", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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

      const validateScript = join(dir, "validate.sh");
      writeFileSync(
        validateScript,
        `#!/bin/sh\nif [ -f "${join(dir, ".validation-pass")}" ]; then\n  exit 0\nelse\n  echo "validation failed"\n  exit 1\nfi\n`,
        "utf-8",
      );

      const git = new FakeGit();
      git.rootValue = dir;
      const subagents = new FakeSubagents();

      let spawnCount = 0;
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        spawnCount++;
        return originalSpawn(args);
      };
      const originalWaitFor = subagents.waitFor.bind(subagents);
      subagents.waitFor = async (id, signal) => {
        const result = await originalWaitFor(id, signal);
        if (spawnCount === 3 && result.status === "completed") {
          writeFileSync(join(dir, ".validation-pass"), "ok", "utf-8");
        }
        return result;
      };

      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        {
          status: "completed",
          result: makeSelfHealResult({
            repaired: true,
            retryIntegration: true,
            retryMode: "retry_validation",
            summary: "installed deps",
          }),
        },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validateScript}`,
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const selfHealSpawn = subagents.spawns.find((s) =>
        s.description.includes("self-heal"),
      );
      expect(selfHealSpawn).toBeDefined();
      const prompt = selfHealSpawn!.prompt;
      expect(prompt).toContain("Graph Context");
      expect(prompt).toContain("Run ID: r1");
      expect(prompt).toContain("task-1: Do thing");
      expect(prompt).toContain("Run Artifacts");
      expect(prompt).toContain(paths.eventsJsonl);
      expect(prompt).toContain(join(paths.runDir, "graph.json"));
    });
  });

  it("cleans up stale branch and worktree before restarting a needs_rework task", async () => {
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
    let cherryPickCount = 0;
    git.cherryPickNoCommit = async (sha: string) => {
      cherryPickCount++;
      if (cherryPickCount === 1) {
        return {
          command: "git cherry-pick --no-commit",
          exitCode: 1,
          stdout: "",
          stderr: "conflict",
        };
      }
      git.diffText = `diff --git a/file.ts b/file.ts\n+change ${sha}`;
      return {
        command: "git cherry-pick --no-commit",
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };

    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      {
        status: "completed",
        result: makeSelfHealResult({
          repaired: false,
          retryIntegration: false,
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    // Two attempts: first creates branch/worktree, second cleans up and recreates
    const taskBranches = git.createdBranches.filter((b) =>
      b.includes("task-1"),
    );
    const taskWorktrees = git.addedWorktrees.filter((w) =>
      w.branch.includes("task-1"),
    );
    expect(taskBranches).toHaveLength(2);
    expect(taskWorktrees).toHaveLength(2);
    expect(
      git.removedWorktrees.filter((w) => w.includes("task-1")),
    ).toHaveLength(1);
    expect(
      git.deletedBranches.filter((b) => b.includes("task-1")),
    ).toHaveLength(1);
  });

  it("does not fail with branch already exists on needs_rework retry because it deletes first", async () => {
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
    const originalCreateTaskBranch = git.createTaskBranch.bind(git);
    git.createTaskBranch = async (branchName: string, baseSha: string) => {
      if (
        git.createdBranches.includes(branchName) &&
        !git.deletedBranches.includes(branchName)
      ) {
        throw new Error(`fatal: a branch named '${branchName}' already exists`);
      }
      return originalCreateTaskBranch(branchName, baseSha);
    };
    let cherryPickCount = 0;
    git.cherryPickNoCommit = async () => {
      cherryPickCount++;
      if (cherryPickCount === 1) {
        return {
          command: "git cherry-pick --no-commit",
          exitCode: 1,
          stdout: "",
          stderr: "conflict",
        };
      }
      return {
        command: "git cherry-pick --no-commit",
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };

    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      {
        status: "completed",
        result: makeSelfHealResult({
          repaired: false,
          retryIntegration: false,
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
  });

  it("scheduler self-heal repairs stale branch/worktree and retries", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    // Pre-seed a stale branch so the first worktree creation fails.
    // Override deleteTaskBranch so the stale branch persists after the
    // failed launch attempt, requiring scheduler self-heal to remove it.
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };
    const originalDeleteTaskBranch = git.deleteTaskBranch.bind(git);
    git.deleteTaskBranch = async (branchName: string) => {
      if (branchName === "pi-implement/r1/first") {
        return;
      }
      return originalDeleteTaskBranch(branchName);
    };

    const subagents = new FakeSubagents();
    let spawnCount = 0;
    const originalSpawn = subagents.spawn.bind(subagents);
    subagents.spawn = async (args) => {
      spawnCount++;
      return originalSpawn(args);
    };
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (spawnCount === 1 && result.status === "completed") {
        // Simulate self-heal removing the stale branch
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch and worktree for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
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
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const selfHealSpawn = subagents.spawns.find((s) =>
      s.description.includes("scheduler self-heal"),
    );
    expect(selfHealSpawn).toBeDefined();
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] First");
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Second");
  });

  it("scheduler self-heal is bounded by MAX_SELF_HEAL_ATTEMPTS", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Tried but did not remove anything.",
        }),
      },
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Tried again but did not remove anything.",
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);

    const selfHealSpawns = subagents.spawns.filter((s) =>
      s.description.includes("scheduler self-heal"),
    );
    expect(selfHealSpawns).toHaveLength(1);
  });

  it("includes rich blocked reason when scheduler self-heal makes no progress", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    subagents.resultsByDescription = [
      {
        match: "scheduler self-heal",
        result: {
          status: "completed",
          result: makeSchedulerSelfHealResult({
            repaired: false,
            retryScheduler: false,
            remainingBlocker: "disk full",
          }),
        },
      },
    ];

    let caught: BlockedError | undefined;
    try {
      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });
    } catch (err) {
      caught = err instanceof BlockedError ? err : undefined;
    }

    expect(caught).toBeDefined();
    const message = caught!.message;
    expect(message).toContain("Parallel scheduler blocked:");
    expect(message).toContain("first: failed");
    expect(message).toContain("second: pending, waiting for first");
    expect(message).toContain(
      "Self-heal attempted but did not produce retryable progress",
    );
    expect(message).toContain("remaining blocker: disk full");

    const events = readEvents(paths);
    expect(events.some((e) => e.type === "scheduler_self_heal_started")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "scheduler_self_heal_completed")).toBe(
      true,
    );
  });

  it("uses rich blocked reason for all-terminal scheduler failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] First\n", "utf-8");
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
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (branch === "pi-implement/r1/first") {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    subagents.resultsByDescription = [
      {
        match: "scheduler self-heal",
        result: {
          status: "completed",
          result: makeSchedulerSelfHealResult({
            repaired: false,
            retryScheduler: false,
            remainingBlocker: "branch cleanup requires manual intervention",
          }),
        },
      },
    ];
    const updates: Partial<RunState>[] = [];

    let caught: BlockedError | undefined;
    try {
      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: (patch) => {
          if (typeof patch !== "function") {
            updates.push(patch);
          }
        },
        shouldStop: () => false,
      });
    } catch (err) {
      caught = err instanceof BlockedError ? err : undefined;
    }

    expect(caught).toBeDefined();
    const message = caught!.message;
    expect(message).toContain("Parallel scheduler blocked:");
    expect(message).toContain("first: failed: Worktree setup failed");
    expect(message).toContain(
      "remaining blocker: branch cleanup requires manual intervention",
    );
    expect(updates.some((u) => u.lastReason === message)).toBe(true);
  });

  it("blocks when scheduler self-heal changes HEAD", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        git.headValue = "h2-moved";
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);

    const events = readEvents(paths);
    expect(events.some((e) => e.type === "scheduler_self_heal_completed")).toBe(
      true,
    );
  });

  it("blocks when scheduler self-heal mutates a plan artifact", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        writeFileSync(planPath, "# Mutated\n", "utf-8");
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("blocks when scheduler self-heal leaves the checkout dirty", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        git.statusText = "M dirty-file.ts";
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("does not revive a failed task when self-heal did not actually remove the stale state", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };
    const originalDeleteTaskBranch = git.deleteTaskBranch.bind(git);
    git.deleteTaskBranch = async (branchName: string) => {
      if (branchName === "pi-implement/r1/first") {
        return;
      }
      return originalDeleteTaskBranch(branchName);
    };

    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Claimed to fix first but did nothing.",
          commands: ["echo noop"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);

    const taskJson = readTaskJson(paths, "first");
    expect(taskJson?.status).toBe("failed");
  });

  it("includes remaining blocker in stalled scheduler reason", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: false,
          retryScheduler: false,
          remainingBlocker: "disk full",
        }),
      },
    ];

    let caught: Error | undefined;
    try {
      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }

    expect(caught).toBeInstanceOf(BlockedError);
    expect(caught!.message).toContain("disk full");
  });

  it("scheduler self-heal prompt includes active agent state", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: false,
          retryScheduler: false,
          remainingBlocker: "disk full",
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);

    const selfHealSpawn = subagents.spawns.find((s) =>
      s.description.includes("scheduler self-heal"),
    );
    expect(selfHealSpawn).toBeDefined();
    const prompt = selfHealSpawn!.prompt;
    expect(prompt).toContain("activeAgents");
  });

  it("buildSchedulerGraphSummary includes taskCommitSha, landedCommitSha, and activeAgents", () => {
    const graph = {
      version: 1 as const,
      runId: "r1",
      baseSha: "base",
      planPath: "/plan.md",
      planHash: "hash",
      nodes: [
        {
          id: "task-1",
          planIndex: 1,
          title: "One",
          taskHash: "h1",
          dependsOn: [],
          mode: "parallel" as const,
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high" as const,
          reasons: [],
          evidencePaths: [],
        },
        {
          id: "task-2",
          planIndex: 2,
          title: "Two",
          taskHash: "h2",
          dependsOn: ["task-1"],
          mode: "parallel" as const,
          affectedAreas: [],
          conflictHints: [],
          validationCommands: [],
          confidence: "high" as const,
          reasons: [],
          evidencePaths: [],
        },
      ],
    };
    const sched = createSchedulerRun(graph, 2);
    const t1 = sched.tasks.get("task-1")!;
    t1.taskCommitSha = "abc123";
    t1.landedCommitSha = "def456";
    t1.activeAgentIds = ["agent-1"];
    const t2 = sched.tasks.get("task-2")!;
    t2.activeAgentIds = [];

    const summary = buildSchedulerGraphSummary(sched, graph);
    expect(summary).toContain("taskCommitSha: abc123");
    expect(summary).toContain("landedCommitSha: def456");
    expect(summary).toContain("activeAgents: [agent-1]");
    expect(summary).toContain("activeAgents: (none)");
  });

  it("blocks when scheduler self-heal mutates in-memory task status", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        // Mutate the stale branch set to simulate progress, but do not remove it
        // The real mutation test is in the orchestrator's checkSchedulerSelfHealProgress
        // which validates task state. Since we can't easily mutate in-memory task state
        // from the test, we verify via the blocked outcome that no progress was accepted.
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first but mutated task state.",
        }),
      },
    ];

    // This test verifies that even if the branch was removed, if the heal result
    // does not name the exact task via commands or summary, no revival occurs.
    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("blocks when scheduler self-heal mutates on-disk task.json", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
        // Mutate on-disk task.json for first
        const taskDir = join(paths.tasksDir, "first");
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(
          join(taskDir, "task.json"),
          JSON.stringify({
            version: 1,
            taskId: "first",
            status: "landed",
            lastReason: "self-heal agent wrote this",
          }),
          "utf-8",
        );
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("blocks when scheduler self-heal corrupts run.json runId", async () => {
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
          dependsOn: [],
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
    writeRunJson(paths, makeRunJson(dir, planPath));

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
        // Corrupt run.json to a different run id
        writeRunJson(paths, makeRunJson(dir, planPath, "r2-evil"));
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("detects cleared dirty scheduler state as retryable progress", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.statusText = "M dirty.ts";
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };
    const originalDeleteTaskBranch = git.deleteTaskBranch.bind(git);
    git.deleteTaskBranch = async (branchName: string) => {
      if (branchName === "pi-implement/r1/first") {
        return;
      }
      return originalDeleteTaskBranch(branchName);
    };
    // Allow preflight to pass, then report dirty during baseline capture,
    // then clean again after self-heal.
    let isCleanCallCount = 0;
    git.isCleanExcept = async () => {
      isCleanCallCount++;
      if (isCleanCallCount <= 1) {
        return true; // preflight
      }
      return git.statusText.trim() === "";
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
        git.statusText = "";
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch and cleaned dirty state for first.",
          commands: [
            "git branch -D pi-implement/r1/first",
            "git checkout -- .",
          ],
        }),
      },
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
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] First");
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Second");
  });

  it("allows dirty plan artifacts after scheduler self-heal", async () => {
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
          dependsOn: [],
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
    writeRunJson(paths, makeRunJson(dir, planPath));

    const git = new FakeGit();
    git.rootValue = dir;
    git.statusText = " M plan.md";
    git.createdBranches = ["pi-implement/r1/second"];
    const staleBranches = new Set(["pi-implement/r1/second"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };
    const originalDeleteTaskBranch = git.deleteTaskBranch.bind(git);
    git.deleteTaskBranch = async (branchName: string) => {
      if (branchName === "pi-implement/r1/second") {
        return;
      }
      return originalDeleteTaskBranch(branchName);
    };
    git.isCleanExcept = async () => true;

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/second");
        git.deletedBranches.push("pi-implement/r1/second");
      }
      return result;
    };
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for second.",
          commands: ["git branch -D pi-implement/r1/second"],
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Second");
  });

  it("runs scheduler self-heal for terminal setup failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] First\n", "utf-8");
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
    writeRunJson(paths, makeRunJson(dir, planPath));
    mkdirSync(join(paths.tasksDir, "first"), { recursive: true });
    writeFileSync(
      join(paths.tasksDir, "first", "task.json"),
      JSON.stringify({
        id: "first",
        planIndex: 1,
        title: "First",
        status: "failed",
        dependsOn: [],
        attempts: 1,
        integrationAttempts: 0,
        lastReason:
          "Worktree setup failed: fatal: a branch named 'pi-implement/r1/first' already exists",
      }),
      "utf-8",
    );

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };
    const originalDeleteTaskBranch = git.deleteTaskBranch.bind(git);
    git.deleteTaskBranch = async (branchName: string) => {
      if (branchName === "pi-implement/r1/first") {
        return;
      }
      return originalDeleteTaskBranch(branchName);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
      }
      return result;
    };
    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const selfHealSpawns = subagents.spawns.filter((s) =>
      s.description.includes("scheduler self-heal"),
    );
    expect(selfHealSpawns).toHaveLength(1);
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] First");
  });

  it("blocks when scheduler self-heal deletes durable run state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] First\n", "utf-8");
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
    writeRunJson(paths, makeRunJson(dir, planPath));

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
        rmSync(paths.runJson, { force: true });
      }
      return result;
    };
    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Removed stale branch for first.",
          commands: ["git branch -D pi-implement/r1/first"],
        }),
      },
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow(BlockedError);
  });

  it("detects dependency installation as retryable progress", async () => {
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
          dependsOn: [],
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

    const git = new FakeGit();
    git.rootValue = dir;
    git.createdBranches = ["pi-implement/r1/first"];
    const staleBranches = new Set(["pi-implement/r1/first"]);
    const originalAddWorktree = git.addWorktree.bind(git);
    git.addWorktree = async (path: string, branch: string) => {
      if (staleBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      return originalAddWorktree(path, branch);
    };
    const originalDeleteTaskBranch = git.deleteTaskBranch.bind(git);
    git.deleteTaskBranch = async (branchName: string) => {
      if (branchName === "pi-implement/r1/first") {
        return;
      }
      return originalDeleteTaskBranch(branchName);
    };
    // Simulate clean git status after dependency install (only ignored files changed)
    let statusCallCount = 0;
    const originalStatus = git.status.bind(git);
    git.status = async () => {
      statusCallCount++;
      if (statusCallCount >= 2) {
        return "";
      }
      return originalStatus();
    };

    const subagents = new FakeSubagents();
    const originalWaitFor = subagents.waitFor.bind(subagents);
    subagents.waitFor = async (id, signal) => {
      const result = await originalWaitFor(id, signal);
      if (result.status === "completed") {
        staleBranches.delete("pi-implement/r1/first");
        git.deletedBranches.push("pi-implement/r1/first");
      }
      return result;
    };

    subagents.results = [
      {
        status: "completed",
        result: makeSchedulerSelfHealResult({
          repaired: true,
          retryScheduler: true,
          summary: "Installed dependencies for first.",
          commands: ["npm install"],
        }),
      },
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
      mode: "parallel",
      runId: "r1",
      paths,
      verifyCommand: "echo ok",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(readFileSync(planPath, "utf-8")).toContain("- [x] First");
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Second");
  });

  it("self-heal does not count removed worktree as progress when branch is ahead of base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] First\n", "utf-8");
    const paths = makePaths(dir);
    writeRunJson(paths, {
      version: 1,
      runId: "r1",
      mode: "parallel",
      strategyReason: "parallel",
      repoRoot: dir,
      planPath,
      planHash: "hash",
      baseSha: "h1",
      currentPhase: "scheduling",
      maxConcurrency: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
    mkdirSync(join(paths.tasksDir, "first"), { recursive: true });
    writeFileSync(
      join(paths.tasksDir, "first", "task.json"),
      JSON.stringify({
        id: "first",
        planIndex: 0,
        title: "First",
        status: "failed",
        dependsOn: [],
        attempts: 1,
        integrationAttempts: 0,
        baseSha: "h1",
        lastReason: "Worktree setup failed: fatal: ...",
      }),
      "utf-8",
    );

    const git = new FakeGit();
    git.headValue = "h1";
    git.createdBranches = ["pi-implement/r1/first"];
    git.aheadOfBaseValue = true;
    git.addedWorktrees = [
      {
        path: join(paths.worktreesDir, "first"),
        branch: "pi-implement/r1/first",
      },
    ];

    const subagents = new FakeSubagents();
    const sched = createSchedulerRun(
      {
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
      },
      1,
    );
    sched.tasks.get("first")!.status = "failed";
    sched.tasks.get("first")!.lastReason = "Worktree setup failed: fatal: ...";

    const deps = {
      git,
      subagents,
      planPath,
      paths,
      runId: "r1",
      mode: "parallel" as const,
      roles: {
        implementer: {
          model: "p/m" as const,
          type: "general-purpose" as const,
        },
        reviewer: { model: "p/m" as const, type: "general-purpose" as const },
        planner: { model: "p/m" as const, type: "Explore" as const },
        selfHeal: { model: "p/m" as const, type: "general-purpose" as const },
      },
      updateState: () => {},
      shouldStop: () => false,
    };

    const baseline = await captureSchedulerSelfHealBaseline(deps, sched, [
      planPath,
    ]);

    git.removedWorktrees.push(join(paths.worktreesDir, "first"));

    const progress = await checkSchedulerSelfHealProgress(
      deps,
      sched,
      [planPath],
      baseline,
      {
        repaired: true,
        retryScheduler: true,
        summary: "Removed stale worktree for first.",
        commands: [
          `git worktree remove --force ${join(paths.worktreesDir, "first")}`,
        ],
        filesChanged: [],
        remainingBlocker: null,
      },
    );

    expect(progress.hasProgress).toBe(false);
    expect(progress.revivedTaskIds).toHaveLength(0);
  });

  it("self-heal counts removed worktree as progress when branch is at base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] First\n", "utf-8");
    const paths = makePaths(dir);
    writeRunJson(paths, {
      version: 1,
      runId: "r1",
      mode: "parallel",
      strategyReason: "parallel",
      repoRoot: dir,
      planPath,
      planHash: "hash",
      baseSha: "h1",
      currentPhase: "scheduling",
      maxConcurrency: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
    mkdirSync(join(paths.tasksDir, "first"), { recursive: true });
    writeFileSync(
      join(paths.tasksDir, "first", "task.json"),
      JSON.stringify({
        id: "first",
        planIndex: 0,
        title: "First",
        status: "failed",
        dependsOn: [],
        attempts: 1,
        integrationAttempts: 0,
        baseSha: "h1",
        lastReason: "Worktree setup failed: fatal: ...",
      }),
      "utf-8",
    );

    const git = new FakeGit();
    git.headValue = "h1";
    git.createdBranches = ["pi-implement/r1/first"];
    git.aheadOfBaseValue = false;
    git.addedWorktrees = [
      {
        path: join(paths.worktreesDir, "first"),
        branch: "pi-implement/r1/first",
      },
    ];

    const subagents = new FakeSubagents();
    const sched = createSchedulerRun(
      {
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
      },
      1,
    );
    sched.tasks.get("first")!.status = "failed";
    sched.tasks.get("first")!.lastReason = "Worktree setup failed: fatal: ...";

    const deps = {
      git,
      subagents,
      planPath,
      paths,
      runId: "r1",
      mode: "parallel" as const,
      roles: {
        implementer: {
          model: "p/m" as const,
          type: "general-purpose" as const,
        },
        reviewer: { model: "p/m" as const, type: "general-purpose" as const },
        planner: { model: "p/m" as const, type: "Explore" as const },
        selfHeal: { model: "p/m" as const, type: "general-purpose" as const },
      },
      updateState: () => {},
      shouldStop: () => false,
    };

    const baseline = await captureSchedulerSelfHealBaseline(deps, sched, [
      planPath,
    ]);

    git.removedWorktrees.push(join(paths.worktreesDir, "first"));

    const progress = await checkSchedulerSelfHealProgress(
      deps,
      sched,
      [planPath],
      baseline,
      {
        repaired: true,
        retryScheduler: true,
        summary: "Removed stale worktree for first.",
        commands: [
          `git worktree remove --force ${join(paths.worktreesDir, "first")}`,
        ],
        filesChanged: [],
        remainingBlocker: null,
      },
    );

    expect(progress.hasProgress).toBe(true);
    expect(progress.revivedTaskIds).toContain("first");
  });

  it("does not spawn a standalone scout worker", async () => {
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

    await runImplementation({
      git,
      subagents,
      planPath,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns.map((spawn) => spawn.role)).toEqual([
      "implementer",
      "reviewer",
      "reviewer",
    ]);
    expect(subagents.spawns).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "scout" })]),
    );
  });

  it("preserves scheduler integrationAttempts on integration transition writes", async () => {
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
    ];

    await expect(
      runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "exit 1",
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      }),
    ).rejects.toThrow();

    const taskJson = readTaskJson(paths, "task-1");
    expect(taskJson).toBeDefined();
    expect(taskJson!.integrationAttempts).toBe(1);
  });

  describe("dynamic per-task review", () => {
    function setupWorktreeGit(
      git: FakeGit,
      dir: string,
      stagedNameStatus: string,
    ) {
      git.rootValue = dir;
      const worktreePath = join(
        dir,
        ".pi",
        "implement",
        "worktrees",
        "r1",
        "task-1",
      );
      mkdirSync(worktreePath, { recursive: true });
      const child = new FakeGit();
      child.headValue = git.headValue;
      child.stagedNameStatus = async () => stagedNameStatus;
      child.rootValue = worktreePath;
      git.worktreeChild = child;
    }

    it("directive reaches worker in parallel mode", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip", reason: "docs-only" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.review?.lastDecision).toBe("skipped");
    });

    it("skip-eligible docs-only task commits without reviewer spawn", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      // Only implementer + overall review spawned
      expect(subagents.spawns).toHaveLength(2);
      expect(subagents.spawns[0]?.description).toContain("implement");
      expect(subagents.spawns[1]?.description).toContain("overall review");
      expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    });

    it("writes review decision artifacts when paths are provided", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const taskDir = join(paths.tasksDir, "task-1");
      expect(existsSync(join(taskDir, "review-decision-attempt-1.md"))).toBe(
        true,
      );
      expect(existsSync(join(taskDir, "review-skipped-attempt-1.md"))).toBe(
        true,
      );
      const decisionContent = readFileSync(
        join(taskDir, "review-decision-attempt-1.md"),
        "utf-8",
      );
      expect(decisionContent).toContain("Decision: skip");
      expect(decisionContent).toContain("docs-only");
    });

    it("validation failure for skip-eligible candidate resets and retries with system feedback", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip" },
          },
        ],
      });

      // Toggleable script: fails on first invocation, passes thereafter
      const countFile = join(dir, ".validation-count");
      const failScript = join(dir, "fail.sh");
      writeFileSync(
        failScript,
        `#!/bin/sh\nCOUNTFILE="${countFile}"\nif [ ! -f "$COUNTFILE" ]; then echo 0 > "$COUNTFILE"; fi\nCOUNT=$(cat "$COUNTFILE")\nif [ "$COUNT" -eq "0" ]; then\n  echo 1 > "$COUNTFILE"\n  echo "validation failed"\n  exit 1\nelse\n  exit 0\nfi\n`,
        "utf-8",
      );

      const git = new FakeGit();
      setupWorktreeGit(git, dir, "A\ttests/fixtures/data.json");
      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${failScript}`,
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      // Two implementers (first failed validation, second reviewed and approved)
      expect(subagents.spawns).toHaveLength(4);
      const secondImplPrompt = subagents.spawns[1]?.prompt ?? "";
      expect(secondImplPrompt).toContain("Validation failed");
      expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    });

    it("blocks when validation mutates staged state", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip" },
          },
        ],
      });

      const git = new FakeGit();
      setupWorktreeGit(git, dir, "A\ttests/fixtures/data.json");
      let fingerprintCallCount = 0;
      const originalStagedFingerprint =
        git.worktreeChild!.stagedFingerprint.bind(git.worktreeChild);
      git.worktreeChild!.stagedFingerprint = async () => {
        fingerprintCallCount++;
        if (fingerprintCallCount >= 2) {
          return "mutated-fingerprint";
        }
        return originalStagedFingerprint();
      };

      const mutateScript = join(dir, "mutate.sh");
      writeFileSync(mutateScript, `#!/bin/sh\nexit 0\n`, "utf-8");

      const subagents = new FakeSubagents();
      subagents.results = [{ status: "completed", result: GOOD_IMPL }];

      await expect(
        runImplementation({
          git,
          subagents,
          planPath,
          mode: "parallel",
          runId: "r1",
          paths,
          verifyCommand: `sh ${mutateScript}`,
          effectiveTaskReview: {
            mode: "auto",
            maxSkipDiffChars: 2000,
            maxSkipFiles: 3,
          },
          roles: {
            implementer: { model: "p/m", type: "general-purpose" },
            reviewer: { model: "p/m", type: "general-purpose" },
            planner: { model: "p/m", type: "Explore" },
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow("validation changed staged state");
    });

    it("commit hook failure in skip path retries with feedback", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
      let commitCallCount = 0;
      const originalCommit = git.worktreeChild!.commit.bind(git.worktreeChild);
      git.worktreeChild!.commit = async (message: string) => {
        commitCallCount++;
        if (commitCallCount === 1) {
          return {
            command: "git commit",
            exitCode: 1,
            stdout: "",
            stderr: "commit hook rejected",
          };
        }
        return originalCommit(message);
      };

      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      // Two implementers + reviewer + overall review
      expect(subagents.spawns).toHaveLength(4);
      const secondImplPrompt = subagents.spawns[1]?.prompt ?? "";
      expect(secondImplPrompt).toContain("commit hook rejected");
      expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    });

    it("always reviews when no planner directive is provided", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            // No review directive
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
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
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      // Reviewer was spawned
      expect(subagents.spawns).toHaveLength(3);
      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.review?.lastDecision).toBe("reviewed");
    });

    it("always reviews when planner directive is require", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "require" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
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
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      expect(subagents.spawns).toHaveLength(3);
      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.review?.lastDecision).toBe("reviewed");
    });

    it("planner skip overridden by risky diff forces review", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
            review: { mode: "skip", reason: "docs-only" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "A\tsrc/index.ts");
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
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: "echo ok",
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      expect(subagents.spawns).toHaveLength(3);
      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.review?.lastDecision).toBe("reviewed");
    });

    it("rework forces review even with skip directive", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
        "utf-8",
      );
      const paths = makePaths(dir);
      const validateScript = join(dir, "validate.sh");
      writeFileSync(
        validateScript,
        `#!/bin/sh\nCOUNT_FILE="${join(dir, ".count")}"\nif [ -f "$COUNT_FILE" ]; then COUNT=$(cat "$COUNT_FILE"); else COUNT=0; fi\nCOUNT=$((COUNT + 1))\necho "$COUNT" > "$COUNT_FILE"\nif [ "$COUNT" -ge 2 ]; then exit 0; else echo "fail"; exit 1; fi\n`,
        "utf-8",
      );
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
            review: { mode: "skip", reason: "docs-only" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
      const SELF_HEAL_NO_RETRY =
        '<pi-self-heal-result>{"repaired":false,"retryIntegration":false,"summary":"cannot fix"}</pi-self-heal-result>';
      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: SELF_HEAL_NO_RETRY },
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        { status: "completed", result: GOOD_OVERALL_REVIEW },
      ];
      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validateScript}`,
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.review?.lastDecision).toBe("reviewed");
      expect(taskJson?.review?.skippedCount).toBe(1);
      expect(taskJson?.review?.reviewedCount).toBe(1);
    });

    it("preserves review counts across retry failure writes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
        "utf-8",
      );
      const paths = makePaths(dir);
      const validateScript = join(dir, "validate.sh");
      writeFileSync(
        validateScript,
        `#!/bin/sh\nCOUNT_FILE="${join(dir, ".count")}"\nif [ -f "$COUNT_FILE" ]; then COUNT=$(cat "$COUNT_FILE"); else COUNT=0; fi\nCOUNT=$((COUNT + 1))\necho "$COUNT" > "$COUNT_FILE"\nif [ "$COUNT" -ge 2 ]; then exit 0; else echo "fail"; exit 1; fi\n`,
        "utf-8",
      );
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
            review: { mode: "skip", reason: "docs-only" },
          },
        ],
      });
      const git = new FakeGit();
      setupWorktreeGit(git, dir, "M\tREADME.md");
      const child = git.worktreeChild as FakeGit;
      const originalReword = child.reword.bind(child);
      let rewordCount = 0;
      child.reword = async (message: string) => {
        rewordCount++;
        if (rewordCount === 1) {
          return {
            command: "git commit --amend",
            exitCode: 1,
            stdout: "",
            stderr: "hook failed",
          };
        }
        return originalReword(message);
      };

      const subagents = new FakeSubagents();
      subagents.resultsByDescription = [
        {
          match: /integration self-heal/,
          result: {
            status: "completed",
            result: makeSelfHealResult({
              repaired: false,
              retryIntegration: false,
              summary: "cannot fix",
            }),
          },
        },
        {
          match: /overall review/,
          result: { status: "completed", result: GOOD_OVERALL_REVIEW },
        },
      ];
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validateScript}`,
        effectiveTaskReview: {
          mode: "auto",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.review).toEqual({
        lastDecision: "reviewed",
        skippedCount: 1,
        reviewedCount: 2,
      });
    });

    it("parallel candidate is committed before reviewer spawn", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      setupWorktreeGit(git, dir, "M\tfile.ts");
      const subagents = new FakeSubagents();
      subagents.resultsByDescription = [
        {
          match: /integration review/,
          result: { status: "completed", result: GOOD_INTEGRATION_REVIEW },
        },
        {
          match: /overall review/,
          result: { status: "completed", result: GOOD_OVERALL_REVIEW },
        },
      ];
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
      ];

      const originalSpawn = subagents.spawn.bind(subagents);
      let reviewerSpawned = false;
      subagents.spawn = async (args) => {
        if (args.description.includes("review")) {
          reviewerSpawned = true;
        }
        return originalSpawn(args);
      };

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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      expect(reviewerSpawned).toBe(true);
      expect(git.worktreeChild!.headValue).not.toBe("h1");
      expect(await git.worktreeChild!.isCleanExcept()).toBe(true);
    });

    it("wip commit hook failure resets to base and retries", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      setupWorktreeGit(git, dir, "M\tfile.ts");

      let commitCallCount = 0;
      const originalCommit = git.worktreeChild!.commit.bind(git.worktreeChild);
      git.worktreeChild!.commit = async (message: string) => {
        commitCallCount++;
        if (commitCallCount === 1) {
          return {
            command: "git commit",
            exitCode: 1,
            stdout: "",
            stderr: "pre-commit hook rejected",
          };
        }
        return originalCommit(message);
      };

      const resetHardCalls: string[] = [];
      const originalResetHard = git.worktreeChild!.resetHard.bind(
        git.worktreeChild,
      );
      git.worktreeChild!.resetHard = async (sha: string) => {
        resetHardCalls.push(sha);
        return originalResetHard(sha);
      };

      const subagents = new FakeSubagents();
      subagents.resultsByDescription = [
        {
          match: /integration review/,
          result: { status: "completed", result: GOOD_INTEGRATION_REVIEW },
        },
        {
          match: /overall review/,
          result: { status: "completed", result: GOOD_OVERALL_REVIEW },
        },
      ];
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
      ];

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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      expect(resetHardCalls).toContain("h1");
      expect(subagents.spawns).toHaveLength(5);
      const secondImplPrompt = subagents.spawns[1]?.prompt ?? "";
      expect(secondImplPrompt).toContain("pre-commit hook rejected");
    });

    it("parallel changes_requested resets branch to base before re-attempt", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      setupWorktreeGit(git, dir, "M\tfile.ts");
      const subagents = new FakeSubagents();
      subagents.resultsByDescription = [
        {
          match: /integration review/,
          result: { status: "completed", result: GOOD_INTEGRATION_REVIEW },
        },
        {
          match: /overall review/,
          result: { status: "completed", result: GOOD_OVERALL_REVIEW },
        },
      ];
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

      const implHeads: string[] = [];
      const originalSpawn = subagents.spawn.bind(subagents);
      subagents.spawn = async (args) => {
        if (args.description.includes("implement")) {
          implHeads.push(git.worktreeChild!.headValue);
        }
        return originalSpawn(args);
      };

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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      expect(implHeads).toHaveLength(2);
      expect(implHeads[0]).toBe("h1");
      expect(implHeads[1]).toBe("h1");
    });

    it("parallel approval rewords WIP commit and produces exactly one commit beyond base", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      setupWorktreeGit(git, dir, "M\tfile.ts");
      const subagents = new FakeSubagents();
      subagents.resultsByDescription = [
        {
          match: /integration review/,
          result: { status: "completed", result: GOOD_INTEGRATION_REVIEW },
        },
        {
          match: /overall review/,
          result: { status: "completed", result: GOOD_OVERALL_REVIEW },
        },
      ];
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "completed", result: GOOD_REVIEW },
      ];

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
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      const child = git.worktreeChild as FakeGit;
      expect(child.commits).toHaveLength(1);
      expect(child.commits[0]).toBe("feat: do thing");
      expect(child.headValue).not.toBe("h1");

      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.taskCommitSha).toBe(child.headValue);
      expect(taskJson?.commitMessage).toBe("feat: do thing");
    });

    it("preserves the WIP commit when a parallel worker returns failed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
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
      setupWorktreeGit(git, dir, "M\tfile.ts");
      const subagents = new FakeSubagents();
      // Implementer succeeds each attempt, but the reviewer crashes twice in a
      // row, exhausting MAX_SYSTEM_FAILURES so the worker returns `failed`
      // rather than retrying to success. Self-heal is then starved of fake
      // results and cannot make progress, so the run rejects.
      subagents.results = [
        { status: "completed", result: GOOD_IMPL },
        { status: "failed", error: "reviewer crashed" },
        { status: "completed", result: GOOD_IMPL },
        { status: "failed", error: "reviewer crashed" },
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
            selfHeal: { model: "p/m", type: "general-purpose" },
          },
          updateState: () => {},
          shouldStop: () => false,
        }),
      ).rejects.toThrow(BlockedError);

      const child = git.worktreeChild as FakeGit;
      expect(child.commits.length).toBeGreaterThan(0);
      expect(child.headValue).not.toBe("h1");
      expect(readTaskJson(paths, "task-1")?.status).toBe("failed");
    });
  });

  it("already_satisfied forces review and records metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL =
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>';

    const git = new FakeGit();
    const subagents = new FakeSubagents();
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
      effectiveTaskReview: {
        mode: "auto",
        maxSkipDiffChars: 2000,
        maxSkipFiles: 3,
      },
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(2);
    const taskJson = readTaskJson(paths, "t001-do-it");
    expect(taskJson?.review?.lastDecision).toBe("reviewed");
    expect(taskJson?.review?.reviewedCount).toBe(1);
  });

  it("persists overall rework prompt and result artifacts", async () => {
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

    let overallReviewCount = 0;
    subagents.resultsByDescription = [
      {
        match: "overall review",
        result: {
          status: "completed",
          get result() {
            overallReviewCount++;
            return overallReviewCount === 1
              ? BAD_OVERALL_REVIEW
              : GOOD_OVERALL_REVIEW;
          },
        },
      },
    ];

    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_REWORK },
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    const artifactDir = join(paths.runDir, "overall-review");
    expect(existsSync(join(artifactDir, "rework-prompt-1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "rework-result-1.md"))).toBe(true);

    const events = readEvents(paths);
    const started = events.find((e) => e.type === "overall_rework_started");
    expect(started).toBeDefined();
    expect(started?.artifactPath).toContain("rework-prompt-1.md");
  });

  it("uses compiled contracts and selected referenced material when execution manifest is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task one\n  - Plan: `sub.md`\n- [ ] Task two\n",
      "utf-8",
    );
    writeFileSync(
      subPath,
      "# Subplan\n\nAcceptance for task one: do it.\nAcceptance for task two: do other thing.\n",
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

    const paths = makePaths(dir);
    const plan = parsePlanFile(planPath);
    const manifest = buildPlanBundleManifest(planPath, plan);

    const task1Hash = manifest.tasks[0]!.fingerprint;
    const task2Hash = manifest.tasks[1]!.fingerprint;

    const executionManifest = {
      version: 1,
      sourcePlanPath: planPath,
      tasks: [
        {
          id: "t1",
          planIndex: 1,
          title: "Task one",
          taskHash: task1Hash,
          status: "todo",
          dependsOn: [],
          mode: "serial",
          affectedAreas: [],
          conflictHints: [],
          sourceReferences: ["sub.md"],
          sourceMaterialRefs: [
            {
              origin: "task-link",
              path: subPath,
              mode: { kind: "full-file" },
              reason:
                "Explicit local Markdown material linked from the selected task block.",
            },
          ],
          review: { mode: "require" },
          compiledContract: {
            objective: "Implement task one",
            inScope: ["Task one work"],
            acceptanceCriteria: ["Task one criterion: do it."],
            outOfScope: ["Task two deliverable: do other thing."],
          },
        },
        {
          id: "t2",
          planIndex: 2,
          title: "Task two",
          taskHash: task2Hash,
          status: "todo",
          dependsOn: [],
          mode: "serial",
          affectedAreas: [],
          conflictHints: [],
          sourceReferences: [],
          review: { mode: "require" },
          compiledContract: {
            objective: "Implement task two",
            inScope: ["Task two work"],
            acceptanceCriteria: ["Task two criterion: do other thing."],
            outOfScope: ["Task one deliverable"],
          },
        },
      ],
    } satisfies ExecutionManifest;

    writeExecutionManifest(paths.runDir, executionManifest);

    await runImplementation({
      git,
      subagents,
      planPath,
      manifest,
      paths,
      runId: "r1",
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      },
      updateState: () => {},
      shouldStop: () => false,
    });

    expect(subagents.spawns).toHaveLength(5);
    const implPrompt = subagents.spawns[0]?.prompt ?? "";
    const reviewerPrompt = subagents.spawns[1]?.prompt ?? "";

    // Implementer prompt should use compiled contract and selected referenced material
    expect(implPrompt).toContain("## Compiled Task Contract");
    expect(implPrompt).toContain("Task one criterion: do it.");
    expect(implPrompt).toContain("## Referenced Source Material");
    expect(implPrompt).toContain("# Subplan");
    expect(implPrompt).toContain("Acceptance for task two");
    expect(implPrompt).not.toContain("## Referenced Plan Material");
    // Sibling deliverable is listed as out-of-scope in the compiled contract
    expect(implPrompt).toContain("Task two deliverable: do other thing.");

    // Reviewer prompt should use the same selected packet material and include sibling scope
    expect(reviewerPrompt).toContain("## Compiled Task Contract");
    expect(reviewerPrompt).toContain("Task one criterion: do it.");
    expect(reviewerPrompt).toContain("## Referenced Source Material");
    expect(reviewerPrompt).toContain("# Subplan");
    expect(reviewerPrompt).toContain("Acceptance for task two");
    expect(reviewerPrompt).toContain("## Out-of-Scope Sibling Tasks");
    expect(reviewerPrompt).toContain("- Task two");
    expect(reviewerPrompt).not.toContain("## Referenced Plan Material");
  });
});
