import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompts.js";
import {
  buildTaskPacket,
  markTaskDone,
  markTaskUndone,
  nextUncheckedTask,
  parsePlanFile,
} from "./plan.js";
import type { GitClient } from "./git.js";
import type { SubagentClient } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import type { RunState } from "./status.js";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseImplementerResult,
  parseReviewerVerdict,
} from "./verdict.js";
import type { StatePaths } from "./state.js";
import { writeTaskJson, appendEvent, taskIdFromTask } from "./state.js";
import type { RunMode } from "./state.js";

const MAX_REVIEWER_REQUESTS = 3;
const MAX_SYSTEM_FAILURES = 2;

type RetryFeedback = {
  source: "reviewer" | "system" | "commit-hook";
  message: string;
};

export type OrchestratorDeps = {
  git: GitClient;
  subagents: SubagentClient;
  planPath: string;
  planArtifacts?: string[];
  roles: EffectiveRoles;
  mode?: RunMode;
  maxConcurrency?: number;
  runId?: string;
  paths?: StatePaths;
  updateState(state: Partial<RunState>): void;
  shouldStop(): boolean;
  signal?: AbortSignal;
};

export async function runImplementation(deps: OrchestratorDeps): Promise<void> {
  deps.updateState({
    phase: "preflight",
    planPath: deps.planPath,
    lastReason: undefined,
  });
  await deps.git.root();
  let plan = parsePlanFile(deps.planPath);
  const planArtifacts = deps.planArtifacts ?? [deps.planPath];
  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree");
  }

  // Serial mode always uses the serial path; no planner spawn
  if (deps.mode === "serial") {
    await runSerialImplementation(deps, plan, planArtifacts);
    return;
  }

  // For auto and parallel modes, we still run serial for now (future tasks will add triage/graph)
  await runSerialImplementation(deps, plan, planArtifacts);
}

async function runSerialImplementation(
  deps: OrchestratorDeps,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
): Promise<void> {
  let plan = initialPlan;

  for (;;) {
    throwIfStopped(deps);
    plan = parsePlanFile(deps.planPath);
    if (!(await deps.git.isCleanExcept(planArtifacts))) {
      throw new BlockedError("dirty worktree");
    }
    const task = nextUncheckedTask(plan);
    deps.updateState({ totalTasks: plan.tasks.length });
    if (!task) {
      deps.updateState({
        phase: "done",
        taskIndex: plan.tasks.length,
        totalTasks: plan.tasks.length,
        activeSubagentId: undefined,
      });
      return;
    }

    const taskId = taskIdFromTask(task.index - 1, task.text);
    const runId = deps.runId ?? "run";
    const branchName = `pi-implement/${runId}/${taskId}`;

    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "pending",
        dependsOn: [],
        attempts: 0,
        integrationAttempts: 0,
      });
    }

    const baseSha = await deps.git.head();
    const paths = deps.paths;
    const useWorktree = deps.mode === "parallel" && paths !== undefined;
    const worktreePath = useWorktree
      ? join(paths.worktreesDir, taskId)
      : undefined;

    if (worktreePath) {
      await deps.git.createTaskBranch(branchName, baseSha);
      await deps.git.addWorktree(worktreePath, branchName);
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "pending",
          dependsOn: [],
          attempts: 0,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
        });
      }
    }

    const taskGit = worktreePath
      ? deps.git.forWorktree(worktreePath, await deps.git.root())
      : deps.git;

    try {
      const landed = await runTaskWorker({
        deps,
        plan,
        task,
        taskId,
        taskGit,
        worktreePath,
        branchName,
        baseSha,
        planArtifacts,
      });
      if (!landed) {
        break;
      }
    } finally {
      if (worktreePath && deps.mode !== "parallel") {
        await deps.git.removeWorktree(worktreePath).catch(() => undefined);
        await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      }
    }

    if (deps.mode === "parallel") {
      throw new BlockedError(
        "parallel task approved, but main-checkout integration is not implemented yet",
      );
    }
  }
}

