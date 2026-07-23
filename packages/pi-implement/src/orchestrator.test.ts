import { createHash } from "node:crypto";
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
import { RunStore, type CanonicalRunState } from "./canonical-state.js";

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
  mainRootValue = "/repo";
  branchValue = "";

  async root() {
    return this.rootValue;
  }
  async mainRoot() {
    return this.mainRootValue;
  }
  activeOperationValue: string | undefined;
  async checkoutIdentity() {
    return `${this.rootValue}/.git`;
  }
  async currentBranch() {
    return this.branchValue;
  }
  async activeOperation() {
    return this.activeOperationValue;
  }
  async head() {
    return this.headValue;
  }
  async parent(_commit: string) {
    return "h1";
  }
  async tree() {
    return `tree-${this.diffText}`;
  }
  async treeAt(_commit: string) {
    return `tree-${this.diffText}`;
  }
  async isAncestor() {
    return true;
  }
  async isAmendOf() {
    return true;
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
  stagedPaths: string[][] = [];
  stageAllExceptCalls = 0;
  async stageAllExcept() {
    this.stageAllExceptCalls++;
  }
  async stagePaths(paths: string[]) {
    this.stagedPaths.push(paths);
  }
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
  stagedDeltaFromPatchCalls: string[] = [];
  async stagedDeltaFromPatch(previousPatch: string) {
    this.stagedDeltaFromPatchCalls.push(previousPatch);
    return { diff: this.diffText, nameStatus: await this.stagedNameStatus() };
  }
  async stagedDiffExcept() {
    return this.diffText;
  }
  async workingDiff() {
    return "";
  }
  async workingDiffExcept() {
    return "";
  }
  async nonignoredUntracked() {
    return [];
  }
  async abortActiveOperation() {
    this.activeOperationValue = undefined;
  }
  async restoreSnapshot(head: string, stagedPatch: string) {
    await this.resetHard(head);
    this.diffText = stagedPatch;
    this.statusText = "";
    this.worktreeFingerprintText = "worktree";
    this.activeOperationValue = undefined;
  }
  worktreeFingerprintText = "worktree";
  restoredFromIndex = 0;
  restoredPatches: string[] = [];
  addWorktreeError?: Error;
  async stagedFingerprint() {
    return `${this.diffText}:${this.statusText}:${this.stageAllExceptCalls}`;
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
  async checkpoint(message: string, amend: boolean): Promise<CommandResult> {
    return amend ? this.reword(message) : this.commit(message);
  }
  async runCheckpointHooks(_checkpoint: string): Promise<CommandResult> {
    return {
      command: "git commit -C",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
  async rewordInternal(message: string): Promise<CommandResult> {
    return this.reword(message);
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
  async mergeFastForward(commitSha: string): Promise<CommandResult> {
    this.headValue = commitSha;
    return {
      command: "git merge --ff-only",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  }
  resetCount = 0;
  async reset() {
    this.resetCount++;
  }
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
  async applyPatch(patch: string): Promise<CommandResult> {
    this.diffText = patch;
    return {
      command: "git apply --index",
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
    if (this.worktreeChild?.rootValue === worktreePath) {
      this.worktreeChild.branchValue = branchName;
    }
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
  async diffRangeNameStatus(_baseSha: string, _headSha: string) {
    return this.stagedNameStatus();
  }
  async diffRangeExcept(
    _baseSha: string,
    _headSha: string,
    _paths: string[],
  ): Promise<string> {
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
    this.worktreeChild.mainRootValue = this.mainRootValue;
    this.worktreeChild.branchValue =
      this.addedWorktrees.find((worktree) => worktree.path === worktreePath)
        ?.branch ?? "";
    return this.worktreeChild;
  }
}

class FakeSubagents implements SubagentClient {
  spawns: SpawnArgs[] = [];
  results: SubagentResult[] = [];
  resultsByStage = new Map<string, SubagentResult[]>();
  resultsByDescription: { match: string | RegExp; result: SubagentResult }[] =
    [];

  queueStage(
    stage: NonNullable<SpawnArgs["stage"]>,
    ...results: SubagentResult[]
  ) {
    this.resultsByStage.set(stage, results);
  }

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
    const routed = args
      ? this.resultsByDescription.find((r) =>
          typeof r.match === "string"
            ? args.description.includes(r.match)
            : r.match.test(args.description),
        )
      : undefined;
    const staged = args?.stage
      ? this.resultsByStage.get(args.stage)?.shift()
      : undefined;
    const result =
      staged ??
      routed?.result ??
      (args?.description.includes("admit task")
        ? { status: "failed" as const, error: "adjudicator unavailable" }
        : this.results.shift());
    if (routed && this.results[0] === routed.result) {
      this.results.shift();
    }
    if (!result) {
      throw new Error("missing fake result");
    }
    return result;
  }
}

const GOOD_IMPL = {
  outcome: "changed",
  summary: "done",
  verification: [
    { command: "tests", result: "passed", rationale: "covers change" },
  ],
  commitMessage: "feat: do thing",
};
const GOOD_ALREADY_SATISFIED_IMPL = {
  outcome: "already_satisfied",
  summary: "already done",
  verification: [
    {
      command: "tests",
      result: "passed",
      rationale: "task already satisfied",
    },
  ],
};
const GOOD_REVIEW = { verdict: "approved" } as const;
const GOOD_INTEGRATION_REVIEW = { verdict: "approved" } as const;

function makePaths(dir: string) {
  const paths = {
    baseDir: join(dir, ".pi", "implement"),
    runDir: join(dir, ".pi", "implement", "runs", "r1"),
    runJson: join(dir, ".pi", "implement", "runs", "r1", "run.json"),
    eventsJsonl: join(dir, ".pi", "implement", "runs", "r1", "events.jsonl"),
    canonicalRunState: join(
      dir,
      ".pi",
      "implement",
      "runs",
      "r1",
      "canonical-run-state.json",
    ),
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

function makeCanonicalRunStore(
  paths: StatePaths,
  dir: string,
  planPath: string,
): RunStore {
  const now = new Date().toISOString();
  const initial: CanonicalRunState = {
    schemaVersion: 7,
    revision: 0,
    run: {
      id: "r1",
      target: {
        checkoutRoot: dir,
        gitDir: join(dir, ".git"),
        commonGitDir: join(dir, ".git"),
        branchRef: "main",
        startHead: "h1",
      },
      plan: {
        path: planPath,
        hash: "hash",
        indexConvention: "zero-based",
      },
      configuredWorkerConcurrency: 1,
      effectiveWorkerConcurrency: 1,
    },
    graph: {
      tasks: [
        {
          id: "task-1",
          planIndex: 1,
          title: "Do thing",
          taskHash: "hash",
          dependsOn: [],
        },
      ],
    },
    runtime: {
      phase: "preflight",
      tasks: { "task-1": { phase: "queued" } },
      overall: { phase: "pending" },
    },
    candidates: {},
    taskExecution: {},
    taskMetadata: {},
    reviewConvergence: {},
    workerLeases: [],
    integrationAttempts: [],
    landingReceipts: [],
    projectionDebt: [],
    cleanupDebt: [],
    createdAt: now,
    updatedAt: now,
  };
  return RunStore.create(paths.canonicalRunState!, initial);
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

const GOOD_OVERALL_REVIEW = { verdict: "approved" };
const BAD_OVERALL_REVIEW = {
  verdict: "changes_requested",
  findings: [
    {
      summary: "Missing integration coverage",
      evidence: "The feature has no integration test.",
      requiredChange: "Add an integration test.",
      acceptanceCriteria: ["An integration test covers the feature."],
    },
  ],
  recommendationMarkdown: "## Suggested\n\nAdd tests.",
};
const UNRESOLVED_OVERALL_REVIEW = {
  assessments: [
    {
      id: "O1",
      status: "unresolved",
      evidence: "The integration test is still missing.",
    },
  ],
  regressions: [],
};
const GOOD_REWORK = {
  summary: "fixed",
  verification: [
    { command: "tests", result: "passed", rationale: "covers change" },
  ],
  findingCompletions: [
    {
      id: "O1",
      status: "addressed",
      evidence: "Added the requested integration test.",
      changedPaths: ["test/integration.test.ts"],
      verification: [
        { command: "tests", result: "passed", rationale: "covers change" },
      ],
    },
  ],
  commitMessage: "fix: address overall review",
};

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
}) {
  return args;
}

describe("runImplementation", () => {
  it("requires managed state before executing changed tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do thing\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();

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
    ).rejects.toThrow(
      "changed tasks require managed run state for isolated transactional landing",
    );

    expect(subagents.spawns).toEqual([]);
    expect(git.commits).toEqual([]);
  });

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

  it("runs planner-serial tasks through the isolated worker and serialized landing lifecycle", async () => {
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
          id: "t001-do-thing",
          planIndex: 1,
          title: "Do thing",
          taskHash: "hash",
          dependsOn: [],
          mode: "serial",
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
    const appliedPatches: string[] = [];
    const originalApplyPatch = git.applyPatch.bind(git);
    git.applyPatch = async (patch) => {
      appliedPatches.push(patch);
      return originalApplyPatch(patch);
    };
    const subagents = new FakeSubagents();
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      { status: "completed", result: GOOD_INTEGRATION_REVIEW },
      { status: "completed", result: GOOD_OVERALL_REVIEW },
    ];

    await runImplementation({
      git,
      subagents,
      planPath,
      mode: "serial",
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

    const worktreePath = join(paths.worktreesDir, "t001-do-thing");
    expect(subagents.spawns[0]?.cwd).toBe(worktreePath);
    expect(git.createdBranches).toEqual(["pi-implement/r1/t001-do-thing"]);
    expect(git.addedWorktrees).toEqual([
      { path: worktreePath, branch: "pi-implement/r1/t001-do-thing" },
    ]);
    expect(git.commits).toEqual(["feat: do thing"]);
    expect(appliedPatches).toEqual([git.diffText]);
    expect(git.removedWorktrees).toEqual([worktreePath]);
    expect(git.deletedBranches).toEqual(["pi-implement/r1/t001-do-thing"]);
    expect(readTaskJson(paths, "t001-do-thing")).toMatchObject({
      status: "landed",
      sourceBaseSha: "h1",
      baseSha: "h1",
      branchName: "pi-implement/r1/t001-do-thing",
      worktreePath,
    });
    expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
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
    expect(readTaskJson(paths, "task-1")).toMatchObject({
      status: "failed",
      sourceBaseSha: "h1",
      baseSha: "h1",
      branchName: "pi-implement/r1/task-1",
      worktreePath: join(paths.worktreesDir, "task-1"),
    });
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
    expect(overallPrompt).toContain("initial overall review");
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
        match: /^overall review$/,
        result: { status: "completed", result: BAD_OVERALL_REVIEW },
      },
    ];
    subagents.results = [
      { status: "completed", result: GOOD_IMPL },
      { status: "completed", result: GOOD_REVIEW },
      {
        status: "completed",
        result: { proposalBatchId: "stale", dispositions: [] },
      },
      { status: "completed", result: GOOD_REWORK },
      { status: "completed", result: UNRESOLVED_OVERALL_REVIEW },
      { status: "completed", result: GOOD_REWORK },
      { status: "completed", result: UNRESOLVED_OVERALL_REVIEW },
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

    const artifactPath = join(paths.runDir, "overall-review", "stall.md");
    expect(existsSync(artifactPath)).toBe(true);
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
    ).rejects.toThrow("Scheduler blocked:");
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
    expect(message).toContain("Scheduler blocked:");
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

  it("serial already-satisfied approved blocks and leaves checkbox unchecked when worktree is dirty after approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imp-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Do it\n", "utf-8");
    const git = new FakeGit();
    const subagents = new FakeSubagents();
    const paths = makePaths(dir);
    const ALREADY_SATISFIED_IMPL = {
      outcome: "already_satisfied",
      summary: "already done",
      verification: [
        {
          command: "npm test",
          result: "passed",
          rationale: "task already satisfied",
        },
      ],
    };
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

  describe("integration self-heal", () => {
    it("blocks dirty main checkout cleanup during an active git operation", async () => {
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
      git.statusText = "UU file.ts";
      let cleanChecks = 0;
      git.isCleanExcept = async () => {
        cleanChecks++;
        return cleanChecks === 1 || git.statusText.trim() === "";
      };
      git.activeOperationValue = "cherry-pick";
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
      ).rejects.toThrow("active cherry-pick operation");
    });

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
      expect(prompt).toContain(
        "Submit the self-heal result through the injected completion tool",
      );
      expect(prompt).toContain("retryMode");
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
      git.applyPatch = async (sha: string) => {
        cherryPickCount++;
        if (cherryPickCount === 1) {
          return {
            command: "git apply --index",
            exitCode: 1,
            stdout: "",
            stderr: "conflict",
          };
        }
        git.diffText = `diff --git a/file.ts b/file.ts\n+change ${sha}`;
        return {
          command: "git apply --index",
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

  describe("post-commit checkout recovery", () => {
    function singleTaskGraph(
      paths: ReturnType<typeof makePaths>,
      planPath: string,
    ) {
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
    }

    it("serializes index-writing candidate snapshot operations", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
        "utf-8",
      );
      const paths = makePaths(dir);
      singleTaskGraph(paths, planPath);

      const git = new FakeGit();
      git.rootValue = dir;
      const originalTree = git.tree.bind(git);
      const originalStagedFingerprint = git.stagedFingerprint.bind(git);
      let treeInFlight = false;
      git.tree = async () => {
        treeInFlight = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          return await originalTree();
        } finally {
          treeInFlight = false;
        }
      };
      git.stagedFingerprint = async () => {
        if (treeInFlight) {
          throw new Error("fatal: Unable to create '.git/index.lock'");
        }
        return originalStagedFingerprint();
      };

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
        roles: {
          implementer: { model: "p/m", type: "general-purpose" },
          reviewer: { model: "p/m", type: "general-purpose" },
          planner: { model: "p/m", type: "Explore" },
          selfHeal: { model: "p/m", type: "general-purpose" },
        },
        updateState: () => {},
        shouldStop: () => false,
      });

      expect(git.commits).toEqual(["feat: do thing"]);
      expect(readTaskJson(paths, "task-1")?.status).toBe("landed");
    });

    it("reports failed exact proof without claiming restored HEAD is wrong", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
        "utf-8",
      );
      const paths = makePaths(dir);
      singleTaskGraph(paths, planPath);

      const git = new FakeGit();
      git.rootValue = dir;
      const originalCommit = git.commit.bind(git);
      const originalStagedFingerprint = git.stagedFingerprint.bind(git);
      git.commit = async (message: string) => {
        const result = await originalCommit(message);
        git.statusText = "?? junk.txt";
        return result;
      };
      git.stagedFingerprint = async () => {
        if (git.commits.length > 0) {
          throw new Error(
            "fatal: Unable to create '/app/.git/index.lock': File exists.",
          );
        }
        return originalStagedFingerprint();
      };

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

      const lastReason = readTaskJson(paths, "task-1")?.lastReason;
      expect(lastReason).toContain("rollback restored HEAD to h1");
      expect(lastReason).toContain("exact index/worktree restoration");
      expect(lastReason).toContain("index.lock");
      expect(lastReason).not.toContain("rollback did not restore HEAD");
      expect(git.headValue).toBe("h1");
    });

    it("flags a stuck integration commit when rollback cannot restore HEAD", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
        "utf-8",
      );
      const paths = makePaths(dir);
      singleTaskGraph(paths, planPath);

      const git = new FakeGit();
      git.rootValue = dir;
      const originalCommit = git.commit.bind(git);
      git.commit = async (message: string) => {
        const result = await originalCommit(message);
        git.statusText = "?? junk.txt";
        return result;
      };
      // Simulate a reset that cannot move HEAD back (e.g. lock/interrupted op),
      // leaving the integration commit on the branch after a "failed" rollback.
      git.resetHard = async () => {};

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

      const taskJson = readTaskJson(paths, "task-1");
      expect(taskJson?.status).toBe("integration_failed");
      expect(taskJson?.lastReason).toContain("rollback did not restore HEAD");
      expect(taskJson?.lastReason).toContain("may still be present");
    });
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

    async function runChangedCandidateReviewScenario(args: {
      stagedNameStatus: string;
      diffText?: string;
      implementerResult?: unknown;
      reviewerResult?: unknown;
      reworkReviewerResult?: unknown;
      configureTaskGit?: (taskGit: FakeGit, rootGit: FakeGit) => void;
      canonicalState?: boolean;
      expectedError?: string | RegExp;
    }) {
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
      setupWorktreeGit(git, dir, args.stagedNameStatus);
      if (args.diffText) {
        git.worktreeChild!.diffText = args.diffText;
      }
      args.configureTaskGit?.(git.worktreeChild!, git);
      const canonicalRunStore = args.canonicalState
        ? makeCanonicalRunStore(paths, dir, planPath)
        : undefined;
      const subagents = new FakeSubagents();
      subagents.resultsByDescription = [
        {
          match: /overall review/,
          result: { status: "completed", result: GOOD_OVERALL_REVIEW },
        },
      ];
      subagents.results = [
        {
          status: "completed",
          result: args.implementerResult ?? GOOD_IMPL,
        },
        { status: "completed", result: args.reviewerResult ?? GOOD_REVIEW },
        {
          status: "completed",
          result: {
            ...GOOD_IMPL,
            findingCompletions: [
              {
                id: "R1",
                status: "addressed",
                evidence: "Applied the requested correction.",
                changedPaths: ["file.ts"],
                verification: GOOD_IMPL.verification,
              },
            ],
          },
        },
        {
          status: "completed",
          result: args.reworkReviewerResult ?? GOOD_REVIEW,
        },
      ];

      const run = runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        canonicalRunStore,
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

      if (args.expectedError) {
        await expect(run).rejects.toThrow(args.expectedError);
      } else {
        await run;
      }

      return {
        dir,
        paths,
        planPath,
        git,
        subagents,
        canonicalRunStore,
      };
    }

    it("parallel already_satisfied task completes without a worktree commit", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-implement-"));
      const planPath = join(dir, "plan.md");
      writeFileSync(
        planPath,
        "# Plan\n\n## Tasks\n\n- [ ] Do thing\n",
        "utf-8",
      );
      const validationScript = join(dir, "validate-plan-unchecked.sh");
      writeFileSync(
        validationScript,
        `#!/bin/sh\nif grep -q '\\[x\\] Do thing' "${planPath}"; then exit 1; fi\nexit 0\n`,
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
      setupWorktreeGit(git, dir, "");
      git.worktreeChild!.hasStagedChanges = async () => false;
      git.worktreeChild!.stagedNameStatus = async () => "";
      git.worktreeChild!.diffText = "";
      const subagents = new FakeSubagents();
      subagents.results = [
        { status: "completed", result: GOOD_ALREADY_SATISFIED_IMPL },
        { status: "completed", result: GOOD_REVIEW },
      ];

      await runImplementation({
        git,
        subagents,
        planPath,
        mode: "parallel",
        runId: "r1",
        paths,
        verifyCommand: `sh ${validationScript}`,
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
      ]);
      expect(git.worktreeChild!.commits).toEqual([]);
      expect(readTaskJson(paths, "task-1")?.status).toBe("satisfied");
      expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
    });

    it.each([
      ["docs-only", "M\tREADME.md"],
      ["additive fixture", "A\ttests/fixtures/data.json"],
    ])(
      "%s changed candidate spawns a reviewer and approves normally",
      async (_name: string, stagedNameStatus: string, diffText?: string) => {
        const { paths, planPath, subagents } =
          await runChangedCandidateReviewScenario({
            stagedNameStatus,
            diffText,
          });

        expect(subagents.spawns.map((spawn) => spawn.role)).toEqual([
          "implementer",
          "reviewer",
          "reviewer",
        ]);
        expect(subagents.spawns[1]?.description).toContain("review task");
        expect(
          existsSync(
            join(
              paths.tasksDir,
              "task-1",
              "rounds",
              "001",
              "reviewer-prompt.md",
            ),
          ),
        ).toBe(true);
        expect(readTaskJson(paths, "task-1")?.review).toMatchObject({
          lastDecision: "reviewed",
          reviewedCount: 1,
          convergence: {
            state: { outstandingIds: [] },
          },
        });
        expect(
          readTaskJson(paths, "task-1")?.review?.skippedCount,
        ).toBeUndefined();
        expect(readFileSync(planPath, "utf-8")).toContain("- [x] Do thing");
        const taskPacket = JSON.parse(
          readFileSync(
            join(paths.tasksDir, "task-1", "rounds", "001", "task-packet.json"),
            "utf-8",
          ),
        );
        expect(taskPacket.contextId).toBe(
          createHash("sha256")
            .update(
              JSON.stringify({
                requirements: taskPacket.requirements,
                responsibilities: taskPacket.responsibilities,
              }),
            )
            .digest("hex"),
        );
        expect(taskPacket.requirements[0].id).toMatch(/-AC01$/);
      },
    );

    it("ignores unsolicited finding completions during initial implementation", async () => {
      const { canonicalRunStore, subagents } =
        await runChangedCandidateReviewScenario({
          stagedNameStatus: "M\tfile.ts",
          canonicalState: true,
          expectedError: /Scheduler blocked/,
          implementerResult: {
            ...GOOD_IMPL,
            findingCompletions: [
              {
                id: "task-1-AC01",
                status: "addressed",
                evidence: "Implemented the task acceptance criterion.",
                changedPaths: ["file.ts"],
                verification: GOOD_IMPL.verification,
              },
            ],
          },
        });

      const convergence = canonicalRunStore!.read().reviewConvergence["task-1"];
      expect(convergence).toMatchObject({
        stage: "approved",
        outstandingFindingIds: [],
      });
      expect(convergence?.latestRework).toBeUndefined();
      expect(convergence?.reworkObligationIds).toEqual([]);
      expect(subagents.spawns.some((spawn) => spawn.role === "reviewer")).toBe(
        true,
      );
    });

    it("uses the staged delta when reworking a checkpoint already at HEAD", async () => {
      const initialDelta = "diff --git a/initial.ts b/initial.ts";
      const reworkDelta = "diff --git a/rework.ts b/rework.ts";
      const { git, paths, subagents } = await runChangedCandidateReviewScenario(
        {
          stagedNameStatus: "M\trework.ts",
          diffText: initialDelta,
          reviewerResult: {
            verdict: "changes_requested",
            findings: [
              {
                summary: "Rework required",
                evidence: "The initial candidate is incomplete.",
                requiredChange: "Complete the candidate.",
                acceptanceCriteria: ["The candidate is complete."],
                basis: {
                  kind: "requirement",
                  requirementIds: ["t001-do-thing-AC01"],
                },
              },
            ],
          },
          reworkReviewerResult: {
            assessments: [
              { id: "R1", status: "resolved", evidence: "Rework completed." },
            ],
            regressions: [
              {
                summary: "Unrelated regression",
                evidence: "The initial file has an issue.",
                requiredChange: "Fix the initial file.",
                acceptanceCriteria: ["The initial file is fixed."],
                changedPaths: ["initial.ts"],
                causalEvidence: "The initial candidate changed this file.",
              },
            ],
          },
          configureTaskGit: (taskGit, rootGit) => {
            const stageAllExcept = taskGit.stageAllExcept.bind(taskGit);
            taskGit.stageAllExcept = async () => {
              await stageAllExcept();
              if (taskGit.stageAllExceptCalls === 2) {
                taskGit.diffText = reworkDelta;
                rootGit.diffText = reworkDelta;
              }
            };
            taskGit.stagedDeltaFromPatch = async () => {
              throw new Error("previous candidate patch was applied twice");
            };
          },
        },
      );

      const taskGit = git.worktreeChild!;
      const taskReviewPrompts = subagents.spawns.filter((spawn) =>
        spawn.description.includes("review task"),
      );
      expect(taskReviewPrompts).toHaveLength(2);
      expect(taskReviewPrompts[1]!.prompt).toContain(reworkDelta);
      expect(taskReviewPrompts[1]!.prompt).not.toContain(initialDelta);
      expect(taskGit.headValue).not.toBe("h1");
      expect(readTaskJson(paths, "task-1")?.review).toMatchObject({
        convergence: { state: { outstandingIds: [] } },
      });
    });

    it("reconstructs a previous candidate that is not current HEAD", async () => {
      const initialDelta = "diff --git a/initial.ts b/initial.ts";
      const reworkDelta = "diff --git a/rework.ts b/rework.ts";
      const { git, subagents } = await runChangedCandidateReviewScenario({
        stagedNameStatus: "M\trework.ts",
        diffText: initialDelta,
        reviewerResult: {
          verdict: "changes_requested",
          findings: [
            {
              summary: "Rework required",
              evidence: "The initial candidate is incomplete.",
              requiredChange: "Complete the candidate.",
              acceptanceCriteria: ["The candidate is complete."],
              basis: {
                kind: "requirement",
                requirementIds: ["t001-do-thing-AC01"],
              },
            },
          ],
        },
        reworkReviewerResult: {
          assessments: [
            { id: "R1", status: "resolved", evidence: "Rework completed." },
          ],
          regressions: [],
        },
        configureTaskGit: (taskGit, rootGit) => {
          const stageAllExcept = taskGit.stageAllExcept.bind(taskGit);
          taskGit.stageAllExcept = async () => {
            await stageAllExcept();
            if (taskGit.stageAllExceptCalls === 2) {
              taskGit.headValue = "candidate-base";
              taskGit.diffText = "full accumulated candidate";
              rootGit.diffText = "full accumulated candidate";
            }
          };
          taskGit.stagedDeltaFromPatch = async (previousPatch) => {
            taskGit.stagedDeltaFromPatchCalls.push(previousPatch);
            return { diff: reworkDelta, nameStatus: "M\trework.ts" };
          };
        },
      });

      const taskGit = git.worktreeChild!;
      const taskReviewPrompts = subagents.spawns.filter((spawn) =>
        spawn.description.includes("review task"),
      );
      expect(taskGit.stagedDeltaFromPatchCalls).toEqual([initialDelta]);
      expect(taskReviewPrompts[1]!.prompt).toContain(reworkDelta);
      expect(taskReviewPrompts[1]!.prompt).not.toContain(
        "full accumulated candidate",
      );
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
      expect(taskJson?.taskCommitSha).toBe(taskJson?.landedCommitSha);
      expect(taskJson?.candidateBaseSha).toBe("h1");
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
});