async function runTaskWorker(args: {
  deps: OrchestratorDeps;
  plan: ReturnType<typeof parsePlanFile>;
  task: ReturnType<typeof parsePlanFile>["tasks"][number];
  taskId: string;
  taskGit: GitClient;
  worktreePath: string | undefined;
  branchName: string;
  baseSha: string;
  planArtifacts: string[];
}): Promise<boolean> {
  const {
    deps,
    plan,
    task,
    taskId,
    taskGit,
    worktreePath,
    branchName,
    baseSha,
    planArtifacts,
  } = args;

  let feedback: RetryFeedback | undefined;
  let priorSummary: string | undefined;
  let reviewerRequests = 0;
  let systemFailures = 0;

  for (;;) {
    throwIfStopped(deps);
    const attempt = reviewerRequests + systemFailures + 1;
    const mainHeadBefore = await deps.git.head();
    const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
    const packet = buildTaskPacket(plan, task);
    const effectiveWorktreePath = worktreePath ?? (await deps.git.root());
    const implementerPrompt = buildImplementerPrompt({
      taskPacket: packet.markdown,
      worktreePath: effectiveWorktreePath,
      feedback: feedback ? formatFeedback(feedback) : undefined,
      priorSummary,
    });
    deps.updateState({
      phase: "coding",
      taskIndex: task.index,
      totalTasks: plan.tasks.length,
      attempt,
      activeSubagentId: undefined,
      lastReason: feedback ? formatFeedback(feedback) : undefined,
    });

    if (deps.paths) {
      persistTaskArtifact(deps.paths, taskId, "prompt.md", implementerPrompt);
    }

    const implementerId = await deps.subagents.spawn({
      type: deps.roles.implementer.type,
      prompt: implementerPrompt,
      description: `implement task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
      model: deps.roles.implementer.model,
    });
    deps.updateState({ activeSubagentId: implementerId });
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "coding",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [implementerId],
      });
      appendEvent(deps.paths, { type: "task_started", taskId });
    }
    const implementation = await deps.subagents.waitFor(
      implementerId,
      deps.signal,
    );
    deps.updateState({ activeSubagentId: undefined });

    if (implementation.status === "stopped") {
      throw new StoppedError();
    }
    throwIfStopped(deps);

    if (implementation.status === "failed") {
      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "failed",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [],
          lastReason: implementation.error,
        });
      }
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        `Implementer subagent failed: ${implementation.error}`,
      );
      systemFailures++;
      continue;
    }

    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "result.md",
        implementation.result,
      );
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "reviewing",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [],
      });
    }

    // Boundary violation: implementer must not change main checkout HEAD
    if ((await deps.git.head()) !== mainHeadBefore) {
      throw new BlockedError("implementer changed HEAD");
    }
    const changedPlanArtifact = changedSnapshotPath(
      planArtifacts,
      planArtifactSnapshot,
    );
    if (changedPlanArtifact) {
      throw new BlockedError(
        `implementer changed a plan artifact: ${changedPlanArtifact}`,
      );
    }

    // Boundary violation: when using worktrees, main checkout must stay clean
    if (worktreePath && !(await deps.git.isCleanExcept(planArtifacts))) {
      throw new BlockedError(
        "implementer dirtied the main checkout outside the task worktree",
      );
    }
    if (worktreePath && (await taskGit.head()) !== baseSha) {
      throw new BlockedError("implementer changed task worktree HEAD");
    }

    const parsed = parseImplementerResult(implementation.result);
    if (!parsed.ok) {
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        parsed.reason,
      );
      systemFailures++;
      continue;
    }
    priorSummary = parsed.result.summary;

    await taskGit.stageAllExcept(planArtifacts);
    if (!(await taskGit.hasStagedChanges())) {
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        "No committable changes were produced after excluding plan artifacts and ignored files.",
      );
      systemFailures++;
      await taskGit.reset();
      continue;
    }
    const fingerprintBefore = await taskGit.stagedFingerprint();
    const candidatePatch = await taskGit.stagedDiff();
    const worktreeFingerprintBefore =
      await taskGit.worktreeFingerprintExcept(planArtifacts);

    if (deps.paths) {
      persistTaskArtifact(deps.paths, taskId, "diff.patch", candidatePatch);
    }

    const reviewHeadBefore = await taskGit.head();
    const reviewerPrompt = buildReviewerPrompt({
      taskPacket: packet.markdown,
      worktreePath: effectiveWorktreePath,
      implementer: parsed.result,
    });
    deps.updateState({ phase: "reviewing", activeSubagentId: undefined });

    if (deps.paths) {
      persistTaskArtifact(deps.paths, taskId, "review.md", reviewerPrompt);
    }

    const reviewerId = await deps.subagents.spawn({
      type: deps.roles.reviewer.type,
      prompt: reviewerPrompt,
      description: `review task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
      model: deps.roles.reviewer.model,
    });
    deps.updateState({ activeSubagentId: reviewerId });
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "reviewing",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [reviewerId],
      });
    }
    const review = await deps.subagents.waitFor(reviewerId, deps.signal);
    deps.updateState({ activeSubagentId: undefined });
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: review.status === "completed" ? "reviewing" : "failed",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [],
        lastReason: review.status !== "completed" ? review.error : undefined,
      });
    }
    if (review.status === "stopped") {
      await taskGit.reset();
      throw new StoppedError();
    }
    await throwIfStoppedAndReset(deps, taskGit);
    if (review.status === "failed") {
      await taskGit.reset();
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        `Reviewer subagent failed: ${review.error}`,
      );
      systemFailures++;
      continue;
    }

    // Boundary violation: reviewer must not change main checkout HEAD
    if ((await deps.git.head()) !== mainHeadBefore) {
      throw new BlockedError("reviewer changed HEAD");
    }
    const changedPlanArtifactAfterReview = changedSnapshotPath(
      planArtifacts,
      planArtifactSnapshot,
    );
    if (changedPlanArtifactAfterReview) {
      throw new BlockedError(
        `reviewer changed a plan artifact: ${changedPlanArtifactAfterReview}`,
      );
    }
    if (worktreePath && !(await deps.git.isCleanExcept(planArtifacts))) {
      throw new BlockedError(
        "reviewer dirtied the main checkout outside the task worktree",
      );
    }
    if ((await taskGit.head()) !== reviewHeadBefore) {
      throw new BlockedError("reviewer changed HEAD");
    }

    await healReviewerMutations({
      taskGit,
      planArtifacts,
      stagedFingerprintBefore: fingerprintBefore,
      candidatePatch,
      worktreeFingerprintBefore,
    });
    const verdict = parseReviewerVerdict(review.result);
    if (verdict.verdict === "changes_requested") {
      await taskGit.reset();
      feedback = recordReviewerRequest(
        task.index,
        reviewerRequests,
        verdict.requiredChanges,
      );
      reviewerRequests++;
      continue;
    }

    // Approved: update state
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "approved",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: 0,
        baseSha,
        worktreePath,
        branchName,
        activeSubagentIds: [],
      });
    }

    const approvedMessage = isValidCommitMessage(parsed.result.commitMessage)
      ? parsed.result.commitMessage.trim()
      : fallbackCommitMessage(task.text);
    deps.updateState({ phase: "committing", lastReason: undefined });
    await throwIfStoppedAndReset(deps, taskGit);

    if (worktreePath) {
      // Worktree mode: commit in the task worktree (non-authoritative task commit)
      const taskCommit = await taskGit.commit(approvedMessage);
      if (taskCommit.exitCode !== 0) {
        const headAfterFailedCommit = await taskGit.head();
        if (headAfterFailedCommit !== reviewHeadBefore) {
          throw new BlockedError(
            "task commit failed but HEAD changed; inspect manually",
          );
        }
        await taskGit.reset();
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "commit-hook",
          `Commit failed. Fix the issue and try again.\n\n${taskCommit.stderr || taskCommit.stdout}`,
        );
        systemFailures++;
        if (deps.paths) {
          writeTaskJson(deps.paths, taskId, {
            id: taskId,
            planIndex: task.index - 1,
            title: task.text,
            status: "integration_failed",
            dependsOn: [],
            attempts: attempt,
            integrationAttempts: systemFailures,
            baseSha,
            worktreePath,
            branchName,
            activeSubagentIds: [],
            lastReason: feedback.message,
          });
          appendEvent(deps.paths, {
            type: "integration_failed",
            taskId,
            reason: feedback.message,
          });
        }
        continue;
      }

      const taskCommitSha = await taskGit.head();
      if (taskCommitSha === reviewHeadBefore) {
        throw new BlockedError(
          "task commit succeeded but HEAD did not advance",
        );
      }
      if ((await deps.git.head()) !== mainHeadBefore) {
        throw new BlockedError("task commit changed main checkout HEAD");
      }
      if (!(await taskGit.isCleanExcept(planArtifacts))) {
        throw new BlockedError(
          "task commit succeeded but task worktree is dirty",
        );
      }
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        throw new BlockedError("task commit dirtied the main checkout");
      }

      if (deps.paths) {
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "approved",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          taskCommitSha,
          activeSubagentIds: [],
        });
        appendEvent(deps.paths, {
          type: "task_approved",
          taskId,
          commitSha: taskCommitSha,
        });
      }
      return true;
    }

    // Non-worktree (legacy serial) mode: stage and commit everything in main
    markTaskDone(deps.planPath, task);
    try {
      throwIfStopped(deps);
    } catch (err) {
      if (err instanceof StoppedError) {
        markTaskUndone(deps.planPath, task);
        await taskGit.reset();
      }
      throw err;
    }
    const commit = await taskGit.commit(approvedMessage);
    if (commit.exitCode === 0) {
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        throw new BlockedError("commit succeeded but worktree is dirty");
      }
      if (deps.paths) {
        const head = await deps.git.head();
        appendEvent(deps.paths, {
          type: "task_approved",
          taskId,
          commitSha: head,
        });
        appendEvent(deps.paths, {
          type: "task_landed",
          taskId,
          commitSha: head,
        });
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "landed",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          landedCommitSha: head,
          activeSubagentIds: [],
        });
      }
      return true;
    }
    const headAfterFailedCommit = await deps.git.head();
    if (headAfterFailedCommit !== reviewHeadBefore) {
      throw new BlockedError(
        "commit failed but HEAD changed; inspect manually",
      );
    }
    try {
      markTaskUndone(deps.planPath, task);
    } catch (err) {
      throw new BlockedError(
        `commit failed and checkbox rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await taskGit.reset();
    feedback = recordSystemFailure(
      task.index,
      systemFailures,
      "commit-hook",
      `Commit failed. Fix the issue and try again.\n\n${commit.stderr || commit.stdout}`,
    );
    systemFailures++;
    if (deps.paths) {
      writeTaskJson(deps.paths, taskId, {
        id: taskId,
        planIndex: task.index - 1,
        title: task.text,
        status: "integration_failed",
        dependsOn: [],
        attempts: attempt,
        integrationAttempts: systemFailures,
        activeSubagentIds: [],
        lastReason: feedback.message,
      });
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: feedback.message,
      });
    }
  }
  return false;
}

async function healReviewerMutations(args: {
  taskGit: GitClient;
  planArtifacts: string[];
  stagedFingerprintBefore: string;
  candidatePatch: string;
  worktreeFingerprintBefore: string;
}): Promise<void> {
  const {
    taskGit,
    planArtifacts,
    stagedFingerprintBefore,
    candidatePatch,
    worktreeFingerprintBefore,
  } = args;
  const stagedFingerprintAfter = await taskGit.stagedFingerprint();
  const worktreeFingerprintAfter =
    await taskGit.worktreeFingerprintExcept(planArtifacts);

  if (
    stagedFingerprintAfter === stagedFingerprintBefore &&
    worktreeFingerprintAfter === worktreeFingerprintBefore
  ) {
    return;
  }

  if (stagedFingerprintAfter === stagedFingerprintBefore) {
    await taskGit.restoreWorktreeFromIndexExcept(planArtifacts);
  } else {
    await taskGit.restoreStagedPatch(candidatePatch, planArtifacts);
  }

  const healedStagedFingerprint = await taskGit.stagedFingerprint();
  const healedWorktreeFingerprint =
    await taskGit.worktreeFingerprintExcept(planArtifacts);
  if (
    healedStagedFingerprint !== stagedFingerprintBefore ||
    healedWorktreeFingerprint !== worktreeFingerprintBefore
  ) {
    throw new BlockedError(
      "reviewer changed the candidate diff and auto-heal failed",
    );
  }
}

export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

export class StoppedError extends Error {
  constructor() {
    super("stopped");
    this.name = "StoppedError";
  }
}

function persistTaskArtifact(
  paths: StatePaths,
  taskId: string,
  filename: string,
  content: string,
): void {
  const dir = join(paths.tasksDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

function snapshotPlanArtifacts(
  paths: string[],
): Map<string, string | undefined> {
  return new Map(
    paths.map((path) => {
      try {
        return [path, readFileSync(path, "utf-8")];
      } catch {
        return [path, undefined];
      }
    }),
  );
}

function changedSnapshotPath(
  paths: string[],
  snapshot: Map<string, string | undefined>,
): string | undefined {
  for (const path of paths) {
    const content = snapshot.get(path);
    try {
      if (readFileSync(path, "utf-8") !== content) {
        return path;
      }
    } catch {
      if (content !== undefined) {
        return path;
      }
    }
  }
  return undefined;
}

function recordSystemFailure(
  taskIndex: number,
  currentFailures: number,
  source: "system" | "commit-hook",
  message: string,
): RetryFeedback {
  if (currentFailures + 1 >= MAX_SYSTEM_FAILURES) {
    throw new BlockedError(
      `system retry limit reached for task ${taskIndex}: ${message}`,
    );
  }
  return { source, message };
}

function recordReviewerRequest(
  taskIndex: number,
  currentRequests: number,
  requiredChanges: string[],
): RetryFeedback {
  const message = requiredChanges.map((change) => `- ${change}`).join("\n");
  if (currentRequests + 1 >= MAX_REVIEWER_REQUESTS) {
    throw new BlockedError(
      `reviewer requested changes limit reached for task ${taskIndex}:\n${message}`,
    );
  }
  return { source: "reviewer", message };
}

function formatFeedback(feedback: RetryFeedback): string {
  return `Source: ${feedback.source}\n${feedback.message}`;
}

function throwIfStopped(deps: OrchestratorDeps): void {
  if (deps.signal?.aborted || deps.shouldStop()) {
    throw new StoppedError();
  }
}

async function throwIfStoppedAndReset(
  deps: OrchestratorDeps,
  taskGit: GitClient,
): Promise<void> {
  try {
    throwIfStopped(deps);
  } catch (err) {
    if (err instanceof StoppedError) {
      await taskGit.reset();
    }
    throw err;
  }
}

function shortTask(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}
