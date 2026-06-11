import { exec, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  buildAlreadySatisfiedReviewerPrompt,
  buildImplementerPrompt,
  buildIntegrationSelfHealPrompt,
  buildOverallReviewerPrompt,
  buildOverallReworkPrompt,
  buildReviewerPrompt,
  buildSchedulerSelfHealPrompt,
} from "./prompts.js";
import {
  buildTaskPacket,
  markTaskDone,
  markTaskUndone,
  nextUncheckedTask,
  parsePlanFile,
} from "./plan.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SubagentClient, SubagentResult } from "./subagents.js";
import type {
  EffectiveRoles,
  EffectiveScoutConfig,
  EffectiveTaskReviewConfig,
} from "./config.js";
import { resolveEffectiveTaskReview } from "./config.js";
import {
  buildScoutPrompt,
  buildScoutUnavailableNote,
  decideScout,
  formatScoutContext,
} from "./scout.js";
import type {
  RunState,
  ParallelTaskState,
  AgentDisplayRef,
  StatePatch,
} from "./status.js";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseImplementerResult,
  parseIntegrationSelfHealResult,
  parseOverallReviewVerdict,
  parseOverallReworkResult,
  parseReviewerVerdict,
  parseSchedulerSelfHealResult,
} from "./verdict.js";
import type {
  IntegrationSelfHealResult,
  SchedulerSelfHealResult,
} from "./verdict.js";
import type {
  ValidationEvidence,
  StagedFileSummary,
  TaskReviewDecision,
} from "./review-policy.js";
import { decideTaskReview } from "./review-policy.js";
import type { StatePaths, TaskJson } from "./state.js";
import {
  writeTaskJson,
  appendEvent,
  taskIdFromTask,
  readTaskJson,
  readRunJson,
  readEvents,
} from "./state.js";
import type { RunMode } from "./state.js";
import { readGraphJson } from "./graph.js";
import type {
  ImplementGraph,
  ScoutDirective,
  TaskReviewDirective,
} from "./graph.js";
import {
  createSchedulerRun,
  computeReadyTasks,
  canStartTask,
  startTask,
  nextTaskToLand,
  allTasksTerminal,
  anyTaskFailedBlockedStopped,
  getBlockedReason,
  type SchedulerRun,
  type SchedulerTask,
  type SchedulerTaskStatus,
} from "./scheduler.js";
import { checkpointPatch } from "./status.js";
import {
  formatBundleMaterial,
  validatePlanMaterialSizes,
  type PlanBundleManifest,
} from "./manifest.js";

// One initial full review plus up to two anchored re-reviews.
// If the second anchored re-review still returns unresolved required changes, block.
const MAX_ANCHORED_REVIEW_CHANGE_REQUESTS = 2;
const MAX_SYSTEM_FAILURES = 2;
const MAX_ACCUMULATED_DIFF_CHARS = 50000;
const MAX_REWORK_ATTEMPTS = 2;
const MAX_SELF_HEAL_ATTEMPTS = 2;
const MAX_OVERALL_REWORK_ATTEMPTS = 2;
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type RetryFeedback = {
  source: "reviewer" | "system" | "commit-hook" | "integration";
  message: string;
};

export type OrchestratorDeps = {
  git: GitClient;
  subagents: SubagentClient;
  planPath: string;
  planArtifacts?: string[];
  manifest?: PlanBundleManifest;
  roles: EffectiveRoles;
  mode?: RunMode;
  maxConcurrency?: number;
  runId?: string;
  paths?: StatePaths;
  updateState(state: StatePatch): void;
  shouldStop(): boolean;
  signal?: AbortSignal;
  verifyCommand?: string;
  scout?: EffectiveScoutConfig;
  effectiveTaskReview?: EffectiveTaskReviewConfig;
};

export async function runImplementation(deps: OrchestratorDeps): Promise<void> {
  deps.updateState({
    phase: "preflight",
    planPath: deps.planPath,
    lastReason: undefined,
  });
  await deps.git.root();
  if (deps.manifest) {
    if (deps.manifest.validationErrors.length > 0) {
      throw new BlockedError(
        `plan bundle validation failed:\n${deps.manifest.validationErrors.join("\n")}`,
      );
    }
    const materialSizeErrors = validatePlanMaterialSizes(deps.manifest);
    if (materialSizeErrors.length > 0) {
      throw new BlockedError(
        `plan material too large:\n${materialSizeErrors.join("\n")}`,
      );
    }
  }
  let plan = parsePlanFile(deps.planPath);
  const planArtifacts = deps.planArtifacts ?? [deps.planPath];
  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree");
  }

  const runBaseSha = deps.paths
    ? (readRunJson(deps.paths)?.baseSha ?? (await deps.git.head()))
    : await deps.git.head();

  if (deps.mode === "serial") {
    await runSerialImplementation(deps, plan, planArtifacts, runBaseSha);
    return;
  }

  // For auto/parallel: try to load a graph and run the scheduler
  const graph = deps.paths ? readGraphJson(deps.paths.runDir) : undefined;
  if (graph && deps.paths && deps.runId) {
    await runParallelImplementation(
      deps,
      graph,
      plan,
      planArtifacts,
      runBaseSha,
    );
    return;
  }

  // Fallback to serial if no graph (shouldn't happen in normal flow)
  await runSerialImplementation(deps, plan, planArtifacts, runBaseSha);
}

async function runSerialImplementation(
  deps: OrchestratorDeps,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  let plan = initialPlan;

  for (;;) {
    throwIfStopped(deps);
    plan = parsePlanFile(deps.planPath);
    if (!(await deps.git.isCleanExcept(planArtifacts))) {
      throw new BlockedError("dirty worktree");
    }
    const task = nextUncheckedTask(plan);
    deps.updateState({
      taskIndex: task?.index ?? completedPlanTaskIndex(plan),
      totalTasks: plan.tasks.length,
    });
    if (!task) {
      await runOverallReviewLoop(deps, plan, planArtifacts, runBaseSha);
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
    const worktreePath =
      deps.mode === "parallel" && paths
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
        runBaseSha,
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

// ── Parallel scheduler ──────────────────────────────────────────────────────

type WorkerResult = {
  taskId: string;
  outcome:
    | { kind: "approved"; taskCommitSha: string; commitMessage: string }
    | { kind: "failed"; reason: string }
    | { kind: "stopped" };
};

async function runParallelImplementation(
  deps: OrchestratorDeps,
  graph: ImplementGraph,
  initialPlan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  const sched = createSchedulerRun(graph, deps.maxConcurrency ?? 1);
  const runningWorkers = new Map<string, Promise<WorkerResult>>();
  let plan = initialPlan;
  const reworkTaskIds = new Set<string>();
  let schedulerSelfHealAttempts = 0;
  let schedulerSelfHealFailed = false;
  let schedulerSelfHealRemainingBlocker: string | undefined;

  deps.updateState({
    phase: "scheduling",
    runId: deps.runId,
    mode: deps.mode,
    baseSha: graph.baseSha,
    maxConcurrency: deps.maxConcurrency,
    totalCount: graph.nodes.length,
    landedCount: 0,
  });

  scheduler: for (;;) {
    if (allTasksTerminal(sched)) {
      if (anyTaskFailedBlockedStopped(sched)) {
        const healProgress = await attemptSchedulerSelfHeal(
          deps,
          sched,
          graph,
          plan,
          planArtifacts,
          schedulerSelfHealAttempts,
        );
        schedulerSelfHealAttempts = healProgress.attempts;
        schedulerSelfHealRemainingBlocker = healProgress.remainingBlocker;
        if (healProgress.hasProgress) {
          continue scheduler;
        }
        if (healProgress.attempted) {
          schedulerSelfHealFailed = true;
        }
      }
      break;
    }

    throwIfStopped(deps);
    plan = parsePlanFile(deps.planPath);

    // ── Start ready tasks ──
    const ready = computeReadyTasks(sched).filter((id) =>
      canStartTask(sched, id),
    );
    for (const taskId of ready) {
      if (runningWorkers.has(taskId)) {
        continue;
      }
      const wasNeedsRework = sched.tasks.get(taskId)?.status === "needs_rework";
      if (wasNeedsRework) {
        reworkTaskIds.add(taskId);
      }
      startTask(sched, taskId);

      const taskNode = graph.nodes.find((n) => n.id === taskId)!;
      const planTask = plan.tasks.find((t) => t.index === taskNode.planIndex);
      if (!planTask) {
        const task = sched.tasks.get(taskId)!;
        task.status = "failed";
        task.lastReason = `Plan task ${taskNode.planIndex} not found`;
        continue;
      }

      const promise = launchTaskWorker(
        deps,
        sched,
        taskId,
        planTask,
        planArtifacts,
        runBaseSha,
        wasNeedsRework,
        taskNode.review,
        taskNode.scout,
      );
      runningWorkers.set(taskId, promise);
    }

    updateParallelState(deps, sched);

    const hasActiveRework = [...reworkTaskIds].some((id) =>
      runningWorkers.has(id),
    );

    // ── Try landing (serialized, plan-ordered) ──
    const toLand = nextTaskToLand(sched);
    if (toLand && !hasActiveRework) {
      const landResult = await landApprovedTask(
        deps,
        sched,
        toLand,
        plan,
        planArtifacts,
      );
      if (landResult === "landed") {
        continue; // Keep looping to possibly land more
      } else if (landResult === "needs_rework") {
        // The task status is already set to needs_rework; it will restart
        continue;
      }
      // integration_failed stays as is; loop continues
    }

    // ── Wait for next worker or integration event ──
    if (runningWorkers.size > 0) {
      // Race all running workers for the next completion
      const result = await Promise.race(runningWorkers.values());
      runningWorkers.delete(result.taskId);
      reworkTaskIds.delete(result.taskId);

      const task = sched.tasks.get(result.taskId)!;
      if (result.outcome.kind === "approved") {
        task.status = "approved";
        task.taskCommitSha = result.outcome.taskCommitSha;
        task.approvedCommitMessage = result.outcome.commitMessage;
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "approved",
            taskCommitSha: result.outcome.taskCommitSha,
            commitMessage: result.outcome.commitMessage,
            activeSubagentIds: [],
          });
          appendEvent(deps.paths, {
            type: "task_approved",
            taskId: result.taskId,
            commitSha: result.outcome.taskCommitSha,
          });
        }
      } else if (result.outcome.kind === "failed") {
        task.status = "failed";
        task.lastReason = result.outcome.reason;
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "failed",
            activeSubagentIds: [],
            lastReason: result.outcome.reason,
          });
        }
      } else {
        // stopped
        task.status = "stopped";
        task.activeAgentIds = [];
        task.activeAgentRefs = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...buildTaskJsonSnapshot(existing, task),
            status: "stopped",
            activeSubagentIds: [],
          });
        }
      }
      continue;
    }

    // Nothing running and nothing to land
    if (!toLand && !hasActiveRework) {
      const healProgress = await attemptSchedulerSelfHeal(
        deps,
        sched,
        graph,
        plan,
        planArtifacts,
        schedulerSelfHealAttempts,
      );
      schedulerSelfHealAttempts = healProgress.attempts;
      schedulerSelfHealRemainingBlocker = healProgress.remainingBlocker;
      if (healProgress.hasProgress) {
        continue;
      }
      schedulerSelfHealFailed = true;
      sched.phase = "blocked";
      break;
    }
  }

  if (!allTasksTerminal(sched)) {
    const reason = stalledSchedulerReason(
      sched,
      schedulerSelfHealFailed,
      schedulerSelfHealRemainingBlocker,
    );
    deps.updateState({ phase: "blocked", lastReason: reason });
    throw new BlockedError(reason);
  }

  if (!anyTaskFailedBlockedStopped(sched)) {
    const finalValidation = await validateFinalParallelRun(deps);
    if (!finalValidation.ok) {
      sched.phase = "blocked";
      deps.updateState({
        phase: "blocked",
        lastReason: finalValidation.reason,
      });
      throw new BlockedError(finalValidation.reason);
    }
    await runOverallReviewLoop(deps, initialPlan, planArtifacts, graph.baseSha);
  }

  const landedCount = [...sched.tasks.values()].filter(
    (t) => t.status === "landed",
  ).length;
  const hasFailure = anyTaskFailedBlockedStopped(sched);
  const failureReason = hasFailure
    ? stalledSchedulerReason(
        sched,
        schedulerSelfHealFailed,
        schedulerSelfHealRemainingBlocker,
      )
    : undefined;
  deps.updateState({
    phase: hasFailure
      ? "blocked"
      : sched.phase === "done" || allTasksTerminal(sched)
        ? "done"
        : (sched.phase as RunState["phase"]),
    landedCount,
    activeSubagentId: undefined,
    activeSubagentIds: [],
    activeAgentRefs: [],
    ...(failureReason ? { lastReason: failureReason } : {}),
  });

  if (failureReason) {
    throw new BlockedError(failureReason);
  }
}

async function launchTaskWorker(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
  planTask: ReturnType<typeof parsePlanFile>["tasks"][number],
  planArtifacts: string[],
  runBaseSha: string,
  wasNeedsRework: boolean,
  plannerDirective?: TaskReviewDirective,
  scoutDirective?: ScoutDirective,
): Promise<WorkerResult> {
  const task = sched.tasks.get(taskId)!;
  const baseSha = await deps.git.head();
  const runId = deps.runId ?? "run";
  const branchName = `pi-implement/${runId}/${taskId}`;
  const worktreePath = deps.paths
    ? join(deps.paths.worktreesDir, taskId)
    : undefined;

  if (worktreePath) {
    try {
      if (wasNeedsRework) {
        await deps.git.removeWorktree(worktreePath).catch(() => undefined);
        await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      }
      await deps.git.createTaskBranch(branchName, baseSha);
      await deps.git.addWorktree(worktreePath, branchName);
      task.worktreePath = worktreePath;
      task.branchName = branchName;
      if (deps.paths) {
        const existing = readTaskJson(deps.paths, taskId);
        writeTaskJson(deps.paths, taskId, {
          ...buildTaskJsonSnapshot(existing, task),
          status: "coding",
          baseSha,
          worktreePath,
          branchName,
        });
        appendEvent(deps.paths, { type: "task_started", taskId });
      }
    } catch (err) {
      await deps.git.removeWorktree(worktreePath).catch(() => undefined);
      await deps.git.deleteTaskBranch(branchName).catch(() => undefined);
      const reason = err instanceof Error ? err.message : String(err);
      return {
        taskId,
        outcome: { kind: "failed", reason: `Worktree setup failed: ${reason}` },
      };
    }
  }

  const taskGit = worktreePath
    ? deps.git.forWorktree(worktreePath, await deps.git.root())
    : deps.git;

  const plan = parsePlanFile(deps.planPath);

  try {
    const success = await runTaskWorker({
      deps,
      plan,
      task: planTask,
      taskId,
      taskGit,
      worktreePath,
      branchName,
      baseSha,
      planArtifacts,
      schedulerTask: task,
      runBaseSha,
      plannerDirective,
      scoutDirective,
      wasNeedsRework,
      initialFeedback:
        wasNeedsRework && task.lastReason
          ? { source: "integration", message: task.lastReason }
          : undefined,
      attemptOrdinalBase: task.integrationAttempts,
    });

    if (deps.shouldStop() || deps.signal?.aborted) {
      return { taskId, outcome: { kind: "stopped" } };
    }

    if (success && worktreePath) {
      const taskCommitSha = await taskGit.head();
      const taskJson = deps.paths
        ? readTaskJson(deps.paths, taskId)
        : undefined;
      const commitMessage =
        taskJson?.commitMessage ?? `chore: implement ${task.title}`;
      return {
        taskId,
        outcome: { kind: "approved", taskCommitSha, commitMessage },
      };
    }

    return {
      taskId,
      outcome: {
        kind: "failed",
        reason: task.lastReason ?? "Task worker failed",
      },
    };
  } catch (err) {
    if (err instanceof StoppedError) {
      return { taskId, outcome: { kind: "stopped" } };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { taskId, outcome: { kind: "failed", reason } };
  }
}

async function landApprovedTask(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
): Promise<"landed" | "needs_rework" | "integration_failed"> {
  const task = sched.tasks.get(taskId)!;
  if (!task.taskCommitSha) {
    return markIntegrationFailure(
      deps,
      task,
      taskId,
      "Task commit SHA missing",
    );
  }

  task.status = "integrating";
  deps.updateState({ phase: "integrating" });

  const planTask = plan.tasks.find((t) => t.index === task.planIndex);
  if (!planTask) {
    return markIntegrationFailure(deps, task, taskId, "Plan task not found");
  }

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    return markIntegrationFailure(
      deps,
      task,
      taskId,
      "Main checkout dirty before integration",
    );
  }

  const preIntegrationHead = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);

  const failForRework = async (source: string, reason: string) => {
    await rollbackIntegration(
      deps,
      preIntegrationHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    task.integrationAttempts++;
    task.lastReason = `${source}: ${reason}`;
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration.md",
        `# Integration failed\n\nSource: ${source}\n\nPre-integration HEAD: ${preIntegrationHead}\n\n${reason}\n`,
      );
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: task.lastReason,
      });
    }
    if (task.integrationAttempts > MAX_REWORK_ATTEMPTS) {
      task.status = "integration_failed";
      return "integration_failed" as const;
    }
    task.status = "needs_rework";
    return "needs_rework" as const;
  };

  const failBlocked = async (source: string, reason: string) => {
    await rollbackIntegration(
      deps,
      preIntegrationHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    task.integrationAttempts++;
    task.status = "integration_failed";
    task.lastReason = `${source}: ${reason}`;
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        "integration.md",
        `# Integration blocked\n\nSource: ${source}\n\nPre-integration HEAD: ${preIntegrationHead}\n\n${reason}\n`,
      );
      appendEvent(deps.paths, {
        type: "integration_failed",
        taskId,
        reason: task.lastReason,
      });
      const existing = readTaskJson(deps.paths, taskId);
      writeTaskJson(deps.paths, taskId, {
        ...buildTaskJsonSnapshot(existing, task),
        status: "integration_failed",
        lastReason: task.lastReason,
      });
    }
    return "integration_failed" as const;
  };

  try {
    task.selfHealAttempts = 0;

    // ── Cherry-pick with optional self-heal ──
    let cherryPick = await deps.git.cherryPickNoCommit(task.taskCommitSha);
    let cherryPickSucceeded = cherryPick.exitCode === 0;
    if (!cherryPickSucceeded) {
      const preHealStagedPaths = parseNameStatusPaths(
        await deps.git.stagedNameStatus(),
      );
      const preHealSnapshot: IntegrationCandidateSnapshot = {
        head: preIntegrationHead,
        stagedFingerprint: "",
        worktreeFingerprint: "",
        stagedPaths: preHealStagedPaths,
      };
      const healResult = await tryIntegrationSelfHeal(
        deps,
        task,
        taskId,
        plan,
        planArtifacts,
        preIntegrationHead,
        planArtifactSnapshot,
        "cherry-pick",
        cherryPick.stderr ||
          cherryPick.stdout ||
          "git cherry-pick --no-commit failed",
      );
      // Always verify safety after a self-heal attempt, regardless of whether
      // the repair agent returned a retryable result.
      if (task.selfHealAttempts > 0) {
        const safety = await checkSelfHealSafety(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
          healResult?.result,
          preHealSnapshot,
        );
        if (safety) {
          return await failBlocked("self-heal", safety);
        }
      }
      if (healResult?.result.retryIntegration) {
        if (healResult.result.retryMode === "retry_cherry_pick") {
          await rollbackIntegration(
            deps,
            preIntegrationHead,
            planArtifacts,
            planArtifactSnapshot,
          );
          cherryPick = await deps.git.cherryPickNoCommit(task.taskCommitSha);
          cherryPickSucceeded = cherryPick.exitCode === 0;
        } else {
          cherryPickSucceeded = true;
        }
      }
      if (!cherryPickSucceeded) {
        return await failForRework(
          "cherry-pick",
          cherryPick.stderr ||
            cherryPick.stdout ||
            "git cherry-pick --no-commit failed",
        );
      }
    }

    let candidateSnapshot = await snapshotIntegrationCandidate(
      deps,
      planArtifacts,
    );

    // ── Validation with optional self-heal ──
    let validation = await validateIntegratedTask(
      deps,
      taskId,
      planArtifacts,
      task,
    );
    while (!validation.ok && task.selfHealAttempts < MAX_SELF_HEAL_ATTEMPTS) {
      const preHealSnapshot = candidateSnapshot;
      const healResult = await tryIntegrationSelfHeal(
        deps,
        task,
        taskId,
        plan,
        planArtifacts,
        preIntegrationHead,
        planArtifactSnapshot,
        "validation",
        validation.reason,
      );
      // Always verify safety after a self-heal attempt, regardless of whether
      // the repair agent returned a retryable result.
      if (task.selfHealAttempts > 0) {
        const safety = await checkSelfHealSafety(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
          healResult?.result,
          preHealSnapshot,
        );
        if (safety) {
          return await failBlocked("self-heal", safety);
        }
      }
      if (!healResult?.result.retryIntegration) {
        break;
      }

      if (healResult.result.retryMode === "retry_cherry_pick") {
        await rollbackIntegration(
          deps,
          preIntegrationHead,
          planArtifacts,
          planArtifactSnapshot,
        );
        const cp = await deps.git.cherryPickNoCommit(task.taskCommitSha);
        if (cp.exitCode !== 0) {
          return await failForRework(
            "cherry-pick",
            cp.stderr || cp.stdout || "git cherry-pick --no-commit failed",
          );
        }
      }

      candidateSnapshot = await snapshotIntegrationCandidate(
        deps,
        planArtifacts,
      );
      validation = await validateIntegratedTask(
        deps,
        taskId,
        planArtifacts,
        task,
      );
    }

    if (!validation.ok) {
      return await failForRework("validation", validation.reason);
    }
    const mutationReason = await detectIntegrationMutation(
      deps,
      planArtifacts,
      planArtifactSnapshot,
      candidateSnapshot,
    );
    if (mutationReason) {
      return await failBlocked("validation", mutationReason);
    }

    const commit = await deps.git.commit(
      task.approvedCommitMessage ?? `chore: implement ${task.title}`,
    );
    if (commit.exitCode !== 0) {
      return await failForRework(
        "commit-hook",
        commit.stderr || commit.stdout || "git commit failed",
      );
    }

    const landedHead = await deps.git.head();
    if (landedHead === preIntegrationHead) {
      return await failForRework(
        "commit",
        "Commit succeeded but HEAD did not advance",
      );
    }
    const changedPlanArtifactAfterCommit = changedSnapshotPath(
      planArtifacts,
      planArtifactSnapshot,
    );
    if (changedPlanArtifactAfterCommit) {
      return await failBlocked(
        "commit",
        `Commit hook changed a plan artifact: ${changedPlanArtifactAfterCommit}`,
      );
    }
    if (!(await deps.git.isCleanExcept(planArtifacts))) {
      return await failBlocked(
        "commit",
        "Commit succeeded but main checkout is dirty",
      );
    }

    markTaskDone(deps.planPath, planTask);

    task.status = "landed";
    task.landedCommitSha = landedHead;
    sched.landedOrder.push(taskId);

    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "task_landed",
        taskId,
        commitSha: landedHead,
      });
      const existing = readTaskJson(deps.paths, taskId);
      writeTaskJson(deps.paths, taskId, {
        ...buildTaskJsonSnapshot(existing, task),
        status: "landed",
        landedCommitSha: landedHead,
      });
    }

    deps.updateState((prev) => ({
      currentMainHead: landedHead,
      ...checkpointPatch(
        prev,
        `\u2713 Task ${task.planIndex + 1}/${plan.tasks.length} landed @ ${landedHead.slice(0, 7)}`,
      ),
    }));
    return "landed";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failForRework("integration", reason);
  }
}

function markIntegrationFailure(
  deps: OrchestratorDeps,
  task: SchedulerTask,
  taskId: string,
  reason: string,
): "integration_failed" {
  task.status = "integration_failed";
  task.lastReason = reason;
  if (deps.paths) {
    appendEvent(deps.paths, { type: "integration_failed", taskId, reason });
    const existing = readTaskJson(deps.paths, taskId);
    writeTaskJson(deps.paths, taskId, {
      ...buildTaskJsonSnapshot(existing, task),
      status: "integration_failed",
      lastReason: reason,
    });
  }
  return "integration_failed";
}

async function rollbackIntegration(
  deps: OrchestratorDeps,
  preIntegrationHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
): Promise<void> {
  await deps.git.cherryPickAbort().catch(async () => {
    await deps.git.resetHard(preIntegrationHead).catch(() => undefined);
  });
  await deps.git.resetHard(preIntegrationHead).catch(() => undefined);
  await deps.git
    .restoreWorktreeFromIndexExcept(planArtifacts)
    .catch(() => undefined);
  restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
}

type IntegrationCandidateSnapshot = {
  head: string;
  stagedFingerprint: string;
  worktreeFingerprint: string;
  stagedPaths: string[];
};

async function snapshotIntegrationCandidate(
  deps: OrchestratorDeps,
  planArtifacts: string[],
): Promise<IntegrationCandidateSnapshot> {
  const [head, stagedFingerprint, worktreeFingerprint, stagedNameStatus] =
    await Promise.all([
      deps.git.head(),
      deps.git.stagedFingerprint(),
      deps.git.worktreeFingerprintExcept(planArtifacts),
      deps.git.stagedNameStatus(),
    ]);
  const stagedPaths = parseNameStatusPaths(stagedNameStatus);
  return { head, stagedFingerprint, worktreeFingerprint, stagedPaths };
}

async function detectIntegrationMutation(
  deps: OrchestratorDeps,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
  snapshot: IntegrationCandidateSnapshot,
): Promise<string | undefined> {
  if ((await deps.git.head()) !== snapshot.head) {
    return "Validation or integration review changed HEAD";
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    return `Validation or integration review changed a plan artifact: ${changedPlanArtifact}`;
  }
  const stagedFingerprint = await deps.git.stagedFingerprint();
  if (stagedFingerprint !== snapshot.stagedFingerprint) {
    return "Validation or integration review changed the staged integration diff";
  }
  const worktreeFingerprint =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  if (worktreeFingerprint !== snapshot.worktreeFingerprint) {
    return "Validation or integration review changed the integration worktree";
  }
  return undefined;
}

async function tryIntegrationSelfHeal(
  deps: OrchestratorDeps,
  task: SchedulerTask,
  taskId: string,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  preIntegrationHead: string,
  planArtifactSnapshot: Map<string, string | undefined>,
  failureSource: "cherry-pick" | "validation",
  failureDetails: string,
): Promise<{ ok: true; result: IntegrationSelfHealResult } | undefined> {
  if (task.selfHealAttempts >= MAX_SELF_HEAL_ATTEMPTS) {
    return undefined;
  }
  task.selfHealAttempts++;

  const landedTasks = deps.paths ? getLandedTasks(deps.paths) : undefined;
  const graphContext = deps.paths
    ? buildGraphContext(deps.paths.runDir)
    : undefined;
  const runArtifactPaths = deps.paths
    ? collectRunArtifactPaths(deps.paths, taskId)
    : undefined;
  const prompt = buildIntegrationSelfHealPrompt({
    taskId,
    title: task.title,
    planIndex: task.planIndex - 1,
    taskCommitSha: task.taskCommitSha!,
    preIntegrationHead,
    mainCheckoutPath: await deps.git.root(),
    worktreePath: task.worktreePath,
    validationCommands: deps.verifyCommand ? [deps.verifyCommand] : undefined,
    validationFailure:
      failureSource === "validation" ? failureDetails : undefined,
    cherryPickFailure:
      failureSource === "cherry-pick" ? failureDetails : undefined,
    landedTasks,
    runArtifactPaths,
    graphContext,
  });

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "self_heal_started",
      taskId,
      attempt: task.selfHealAttempts,
    });
    persistTaskArtifact(
      deps.paths,
      taskId,
      `self-heal-${task.selfHealAttempts}.md`,
      prompt,
    );
  }

  const id = await deps.subagents.spawn({
    type: deps.roles.implementer.type,
    prompt,
    description: `integration self-heal ${taskId}`,
    model: deps.roles.implementer.model,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "implementer",
    label: `Integration self-heal \u00b7 ${taskId}`,
    startedAt: new Date().toISOString(),
  };
  setSchedulerActiveAgent(task, ref);
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));

  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    clearSchedulerActiveAgent(task, id);
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });

  if (result.status !== "completed") {
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "self_heal_failed",
        taskId,
        attempt: task.selfHealAttempts,
        reason: result.status === "stopped" ? "stopped" : result.error,
      });
    }
    return undefined;
  }

  if (deps.paths) {
    persistTaskArtifact(
      deps.paths,
      taskId,
      `self-heal-${task.selfHealAttempts}-result.md`,
      result.result,
    );
    appendEvent(deps.paths, {
      type: "self_heal_completed",
      taskId,
      attempt: task.selfHealAttempts,
      result: result.result,
    });
  }

  const parsed = parseIntegrationSelfHealResult(result.result);
  if (!parsed.ok) {
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "self_heal_failed",
        taskId,
        attempt: task.selfHealAttempts,
        reason: parsed.reason,
      });
    }
    return undefined;
  }

  return parsed;
}

async function checkSelfHealSafety(
  deps: OrchestratorDeps,
  preIntegrationHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
  healResult: IntegrationSelfHealResult | undefined,
  preHealSnapshot?: IntegrationCandidateSnapshot,
): Promise<string | undefined> {
  if ((await deps.git.head()) !== preIntegrationHead) {
    return "Self-heal changed HEAD";
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    return `Self-heal changed a plan artifact: ${changedPlanArtifact}`;
  }
  if (preHealSnapshot && (await deps.git.head()) !== preHealSnapshot.head) {
    return "Self-heal changed HEAD relative to pre-heal snapshot";
  }

  const { unstaged, untracked } = await collectChangedPaths(deps);

  const allowedUntracked = new Set<string>();
  const allowedUnstaged = new Set<string>();

  if (indicatesDependencyInstallation(healResult)) {
    for (const path of untracked) {
      if (isPackageManagerFile(path)) {
        allowedUntracked.add(path);
      }
    }
    for (const path of unstaged) {
      if (isPackageManagerFile(path)) {
        allowedUnstaged.add(path);
      }
    }
  }

  const disallowedUntracked = untracked.filter((p) => !allowedUntracked.has(p));
  const disallowedUnstaged = unstaged.filter((p) => !allowedUnstaged.has(p));

  if (disallowedUntracked.length > 0) {
    return `Self-heal left unexpected untracked files: ${disallowedUntracked.join(", ")}`;
  }
  if (disallowedUnstaged.length > 0) {
    return `Self-heal left unexpected unstaged changes: ${disallowedUnstaged.join(", ")}`;
  }

  return undefined;
}

// ── Scheduler self-heal ───────────────────────────────────────────────────

type SchedulerSelfHealProgress = {
  attempted: boolean;
  attempts: number;
  hasProgress: boolean;
  remainingBlocker?: string;
};

async function attemptSchedulerSelfHeal(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  graph: ImplementGraph,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  currentAttempts: number,
): Promise<SchedulerSelfHealProgress> {
  const baseline = await captureSchedulerSelfHealBaseline(
    deps,
    sched,
    planArtifacts,
  );
  const healResult = await trySchedulerSelfHeal(
    deps,
    sched,
    graph,
    plan,
    planArtifacts,
    currentAttempts,
  );
  if (!healResult?.ok) {
    return {
      attempted: false,
      attempts: currentAttempts,
      hasProgress: false,
    };
  }

  const attempts = currentAttempts + 1;
  const progress = await checkSchedulerSelfHealProgress(
    deps,
    sched,
    planArtifacts,
    baseline,
    healResult.result,
  );
  if (progress.hasProgress) {
    for (const taskId of progress.revivedTaskIds) {
      reviveTaskForSchedulerRetry(deps, sched, taskId);
    }
  }

  return {
    attempted: true,
    attempts,
    hasProgress: progress.hasProgress,
    remainingBlocker: healResult.result.remainingBlocker ?? undefined,
  };
}

async function trySchedulerSelfHeal(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  graph: ImplementGraph,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  currentAttempts: number,
): Promise<{ ok: true; result: SchedulerSelfHealResult } | undefined> {
  if (currentAttempts >= MAX_SELF_HEAL_ATTEMPTS) {
    return undefined;
  }

  const baseSha = graph.baseSha;
  const currentHead = await deps.git.head();
  const gitStatus = await deps.git.status();
  const runId = deps.runId ?? "run";
  const matchingBranches = await deps.git.listBranchesMatching(
    `pi-implement/${runId}/*`,
  );
  const worktrees = await deps.git.listWorktrees();

  const graphSummary = buildSchedulerGraphSummary(sched, graph);

  const eventsTail = deps.paths
    ? readEvents(deps.paths)
        .slice(-20)
        .map((e) => JSON.stringify(e))
        .join("\n")
    : "";

  const artifactPaths: string[] = [];
  for (const task of sched.tasks.values()) {
    if (deps.paths) {
      const taskArtifacts = collectRunArtifactPaths(deps.paths, task.id);
      if (taskArtifacts) {
        artifactPaths.push(...taskArtifacts);
      }
    }
  }

  const prompt = buildSchedulerSelfHealPrompt({
    runId,
    mode: deps.mode,
    maxConcurrency: deps.maxConcurrency,
    baseSha,
    currentHead,
    planPath: deps.planPath,
    graphSummary,
    eventsTail,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
    gitStatus,
    matchingBranches,
    worktrees,
  });

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "scheduler_self_heal_started",
      attempt: currentAttempts + 1,
    });
  }

  try {
    const id = await deps.subagents.spawn({
      type: deps.roles.implementer.type,
      prompt,
      description: `scheduler self-heal ${runId}`,
      model: deps.roles.implementer.model,
    });
    const ref: AgentDisplayRef = {
      id,
      role: "implementer",
      label: `Scheduler self-heal \u00b7 ${runId}`,
      startedAt: new Date().toISOString(),
    };
    deps.updateState((prev) => addActiveAgentPatch(prev, ref));

    const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
      deps.updateState((prev) => removeActiveAgentPatch(prev, id));
    });

    if (result.status !== "completed") {
      if (deps.paths) {
        appendEvent(deps.paths, {
          type: "scheduler_self_heal_failed",
          attempt: currentAttempts + 1,
          reason: result.status === "stopped" ? "stopped" : result.error,
        });
      }
      return undefined;
    }

    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "scheduler_self_heal_completed",
        attempt: currentAttempts + 1,
        result: result.result,
      });
    }

    const parsed = parseSchedulerSelfHealResult(result.result);
    if (!parsed.ok) {
      if (deps.paths) {
        appendEvent(deps.paths, {
          type: "scheduler_self_heal_failed",
          attempt: currentAttempts + 1,
          reason: parsed.reason,
        });
      }
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

type SchedulerSelfHealBaseline = {
  head: string;
  planArtifactSnapshot: Map<string, string | undefined>;
  gitStatusText: string;
  wasClean: boolean;
  branches: string[];
  worktrees: string[];
  taskStates: Map<string, { status: SchedulerTaskStatus; lastReason?: string }>;
  taskJsonStates: Map<
    string,
    { status: SchedulerTaskStatus; lastReason?: string } | undefined
  >;
  setupBlockers: Map<
    string,
    { branchExists: boolean; worktreeExists: boolean; aheadOfBase: boolean }
  >;
};

export async function captureSchedulerSelfHealBaseline(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  planArtifacts: string[],
): Promise<SchedulerSelfHealBaseline> {
  const head = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
  const gitStatusText = await deps.git.status();
  const wasClean = await deps.git.isCleanExcept(planArtifacts);
  const runId = deps.runId ?? "run";
  const branches = await deps.git.listBranchesMatching(
    `pi-implement/${runId}/*`,
  );
  const worktrees = await deps.git.listWorktrees();
  const taskStates = new Map<
    string,
    { status: SchedulerTaskStatus; lastReason?: string }
  >();
  const taskJsonStates = new Map<
    string,
    { status: SchedulerTaskStatus; lastReason?: string } | undefined
  >();
  const setupBlockers = new Map<
    string,
    { branchExists: boolean; worktreeExists: boolean; aheadOfBase: boolean }
  >();

  for (const task of sched.tasks.values()) {
    taskStates.set(task.id, {
      status: task.status,
      lastReason: task.lastReason,
    });
    if (deps.paths) {
      const onDisk = readTaskJson(deps.paths, task.id);
      taskJsonStates.set(
        task.id,
        onDisk
          ? {
              status: onDisk.status as SchedulerTaskStatus,
              lastReason: onDisk.lastReason ?? undefined,
            }
          : undefined,
      );
    }
    if (task.status === "failed" && isSetupFailureReason(task.lastReason)) {
      const branchName = `pi-implement/${runId}/${task.id}`;
      const worktreePath = deps.paths
        ? join(deps.paths.worktreesDir, task.id)
        : undefined;
      const taskJson = deps.paths
        ? readTaskJson(deps.paths, task.id)
        : undefined;
      const taskBaseSha = taskJson?.baseSha ?? head;
      setupBlockers.set(task.id, {
        branchExists: branches.some((b) => b === branchName),
        worktreeExists: worktreePath
          ? worktrees.some((wt) => wt === worktreePath)
          : false,
        aheadOfBase: branches.some((b) => b === branchName)
          ? await deps.git.aheadOfBase(branchName, taskBaseSha)
          : false,
      });
    }
  }

  return {
    head,
    planArtifactSnapshot,
    gitStatusText,
    wasClean,
    branches,
    worktrees,
    taskStates,
    taskJsonStates,
    setupBlockers,
  };
}

export async function checkSchedulerSelfHealProgress(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  planArtifacts: string[],
  baseline: SchedulerSelfHealBaseline,
  healResult: SchedulerSelfHealResult,
): Promise<{ hasProgress: boolean; revivedTaskIds: string[] }> {
  const revivedTaskIds: string[] = [];

  if (!healResult.retryScheduler) {
    return { hasProgress: false, revivedTaskIds };
  }

  if (baseline.setupBlockers.size > 0 && !deps.paths) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Re-read durable run/lock state to verify self-heal did not corrupt
  // or switch run.json / graph.json / lock to a different run id.
  if (deps.paths && !durableRunStateMatches(deps.paths, deps.runId ?? "run")) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Post-heal safety checks
  const currentHead = await deps.git.head();
  if (currentHead !== baseline.head) {
    return { hasProgress: false, revivedTaskIds };
  }

  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    baseline.planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Task state integrity: in-memory status/lastReason must match baseline.
  // The self-heal agent must not mutate orchestrator task state.
  for (const [taskId, preState] of baseline.taskStates) {
    const task = sched.tasks.get(taskId);
    if (!task) {
      continue;
    }
    if (
      task.status !== preState.status ||
      task.lastReason !== preState.lastReason
    ) {
      return { hasProgress: false, revivedTaskIds };
    }
  }

  // On-disk task JSON integrity: the self-heal agent must not write task.json
  // to mark tasks landed or alter their durable state.
  if (deps.paths) {
    for (const [taskId, preDiskState] of baseline.taskJsonStates) {
      const onDisk = readTaskJson(deps.paths, taskId);
      const currentDiskState = onDisk
        ? { status: onDisk.status, lastReason: onDisk.lastReason ?? undefined }
        : undefined;
      const pre = preDiskState ?? undefined;
      if (
        currentDiskState?.status !== pre?.status ||
        currentDiskState?.lastReason !== pre?.lastReason
      ) {
        return { hasProgress: false, revivedTaskIds };
      }
    }
  }

  const isDependencyInstall =
    indicatesSchedulerDependencyInstallation(healResult);
  const { staged, unstaged, untracked } = await collectChangedPaths(deps);
  if (hasNonPlanChangedPath(staged, planArtifacts, deps.planPath)) {
    return { hasProgress: false, revivedTaskIds };
  }
  if (hasNonPlanChangedPath(unstaged, planArtifacts, deps.planPath)) {
    return { hasProgress: false, revivedTaskIds };
  }
  if (hasNonPlanChangedPath(untracked, planArtifacts, deps.planPath)) {
    return { hasProgress: false, revivedTaskIds };
  }

  const runId = deps.runId ?? "run";
  const currentBranches = await deps.git.listBranchesMatching(
    `pi-implement/${runId}/*`,
  );
  const currentWorktrees = await deps.git.listWorktrees();
  const currentClean = await deps.git.isCleanExcept(planArtifacts);

  if (isDependencyInstall && !currentClean) {
    return { hasProgress: false, revivedTaskIds };
  }

  // Observable progress: stale branch/worktree removed for a setup-blocked task
  for (const [taskId, preBlocker] of baseline.setupBlockers) {
    const task = sched.tasks.get(taskId);
    if (!task) {
      continue;
    }
    if (task.status !== "failed" || !isSetupFailureReason(task.lastReason)) {
      continue;
    }
    const depsLanded = task.dependsOn.every((depId) => {
      const dep = sched.tasks.get(depId);
      return dep?.status === "landed";
    });
    if (!depsLanded) {
      continue;
    }
    if (preBlocker.aheadOfBase) {
      continue;
    }

    const branchName = `pi-implement/${runId}/${taskId}`;
    const worktreePath = deps.paths
      ? join(deps.paths.worktreesDir, taskId)
      : undefined;

    const branchStillExists = currentBranches.some((b) => b === branchName);
    const worktreeStillExists = worktreePath
      ? currentWorktrees.some((wt) => wt === worktreePath)
      : false;

    const branchRemoved = preBlocker.branchExists && !branchStillExists;
    const worktreeRemoved = preBlocker.worktreeExists && !worktreeStillExists;

    if (branchRemoved || worktreeRemoved) {
      const repairNamesTask =
        (healResult.summary?.includes(taskId) ?? false) ||
        (healResult.commands?.some(
          (cmd) =>
            cmd.includes(branchName) ||
            (worktreePath ? cmd.includes(worktreePath) : false),
        ) ??
          false);

      if (repairNamesTask) {
        revivedTaskIds.push(taskId);
      }
    }
  }

  if (revivedTaskIds.length > 0) {
    return { hasProgress: true, revivedTaskIds };
  }

  // Observable progress: interrupted/dirty scheduler state was cleared
  if (!baseline.wasClean && currentClean) {
    return { hasProgress: true, revivedTaskIds };
  }

  // Observable progress: dependency installation with clean/ignored git status
  if (isDependencyInstall && currentClean) {
    return { hasProgress: true, revivedTaskIds };
  }

  return { hasProgress: false, revivedTaskIds };
}

function durableRunStateMatches(paths: StatePaths, runId: string): boolean {
  const currentRunJson = readRunJson(paths);
  const currentGraphJson = readGraphJson(paths.runDir);
  if (currentRunJson?.runId !== runId || currentGraphJson?.runId !== runId) {
    return false;
  }
  if (!existsSync(paths.lockFile)) {
    return false;
  }
  try {
    const lock = JSON.parse(readFileSync(paths.lockFile, "utf-8")) as {
      runId?: string;
    };
    return lock.runId === runId;
  } catch {
    return false;
  }
}

function hasNonPlanChangedPath(
  paths: string[],
  planArtifacts: string[],
  planPath: string,
): boolean {
  return paths.some(
    (path) => !isPlanArtifactPath(path, planArtifacts, planPath),
  );
}

function isPlanArtifactPath(
  path: string,
  planArtifacts: string[],
  planPath: string,
): boolean {
  const normalized = normalizeStatusPath(path);
  return planArtifacts.some((artifact) => {
    const normalizedArtifact = normalizeStatusPath(artifact);
    if (normalized === normalizedArtifact) {
      return true;
    }
    if (!isAbsolute(artifact)) {
      return false;
    }
    const relativeArtifact = normalizeStatusPath(
      relative(dirname(planPath), artifact),
    );
    return normalized === relativeArtifact;
  });
}

function normalizeStatusPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSetupFailureReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  const setupPatterns = [
    /Worktree setup failed/i,
    /branch .* already exists/i,
    /worktree .* already exists/i,
    /interrupted git operation/i,
  ];
  return setupPatterns.some((p) => p.test(reason));
}

function reviveTaskForSchedulerRetry(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
): void {
  const task = sched.tasks.get(taskId);
  if (!task) {
    return;
  }
  task.status = "needs_rework";
  task.activeAgentIds = [];
  task.activeAgentRefs = [];
  task.lastReason = "self-heal repaired setup blocker; retrying";
  if (deps.paths) {
    const existing = readTaskJson(deps.paths, taskId);
    writeTaskJson(deps.paths, taskId, {
      ...buildTaskJsonSnapshot(existing, task),
      status: "needs_rework",
      activeSubagentIds: [],
      lastReason: task.lastReason,
    });
    appendEvent(deps.paths, {
      type: "task_self_heal_requeued",
      taskId,
      reason: task.lastReason,
    });
  }
}

export function buildSchedulerGraphSummary(
  sched: SchedulerRun,
  graph: ImplementGraph,
): string {
  const lines: string[] = [
    `Run ID: ${graph.runId}`,
    `Base SHA: ${graph.baseSha}`,
    `Plan: ${graph.planPath}`,
    `Nodes (${graph.nodes.length}):`,
  ];
  for (const node of graph.nodes) {
    const task = sched.tasks.get(node.id);
    const deps =
      node.dependsOn.length > 0
        ? ` dependsOn: [${node.dependsOn.join(", ")}]`
        : "";
    lines.push(
      `- ${node.id}: ${node.title} (plan ${node.planIndex}, mode: ${node.mode}, status: ${task?.status ?? "pending"}${deps})`,
    );
    if (task?.lastReason) {
      lines.push(`  lastReason: ${task.lastReason}`);
    }
    if (task?.taskCommitSha) {
      lines.push(`  taskCommitSha: ${task.taskCommitSha}`);
    }
    if (task?.landedCommitSha) {
      lines.push(`  landedCommitSha: ${task.landedCommitSha}`);
    }
    if (task?.worktreePath) {
      lines.push(`  worktree: ${task.worktreePath}`);
    }
    if (task?.branchName) {
      lines.push(`  branch: ${task.branchName}`);
    }
    if (task?.activeAgentIds && task.activeAgentIds.length > 0) {
      lines.push(`  activeAgents: [${task.activeAgentIds.join(", ")}]`);
    } else {
      lines.push(`  activeAgents: (none)`);
    }
  }
  return lines.join("\n");
}

async function collectChangedPaths(deps: OrchestratorDeps): Promise<{
  staged: string[];
  unstaged: string[];
  untracked: string[];
}> {
  const status = await deps.git.status();
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of status.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    let path = rest;
    if (rest.includes(" -> ")) {
      path = rest.split(" -> ").pop()!;
    }
    path = path.trim();

    if (xy[0] !== " " && xy[0] !== "?") {
      staged.push(path);
    }
    if (xy === "??") {
      untracked.push(path);
    } else if (xy[1] !== " ") {
      unstaged.push(path);
    }
  }

  return { staged, unstaged, untracked };
}

function parseNameStatusPaths(nameStatus: string): string[] {
  const paths: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split("\t");
    if (parts.length >= 2) {
      paths.push(parts[parts.length - 1]!);
    }
  }
  return paths;
}

function isPackageManagerFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".npmrc",
  ].includes(name);
}

function indicatesDependencyInstallation(
  result: IntegrationSelfHealResult | undefined,
): boolean {
  if (!result?.commands) {
    return false;
  }
  const installPattern = /^(npm|pnpm|yarn)\s+(install|ci|add)/;
  return result.commands.some((cmd) => installPattern.test(cmd.trim()));
}

function indicatesSchedulerDependencyInstallation(
  result: SchedulerSelfHealResult | undefined,
): boolean {
  if (!result?.commands) {
    return false;
  }
  const installPattern = /^(npm|pnpm|yarn)\s+(install|ci|add)/;
  return result.commands.some((cmd) => installPattern.test(cmd.trim()));
}

function getLandedTasks(
  paths: StatePaths,
): Array<{ id: string; title: string; commitSha?: string }> {
  const events = readEvents(paths);
  const landedEvents = events.filter((e) => e.type === "task_landed");
  const seen = new Set<string>();
  const landedTasks: Array<{
    id: string;
    title: string;
    commitSha?: string;
  }> = [];
  for (const ev of landedEvents) {
    if (seen.has(ev.taskId)) {
      continue;
    }
    seen.add(ev.taskId);
    const taskJson = readTaskJson(paths, ev.taskId);
    if (taskJson) {
      landedTasks.push({
        id: taskJson.id,
        title: taskJson.title,
        commitSha: taskJson.landedCommitSha,
      });
    }
  }
  return landedTasks;
}

function buildGraphContext(runDir: string): string | undefined {
  const graph = readGraphJson(runDir);
  if (!graph) {
    return undefined;
  }
  const lines = [
    `Run ID: ${graph.runId}`,
    `Base SHA: ${graph.baseSha}`,
    `Plan: ${graph.planPath}`,
    `Nodes (${graph.nodes.length}):`,
  ];
  for (const node of graph.nodes) {
    const deps =
      node.dependsOn.length > 0
        ? ` dependsOn: [${node.dependsOn.join(", ")}]`
        : "";
    lines.push(
      `- ${node.id}: ${node.title} (plan ${node.planIndex}, mode: ${node.mode}${deps})`,
    );
  }
  return lines.join("\n");
}

function collectRunArtifactPaths(
  paths: StatePaths,
  taskId: string,
): string[] | undefined {
  const artifactPaths: string[] = [];
  try {
    if (existsSync(paths.eventsJsonl)) {
      artifactPaths.push(paths.eventsJsonl);
    }
    if (existsSync(paths.runJson)) {
      artifactPaths.push(paths.runJson);
    }
    const graphPath = join(paths.runDir, "graph.json");
    if (existsSync(graphPath)) {
      artifactPaths.push(graphPath);
    }
    const taskDir = join(paths.tasksDir, taskId);
    if (existsSync(taskDir)) {
      for (const entry of readdirSync(taskDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          artifactPaths.push(join(taskDir, entry.name));
        }
      }
    }
  } catch {
    return undefined;
  }
  return artifactPaths.length > 0 ? artifactPaths : undefined;
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

async function validateIntegratedTask(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
  schedulerTask?: SchedulerTask,
): Promise<ValidationResult> {
  const commands = await resolveValidationCommands(deps);
  if (commands.length > 0) {
    for (const command of commands) {
      const result = await runValidationCommand(command, await deps.git.root());
      if (deps.paths) {
        persistTaskArtifact(
          deps.paths,
          taskId,
          `integration-${safeArtifactName(command.label)}.log`,
          `${command.display}\n\nexitCode: ${result.exitCode}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}\n`,
        );
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: `${command.display} failed\n\n${result.stderr || result.stdout}`,
        };
      }
    }
    return { ok: true };
  }

  deps.updateState({
    lastReason:
      "parallel run with LLM-only verification — recommend setting verifyCommand",
  });
  const verdict = await runIntegrationReviewFallback(
    deps,
    taskId,
    planArtifacts,
    schedulerTask,
  );
  if (!verdict.ok) {
    return verdict;
  }
  return { ok: true };
}

async function validateFinalParallelRun(
  deps: OrchestratorDeps,
): Promise<ValidationResult> {
  const commands = await resolveValidationCommands(deps);
  for (const command of commands) {
    const result = await runValidationCommand(command, await deps.git.root());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: `Final validation failed: ${command.display}\n\n${result.stderr || result.stdout}`,
      };
    }
  }
  return { ok: true };
}

type ValidationCommand =
  | { kind: "shell"; label: string; display: string; command: string }
  | {
      kind: "exec";
      label: string;
      display: string;
      file: string;
      args: string[];
    };

async function resolveValidationCommands(
  deps: OrchestratorDeps,
): Promise<ValidationCommand[]> {
  if (deps.verifyCommand) {
    return [
      {
        kind: "shell",
        label: "verifyCommand",
        display: deps.verifyCommand,
        command: deps.verifyCommand,
      },
    ];
  }

  const root = await deps.git.root();
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }

  const packageManager = detectPackageManager(root);
  const commands: ValidationCommand[] = [];
  for (const script of ["test", "typecheck", "build"]) {
    if (typeof scripts[script] !== "string") {
      continue;
    }
    commands.push({
      kind: "exec",
      label: script,
      display: `${packageManager.display} ${script}`,
      file: packageManager.file,
      args: [...packageManager.argsPrefix, script],
    });
  }
  return commands;
}

function detectPackageManager(root: string): {
  file: string;
  argsPrefix: string[];
  display: string;
} {
  if (existsSync(join(root, "pnpm-lock.yaml"))) {
    return { file: "pnpm", argsPrefix: [], display: "pnpm" };
  }
  if (existsSync(join(root, "yarn.lock"))) {
    return { file: "yarn", argsPrefix: [], display: "yarn" };
  }
  return { file: "npm", argsPrefix: ["run"], display: "npm run" };
}

async function runValidationCommand(
  command: ValidationCommand,
  cwd: string,
): Promise<CommandResult> {
  try {
    if (command.kind === "shell") {
      const result = await execAsync(command.command, {
        cwd,
        env: process.env,
        timeout: VALIDATION_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        command: command.display,
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    const result = await execFileAsync(command.file, command.args, {
      cwd,
      env: process.env,
      timeout: VALIDATION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      command: command.display,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    const failed = err as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      signal?: string;
    };
    return {
      command: command.display,
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.signal
        ? `${failed.stderr ?? ""}\nTerminated by signal ${failed.signal}`
        : (failed.stderr ?? failed.message),
    };
  }
}

async function runIntegrationReviewFallback(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
  schedulerTask?: SchedulerTask,
): Promise<ValidationResult> {
  const diff = await deps.git.stagedDiff();
  const prompt = `Review this integrated parallel task diff on the main checkout.

No command validation is configured or auto-detected. Decide whether the integrated diff is safe to commit.

Do not edit files, stage, reset, commit, checkout, merge, rebase, clean, install dependencies, or run any command that changes files or git state. Use read-only commands only.

Plan artifacts are not part of the implementation commit and should be ignored: ${planArtifacts.join(", ")}

## Staged Diff

\`\`\`diff
${diff}
\`\`\`

End with exactly one tagged JSON result:
<pi-integration-review-result>{"verdict":"approved"}</pi-integration-review-result>

Or:
<pi-integration-review-result>{"verdict":"changes_requested","requiredChanges":["..."],"reason":"..."}</pi-integration-review-result>`;

  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: `integration review ${taskId}`,
    model: deps.roles.reviewer.model,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: `Reviewer · Integration review · ${taskId}`,
    startedAt: new Date().toISOString(),
  };
  setSchedulerActiveAgent(schedulerTask, ref);
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    clearSchedulerActiveAgent(schedulerTask, id);
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });
  if (result.status !== "completed") {
    return {
      ok: false,
      reason: `Integration review ${result.status}: ${result.error}`,
    };
  }
  if (deps.paths) {
    persistTaskArtifact(
      deps.paths,
      taskId,
      "integration-review.md",
      result.result,
    );
  }
  const verdict = parseIntegrationReviewVerdict(result.result);
  if (verdict.ok) {
    return { ok: true };
  }
  return { ok: false, reason: verdict.reason };
}

function parseIntegrationReviewVerdict(
  text: string,
): { ok: true } | { ok: false; reason: string } {
  const match = text.match(
    /<pi-integration-review-result>([\s\S]*?)<\/pi-integration-review-result>/,
  );
  if (!match?.[1]) {
    return { ok: false, reason: "Integration review result tag missing" };
  }
  try {
    const parsed = JSON.parse(match[1]) as {
      verdict?: unknown;
      requiredChanges?: unknown;
      reason?: unknown;
    };
    if (parsed.verdict === "approved") {
      return { ok: true };
    }
    const requiredChanges = Array.isArray(parsed.requiredChanges)
      ? parsed.requiredChanges.filter((v): v is string => typeof v === "string")
      : [];
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : requiredChanges.join("\n");
    return {
      ok: false,
      reason: reason || "Integration review requested changes",
    };
  } catch (err) {
    return {
      ok: false,
      reason: `Integration review JSON invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function nextOverallReviewArtifactPath(planPath: string): string {
  const base = planPath.replace(/\.md$/i, ".overall-review.md");
  if (!existsSync(base)) {
    return base;
  }
  let suffix = 2;
  for (;;) {
    const candidate = base.replace(/\.md$/i, `-${suffix}.md`);
    if (!existsSync(candidate)) {
      return candidate;
    }
    suffix++;
  }
}

type OverallReviewOutcome =
  | { verdict: "approved" }
  | {
      verdict: "changes_requested";
      requiredChanges: string[];
      recommendationMarkdown?: string;
      rawResult: string;
    };

async function runOverallReviewOnce(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  baseSha: string,
): Promise<OverallReviewOutcome> {
  throwIfStopped(deps);

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree before final review");
  }

  const planContent = readFileSync(deps.planPath, "utf-8");
  const headSha = await deps.git.head();

  let bundleMaterial: string | undefined;
  if (deps.manifest) {
    bundleMaterial = formatBundleMaterial(deps.manifest);
  }

  if (baseSha === headSha) {
    return { verdict: "approved" };
  }

  const diff = await deps.git.diffRange(baseSha, headSha);

  const landedTasks: Array<{ id: string; title: string; commitSha?: string }> =
    [];
  if (deps.paths) {
    const events = readEvents(deps.paths);
    const landedEvents = events.filter((e) => e.type === "task_landed");
    const seen = new Set<string>();
    for (const ev of landedEvents) {
      if (seen.has(ev.taskId)) {
        continue;
      }
      seen.add(ev.taskId);
      const taskJson = readTaskJson(deps.paths, ev.taskId);
      if (taskJson) {
        landedTasks.push({
          id: taskJson.id,
          title: taskJson.title,
          commitSha: taskJson.landedCommitSha,
        });
      }
    }
  }

  const prompt = buildOverallReviewerPrompt({
    planContent,
    planPath: deps.planPath,
    baseSha,
    headSha,
    diff,
    runId: deps.runId,
    landedTasks,
    bundleMaterial,
  });

  deps.updateState({ phase: "final_review", activeSubagentId: undefined });

  const preReviewHead = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
  const stagedFingerprint = await deps.git.stagedFingerprint();
  const worktreeFingerprint =
    await deps.git.worktreeFingerprintExcept(planArtifacts);

  const id = await deps.subagents.spawn({
    type: deps.roles.reviewer.type,
    prompt,
    description: "overall review",
    model: deps.roles.reviewer.model,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "reviewer",
    label: "Reviewer · Overall review",
    startedAt: new Date().toISOString(),
  };
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });

  if (result.status !== "completed") {
    throw new BlockedError(`Overall review ${result.status}: ${result.error}`);
  }

  // Boundary checks
  if ((await deps.git.head()) !== preReviewHead) {
    throw new BlockedError("overall reviewer changed HEAD");
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    throw new BlockedError(
      `overall reviewer changed a plan artifact: ${changedPlanArtifact}`,
    );
  }
  const stagedFingerprintAfter = await deps.git.stagedFingerprint();
  if (stagedFingerprintAfter !== stagedFingerprint) {
    throw new BlockedError("overall reviewer changed staged state");
  }
  const worktreeFingerprintAfter =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  if (worktreeFingerprintAfter !== worktreeFingerprint) {
    throw new BlockedError("overall reviewer changed worktree state");
  }

  const verdict = parseOverallReviewVerdict(result.result);
  if (verdict.verdict === "approved") {
    return { verdict: "approved" };
  }

  return {
    verdict: "changes_requested",
    requiredChanges: verdict.requiredChanges,
    recommendationMarkdown: verdict.recommendationMarkdown,
    rawResult: result.result,
  };
}

type OverallReworkAttemptResult =
  | { ok: true; commitSha: string }
  | { ok: false; reason: string; blocking: boolean };

async function resetOverallRework(
  deps: OrchestratorDeps,
  preAttemptHead: string,
  planArtifacts: string[],
  planArtifactSnapshot: Map<string, string | undefined>,
): Promise<void> {
  await deps.git.resetHard(preAttemptHead).catch(() => undefined);
  await deps.git
    .restoreWorktreeFromIndexExcept(planArtifacts)
    .catch(() => undefined);
  restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
}

async function runOverallReworkAttempt(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
  review: Extract<OverallReviewOutcome, { verdict: "changes_requested" }>,
  attemptNumber: number,
  priorAttemptFailures: string[],
): Promise<OverallReworkAttemptResult> {
  throwIfStopped(deps);

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    return {
      ok: false,
      reason: "dirty worktree before overall rework",
      blocking: true,
    };
  }

  const preAttemptHead = await deps.git.head();
  const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);

  const headSha = await deps.git.head();
  const diff = await deps.git.diffRange(runBaseSha, headSha);

  const landedTasks: Array<{ id: string; title: string; commitSha?: string }> =
    [];
  if (deps.paths) {
    const events = readEvents(deps.paths);
    const landedEvents = events.filter((e) => e.type === "task_landed");
    const seen = new Set<string>();
    for (const ev of landedEvents) {
      if (seen.has(ev.taskId)) {
        continue;
      }
      seen.add(ev.taskId);
      const taskJson = readTaskJson(deps.paths, ev.taskId);
      if (taskJson) {
        landedTasks.push({
          id: taskJson.id,
          title: taskJson.title,
          commitSha: taskJson.landedCommitSha,
        });
      }
    }
  }

  let bundleMaterial: string | undefined;
  if (deps.manifest) {
    bundleMaterial = formatBundleMaterial(deps.manifest);
  }

  const prompt = buildOverallReworkPrompt({
    planContent: readFileSync(deps.planPath, "utf-8"),
    planPath: deps.planPath,
    baseSha: runBaseSha,
    headSha,
    diff,
    runId: deps.runId,
    landedTasks,
    bundleMaterial,
    requiredChanges: review.requiredChanges,
    recommendationMarkdown: review.recommendationMarkdown,
    priorAttemptFailures,
  });

  deps.updateState({ phase: "final_rework", activeSubagentId: undefined });

  if (deps.paths) {
    const artifactDir = join(deps.paths.runDir, "overall-review");
    mkdirSync(artifactDir, { recursive: true });
    const promptPath = join(artifactDir, `rework-prompt-${attemptNumber}.md`);
    writeFileSync(promptPath, prompt, "utf-8");
    appendEvent(deps.paths, {
      type: "overall_rework_started",
      attempt: attemptNumber,
      artifactPath: promptPath,
    });
  }

  deps.updateState((prev) =>
    checkpointPatch(prev, `Overall rework started (attempt ${attemptNumber})`),
  );

  const id = await deps.subagents.spawn({
    type: deps.roles.implementer.type,
    prompt,
    description: `overall rework attempt ${attemptNumber}`,
    model: deps.roles.implementer.model,
  });
  const ref: AgentDisplayRef = {
    id,
    role: "implementer",
    label: `Overall rework · attempt ${attemptNumber}`,
    startedAt: new Date().toISOString(),
  };
  deps.updateState((prev) => addActiveAgentPatch(prev, ref));
  const result = await deps.subagents.waitFor(id, deps.signal).finally(() => {
    deps.updateState((prev) => removeActiveAgentPatch(prev, id));
  });

  // Stopped
  if (result.status === "stopped") {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    throw new StoppedError();
  }

  // Persist result when paths exist
  if (deps.paths && result.status === "completed") {
    const artifactDir = join(deps.paths.runDir, "overall-review");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, `rework-result-${attemptNumber}.md`),
      result.result,
      "utf-8",
    );
  }

  // Failed subagent
  if (result.status !== "completed") {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: result.error,
      });
    }
    return {
      ok: false,
      reason: `Implementer subagent failed: ${result.error}`,
      blocking: false,
    };
  }

  // Boundary checks
  if ((await deps.git.head()) !== preAttemptHead) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "overall rework implementer changed HEAD",
      blocking: true,
    };
  }
  const changedPlanArtifact = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifact) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: `overall rework implementer changed a plan artifact: ${changedPlanArtifact}`,
      blocking: true,
    };
  }

  // Parse result
  const parsed = parseOverallReworkResult(result.result);
  if (!parsed.ok) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: parsed.reason,
      });
    }
    return {
      ok: false,
      reason: `Invalid rework result: ${parsed.reason}`,
      blocking: false,
    };
  }

  // Stage all except plan artifacts
  await deps.git.stageAllExcept(planArtifacts);
  const hasStaged = await deps.git.hasStagedChanges();

  if (!hasStaged) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: "reworker produced no staged changes",
      });
    }
    return {
      ok: false,
      reason: "Overall reworker produced no staged changes",
      blocking: false,
    };
  }

  const stagedAfter = await deps.git.stagedFingerprint();
  const worktreeAfter = await deps.git.worktreeFingerprintExcept(planArtifacts);

  // Validation
  const validationCommands = await resolveValidationCommands(deps);
  const validationLogs: string[] = [];
  let validationFailureReason: string | undefined;
  if (validationCommands.length > 0) {
    for (const command of validationCommands) {
      const validationResult = await runValidationCommand(
        command,
        await deps.git.root(),
      );
      const log = `${command.display}\n\nexitCode: ${validationResult.exitCode}\n\nSTDOUT\n${validationResult.stdout}\n\nSTDERR\n${validationResult.stderr}\n`;
      validationLogs.push(log);
      if (deps.paths) {
        const artifactDir = join(deps.paths.runDir, "overall-review");
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(
          join(
            artifactDir,
            `rework-validation-${attemptNumber}-${safeArtifactName(command.label)}.log`,
          ),
          log,
          "utf-8",
        );
      }
      if (validationResult.exitCode !== 0) {
        validationFailureReason = `Validation failed: ${command.display}\n\n${validationResult.stderr || validationResult.stdout}`;
        break;
      }
    }
  }

  // Validation mutation detection — always run, even when validation failed
  const postValidationHead = await deps.git.head();
  const postValidationStaged = await deps.git.stagedFingerprint();
  const postValidationWorktree =
    await deps.git.worktreeFingerprintExcept(planArtifacts);
  const changedPlanArtifactAfterValidation = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );

  if (postValidationHead !== preAttemptHead) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Validation changed HEAD during overall rework",
      blocking: true,
    };
  }
  if (changedPlanArtifactAfterValidation) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: `Validation changed a plan artifact during overall rework: ${changedPlanArtifactAfterValidation}`,
      blocking: true,
    };
  }
  if (postValidationStaged !== stagedAfter) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Validation changed staged state during overall rework",
      blocking: true,
    };
  }
  if (postValidationWorktree !== worktreeAfter) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Validation changed worktree state during overall rework",
      blocking: true,
    };
  }

  if (validationFailureReason) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: validationFailureReason,
      });
    }
    return {
      ok: false,
      reason: validationFailureReason,
      blocking: false,
    };
  }

  // Commit
  const commitMessage = isValidCommitMessage(parsed.result.commitMessage ?? "")
    ? parsed.result.commitMessage!
    : "fix: address overall review";

  const commit = await deps.git.commit(commitMessage);
  if (commit.exitCode !== 0) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_rework_failed",
        attempt: attemptNumber,
        reason: `commit-hook failure: ${commit.stderr || commit.stdout}`,
      });
    }
    return {
      ok: false,
      reason: `Commit hook failed: ${commit.stderr || commit.stdout}`,
      blocking: false,
    };
  }

  const postCommitHead = await deps.git.head();
  if (postCommitHead === preAttemptHead) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Commit succeeded but HEAD did not advance",
      blocking: false,
    };
  }

  const changedPlanArtifactAfterCommit = changedSnapshotPath(
    planArtifacts,
    planArtifactSnapshot,
  );
  if (changedPlanArtifactAfterCommit) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: `Commit hook changed a plan artifact during overall rework: ${changedPlanArtifactAfterCommit}`,
      blocking: true,
    };
  }

  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    await resetOverallRework(
      deps,
      preAttemptHead,
      planArtifacts,
      planArtifactSnapshot,
    );
    return {
      ok: false,
      reason: "Commit succeeded but checkout is dirty after overall rework",
      blocking: false,
    };
  }

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "overall_rework_committed",
      attempt: attemptNumber,
      commitSha: postCommitHead,
    });
  }

  deps.updateState((prev) =>
    checkpointPatch(
      prev,
      `Overall rework committed (attempt ${attemptNumber}) @ ${postCommitHead.slice(0, 7)}`,
    ),
  );

  return { ok: true, commitSha: postCommitHead };
}

function buildOverallReviewArtifactContent(
  deps: OrchestratorDeps,
  baseSha: string,
  headSha: string,
  lastReview: Extract<OverallReviewOutcome, { verdict: "changes_requested" }>,
  reworkFailures: string[],
): string {
  const recommendation =
    lastReview.recommendationMarkdown ??
    `## Required Changes\n\n${lastReview.requiredChanges.map((c) => `- ${c}`).join("\n")}`;

  const reworkSection =
    reworkFailures.length > 0
      ? `\n## Rework Attempts\n\n${reworkFailures.map((f, i) => `- Attempt ${i + 1}: ${f}`).join("\n")}\n`
      : "";

  return `# Overall Review: Changes Requested

## Verdict

changes_requested

## Required Changes

${lastReview.requiredChanges.map((c) => `- ${c}`).join("\n")}

## Recommendation

${recommendation}

## Context

- Plan: ${deps.planPath}
- Base SHA: ${baseSha}
- Head SHA: ${headSha}
${deps.runId ? `- Run ID: ${deps.runId}\n` : ""}${reworkSection}
## Raw Result

${lastReview.rawResult}
`;
}

async function runOverallReviewLoop(
  deps: OrchestratorDeps,
  plan: ReturnType<typeof parsePlanFile>,
  planArtifacts: string[],
  runBaseSha: string,
): Promise<void> {
  const reworkFailures: string[] = [];

  const initialReview = await runOverallReviewOnce(
    deps,
    plan,
    planArtifacts,
    runBaseSha,
  );

  if (initialReview.verdict === "approved") {
    deps.updateState((prev) =>
      checkpointPatch(prev, "Final overall review approved"),
    );
    if (deps.paths) {
      appendEvent(deps.paths, { type: "overall_review_approved" });
    }
    return;
  }

  let lastReview: Extract<
    OverallReviewOutcome,
    { verdict: "changes_requested" }
  > = initialReview;

  if (deps.paths) {
    appendEvent(deps.paths, {
      type: "overall_review_changes_requested",
      requiredChanges: initialReview.requiredChanges,
    });
  }

  deps.updateState((prev) =>
    checkpointPatch(
      prev,
      `Overall review changes requested: ${initialReview.requiredChanges.join("; ")}`,
    ),
  );

  for (let attempt = 1; attempt <= MAX_OVERALL_REWORK_ATTEMPTS; attempt++) {
    const rework = await runOverallReworkAttempt(
      deps,
      plan,
      planArtifacts,
      runBaseSha,
      lastReview,
      attempt,
      reworkFailures,
    );

    if (!rework.ok) {
      if (rework.blocking) {
        throw new BlockedError(rework.reason);
      }
      reworkFailures.push(rework.reason);
      continue;
    }

    // Re-run overall review only after a successful rework commit
    const review = await runOverallReviewOnce(
      deps,
      plan,
      planArtifacts,
      runBaseSha,
    );

    if (review.verdict === "approved") {
      deps.updateState((prev) =>
        checkpointPatch(prev, "Final overall review approved"),
      );
      if (deps.paths) {
        appendEvent(deps.paths, { type: "overall_review_approved" });
      }
      return;
    }

    lastReview = review;

    if (deps.paths) {
      appendEvent(deps.paths, {
        type: "overall_review_changes_requested",
        requiredChanges: review.requiredChanges,
      });
    }

    deps.updateState((prev) =>
      checkpointPatch(
        prev,
        `Overall review changes requested: ${review.requiredChanges.join("; ")}`,
      ),
    );
  }

  const headSha = await deps.git.head();
  const artifactPath = nextOverallReviewArtifactPath(deps.planPath);
  const artifactContent = buildOverallReviewArtifactContent(
    deps,
    runBaseSha,
    headSha,
    lastReview,
    reworkFailures,
  );
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, artifactContent, "utf-8");

  const latestFailure = reworkFailures.at(-1);
  const message = latestFailure
    ? `Overall review requested changes: ${lastReview.requiredChanges.join("; ")}. Latest rework failure: ${latestFailure}`
    : `Overall review requested changes: ${lastReview.requiredChanges.join("; ")}`;
  throw new OverallReviewFollowupError(artifactPath, message);
}

function safeArtifactName(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") ||
    "validation"
  );
}

export function stalledSchedulerReason(
  sched: SchedulerRun,
  schedulerSelfHealAttempted = false,
  remainingBlocker?: string,
): string {
  const lines: string[] = [];
  lines.push("Parallel scheduler blocked:");

  const allTasks = [...sched.tasks.values()].sort(
    (a, b) => a.planIndex - b.planIndex,
  );

  for (const task of allTasks) {
    if (task.status === "landed") {
      continue;
    }

    if (
      task.status === "failed" ||
      task.status === "blocked" ||
      task.status === "stopped" ||
      task.status === "integration_failed"
    ) {
      const reason = task.lastReason ? `: ${task.lastReason}` : "";
      lines.push(`- ${task.id}: ${task.status}${reason}`);
      continue;
    }

    if (task.status === "approved") {
      const earlierNonLanded = allTasks
        .filter((t) => t.planIndex < task.planIndex && t.status !== "landed")
        .map((t) => `${t.id}:${t.status}`);
      if (earlierNonLanded.length > 0) {
        lines.push(
          `- ${task.id}: approved but cannot land until earlier tasks land: ${earlierNonLanded.join(", ")}`,
        );
      } else {
        lines.push(`- ${task.id}: approved`);
      }
      continue;
    }

    const blockedReason = getBlockedReason(task, sched);
    if (blockedReason) {
      lines.push(`- ${task.id}: ${task.status}, ${blockedReason}`);
    } else {
      lines.push(`- ${task.id}: ${task.status}`);
    }
  }

  if (schedulerSelfHealAttempted) {
    const healLine = remainingBlocker
      ? `Self-heal attempted but did not produce retryable progress; remaining blocker: ${remainingBlocker}`
      : "Self-heal attempted but did not produce retryable progress";
    lines.push(healLine);
  }

  return lines.join("\n");
}

function completedPlanTaskIndex(
  plan: ReturnType<typeof parsePlanFile>,
): number | undefined {
  return plan.tasks.length > 0 ? plan.tasks.length : undefined;
}

function updateParallelState(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
): void {
  const tasks: ParallelTaskState[] = [];
  const activeAgentIds: string[] = [];
  let landedCount = 0;

  for (const task of sched.tasks.values()) {
    if (task.status === "landed") {
      landedCount++;
    }
    const taskMeta = deps.paths ? readTaskJson(deps.paths, task.id) : undefined;
    tasks.push({
      id: task.id,
      planIndex: task.planIndex - 1,
      title: task.title,
      status: task.status as ParallelTaskState["status"],
      blockedReason: getBlockedReason(task, sched),
      worktreePath: task.worktreePath,
      landedCommitSha: task.landedCommitSha,
      activeAgentIds: task.activeAgentIds,
      activeAgentRefs: task.activeAgentRefs,
      scout: taskMeta?.scout,
      review: taskMeta?.review,
    });
    for (const id of task.activeAgentIds) {
      activeAgentIds.push(id);
    }
  }

  const activeAgentRefs = [...sched.tasks.values()].flatMap((task) =>
    task.activeAgentRefs.filter((ref) => activeAgentIds.includes(ref.id)),
  );

  deps.updateState({
    tasks,
    activeSubagentId: activeAgentIds.at(-1),
    activeSubagentIds: activeAgentIds,
    activeAgentRefs,
    landedCount,
    totalCount: sched.tasks.size,
  });
}

function setSchedulerActiveAgent(
  task: SchedulerTask | undefined,
  ref: AgentDisplayRef,
): void {
  if (!task) {
    return;
  }
  task.activeAgentIds = [
    ...task.activeAgentIds.filter((id) => id !== ref.id),
    ref.id,
  ];
  task.activeAgentRefs = [
    ...task.activeAgentRefs.filter((existing) => existing.id !== ref.id),
    ref,
  ];
}

function clearSchedulerActiveAgent(
  task: SchedulerTask | undefined,
  id: string,
): void {
  if (!task) {
    return;
  }
  task.activeAgentIds = task.activeAgentIds.filter(
    (existing) => existing !== id,
  );
  task.activeAgentRefs = task.activeAgentRefs.filter((ref) => ref.id !== id);
}

function addActiveAgentPatch(
  prev: RunState,
  ref: AgentDisplayRef,
): Partial<RunState> {
  return {
    activeSubagentId: ref.id,
    activeSubagentIds: [
      ...(prev.activeSubagentIds ?? []).filter((id) => id !== ref.id),
      ref.id,
    ],
    activeAgentRefs: [
      ...(prev.activeAgentRefs ?? []).filter(
        (existing) => existing.id !== ref.id,
      ),
      ref,
    ],
  };
}

function removeActiveAgentPatch(prev: RunState, id: string): Partial<RunState> {
  const activeSubagentIds = (prev.activeSubagentIds ?? []).filter(
    (existing) => existing !== id,
  );
  return {
    activeSubagentId:
      prev.activeSubagentId === id
        ? activeSubagentIds.at(-1)
        : prev.activeSubagentId,
    activeSubagentIds,
    activeAgentRefs: (prev.activeAgentRefs ?? []).filter(
      (ref) => ref.id !== id,
    ),
  };
}

function taskToJson(task: SchedulerTask): TaskJson {
  return {
    id: task.id,
    planIndex: task.planIndex,
    title: task.title,
    status: task.status as TaskJson["status"],
    dependsOn: task.dependsOn,
    attempts: 0,
    integrationAttempts: task.integrationAttempts,
    baseSha: undefined,
    worktreePath: task.worktreePath,
    branchName: task.branchName,
    taskCommitSha: task.taskCommitSha,
    landedCommitSha: task.landedCommitSha,
    activeSubagentIds: task.activeAgentIds,
    lastReason: task.lastReason,
    commitMessage: task.approvedCommitMessage,
    selfHealAttempts: task.selfHealAttempts,
  };
}

function currentTaskReviewMetadata(
  paths: StatePaths | undefined,
  taskId: string,
): TaskJson["review"] {
  return paths ? readTaskJson(paths, taskId)?.review : undefined;
}

function nextTaskReviewMetadata(
  paths: StatePaths | undefined,
  taskId: string,
  skipReview: boolean,
  skipReason: string | undefined,
): TaskJson["review"] {
  const existingReview = currentTaskReviewMetadata(paths, taskId);
  if (skipReview) {
    return {
      lastDecision: "skipped",
      lastReason: skipReason,
      skippedCount: (existingReview?.skippedCount ?? 0) + 1,
      reviewedCount: existingReview?.reviewedCount,
    };
  }
  return {
    lastDecision: "reviewed",
    skippedCount: existingReview?.skippedCount,
    reviewedCount: (existingReview?.reviewedCount ?? 0) + 1,
  };
}

function buildTaskJsonSnapshot(
  existing: TaskJson | undefined,
  task: SchedulerTask,
): TaskJson {
  return {
    ...taskToJson(task),
    scout: existing?.scout,
    review: existing?.review,
  };
}

// ── Task worker (shared serial + parallel) ─────────────────────────────────

async function getStagedFileSummary(
  taskGit: GitClient,
): Promise<StagedFileSummary> {
  const nameStatus = await taskGit.stagedNameStatus();
  const lines = nameStatus.split("\n").filter((l) => l.trim());
  const diff = await taskGit.stagedDiff();
  return {
    fileCount: lines.length,
    diffChars: diff.length,
    nameStatusLines: lines,
  };
}

async function runReviewSkipValidation(
  deps: OrchestratorDeps,
  taskGit: GitClient,
  taskId: string,
): Promise<
  | { ok: true; commands: string[]; log: string }
  | { ok: false; reason: string; log: string }
> {
  const commands = await resolveValidationCommands(deps);
  if (commands.length === 0) {
    return {
      ok: true,
      commands: [],
      log: "No validation commands configured.",
    };
  }
  const cwd = await taskGit.root();
  const logs: string[] = [];
  for (const command of commands) {
    const result = await runValidationCommand(command, cwd);
    const log = `${command.display}\n\nexitCode: ${result.exitCode}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}\n`;
    logs.push(log);
    if (deps.paths) {
      persistTaskArtifact(
        deps.paths,
        taskId,
        `review-validation-${safeArtifactName(command.label)}-attempt.log`,
        log,
      );
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        reason: `${command.display} failed`,
        log: logs.join("\n---\n"),
      };
    }
  }
  return {
    ok: true,
    commands: commands.map((c) => c.display),
    log: logs.join("\n---\n"),
  };
}

function persistReviewDecisionArtifact(
  paths: StatePaths,
  taskId: string,
  attempt: number,
  decision: TaskReviewDecision,
  plannerDirective: TaskReviewDirective | undefined,
  stagedSummary: StagedFileSummary,
  validation: ValidationEvidence,
  scoutFailed: boolean,
): void {
  const content = `# Review Decision (Attempt ${attempt})

## Decision: ${decision.action}

**Reason:** ${decision.reason}

## Planner Directive
${plannerDirective ? "```json\n" + JSON.stringify(plannerDirective, null, 2) + "\n```" : "None"}

## Staged Changes
- Files: ${stagedSummary.fileCount}
- Diff chars: ${stagedSummary.diffChars}
- Name-status:
${stagedSummary.nameStatusLines.map((l) => `    ${l}`).join("\n")}

## Validation Evidence
\`\`\`json\n${JSON.stringify(validation, null, 2)}\n\`\`\`

## Context
- Scout failed: ${scoutFailed}
`;
  persistTaskArtifact(
    paths,
    taskId,
    `review-decision-attempt-${attempt}.md`,
    content,
  );
}

function persistReviewSkippedArtifact(
  paths: StatePaths,
  taskId: string,
  attempt: number,
  decision: Extract<TaskReviewDecision, { action: "skip" }>,
): void {
  const content = `# Review Skipped (Attempt ${attempt})

## Verdict
Review skipped: ${decision.reason}

## Category
${decision.category}
`;
  persistTaskArtifact(
    paths,
    taskId,
    `review-skipped-attempt-${attempt}.md`,
    content,
  );
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
  schedulerTask?: SchedulerTask;
  runBaseSha?: string;
  plannerDirective?: TaskReviewDirective;
  scoutDirective?: ScoutDirective;
  wasNeedsRework?: boolean;
  initialFeedback?: RetryFeedback;
  attemptOrdinalBase?: number;
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
    schedulerTask,
    runBaseSha,
    plannerDirective,
    scoutDirective,
    wasNeedsRework,
    initialFeedback,
    attemptOrdinalBase,
  } = args;

  let feedback: RetryFeedback | undefined = initialFeedback;
  let priorSummary: string | undefined;
  let attempt = 1;
  let systemFailures = 0;
  let anchoredReviewChangeRequests = 0;
  let priorReviewRequiredChanges: string[] | undefined;
  const existingTaskJson = deps.paths
    ? readTaskJson(deps.paths, taskId)
    : undefined;
  let scoutMeta: TaskJson["scout"] | undefined = existingTaskJson?.scout;

  for (;;) {
    throwIfStopped(deps);
    const mainHeadBefore = await deps.git.head();
    const taskHeadBefore = worktreePath ? await taskGit.head() : undefined;
    const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
    const packet = buildTaskPacket(plan, task, deps.manifest);
    const effectiveWorktreePath = worktreePath ?? (await deps.git.root());

    // ── Scout phase ──
    let scoutContext: string | undefined;
    let scoutFailed = false;
    const totalAttempt = (attemptOrdinalBase ?? 0) + attempt;
    const isRetry =
      totalAttempt > 1 ||
      initialFeedback !== undefined ||
      (wasNeedsRework ?? false);
    if (deps.scout && !deps.shouldStop() && !deps.signal?.aborted) {
      const decision = decideScout({
        config: deps.scout,
        directive: scoutDirective,
        isRetry,
        attemptOrdinal: totalAttempt,
        feedback: feedback ?? initialFeedback,
        taskText: task.text,
        taskPacket: packet.markdown,
      });

      if (!decision.run) {
        scoutMeta = {
          calls: scoutMeta?.calls ?? 0,
          lastStatus: "skipped",
          lastReason: decision.reason,
        };
      }

      if (decision.run) {
        const scoutPrompt = buildScoutPrompt({
          worktreePath: effectiveWorktreePath,
          taskPacket: packet.markdown,
          planArtifacts,
          directive: scoutDirective,
          isRetry,
          feedback: feedback ?? initialFeedback,
        });

        if (deps.paths) {
          persistTaskArtifact(
            deps.paths,
            taskId,
            `scout-prompt-attempt-${totalAttempt}.md`,
            scoutPrompt,
          );
        }

        let scoutId: string | undefined;
        try {
          scoutId = await deps.subagents.spawn({
            type: deps.scout.type,
            prompt: scoutPrompt,
            description: `scout task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
            model: deps.scout.model,
          });
        } catch (spawnErr) {
          const note = buildScoutUnavailableNote(
            spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
          );
          scoutContext = note;
          scoutFailed = true;
          scoutMeta = {
            calls: (scoutMeta?.calls ?? 0) + 1,
            lastStatus: "failed",
            lastReason:
              spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
          };
          if (deps.paths) {
            persistTaskArtifact(
              deps.paths,
              taskId,
              `scout-attempt-${totalAttempt}.md`,
              note,
            );
          }
        }

        if (scoutId) {
          const scoutRef: AgentDisplayRef = {
            id: scoutId,
            role: "scout",
            label: `Task ${task.index}/${plan.tasks.length} scout \u00b7 ${shortTask(task.text)}`,
            startedAt: new Date().toISOString(),
            taskId,
            taskIndex: task.index,
            taskTotal: plan.tasks.length,
            taskTitle: shortTask(task.text),
          };
          setSchedulerActiveAgent(schedulerTask, scoutRef);
          deps.updateState((prev) => addActiveAgentPatch(prev, scoutRef));

          let scoutResult: SubagentResult;
          try {
            const waitPromise = deps.subagents.waitFor(scoutId, deps.signal);
            const timeoutMs = deps.scout.timeoutMs;
            const raced =
              timeoutMs && timeoutMs > 0
                ? Promise.race([
                    waitPromise,
                    new Promise<SubagentResult>((resolve) => {
                      setTimeout(
                        () =>
                          resolve({
                            status: "failed",
                            error: `Scout timed out after ${timeoutMs}ms`,
                          }),
                        timeoutMs,
                      );
                    }),
                  ])
                : waitPromise;
            scoutResult = await raced.finally(() => {
              clearSchedulerActiveAgent(schedulerTask, scoutId);
              deps.updateState((prev) => removeActiveAgentPatch(prev, scoutId));
            });
          } catch (waitErr) {
            clearSchedulerActiveAgent(schedulerTask, scoutId);
            deps.updateState((prev) => removeActiveAgentPatch(prev, scoutId));
            if (waitErr instanceof StoppedError) {
              throw waitErr;
            }
            scoutResult = {
              status: "failed",
              error:
                waitErr instanceof Error ? waitErr.message : String(waitErr),
            };
          }

          if (
            scoutResult.status === "completed" &&
            scoutResult.result.trim().length > 0
          ) {
            scoutContext = formatScoutContext(
              scoutResult.result,
              deps.scout.maxResultChars,
            );
            scoutMeta = {
              calls: (scoutMeta?.calls ?? 0) + 1,
              lastStatus: "completed",
            };
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                `scout-attempt-${totalAttempt}.md`,
                scoutResult.result,
              );
            }
          } else if (scoutResult.status === "stopped") {
            throwIfStopped(deps);
            scoutContext = buildScoutUnavailableNote("stopped");
            scoutFailed = true;
            scoutMeta = {
              calls: (scoutMeta?.calls ?? 0) + 1,
              lastStatus: "stopped",
            };
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                `scout-attempt-${totalAttempt}.md`,
                scoutContext,
              );
            }
          } else {
            const reason =
              scoutResult.status === "failed"
                ? scoutResult.error
                : "empty result";
            scoutContext = buildScoutUnavailableNote(reason);
            scoutFailed = true;
            scoutMeta = {
              calls: (scoutMeta?.calls ?? 0) + 1,
              lastStatus: "failed",
              lastReason: reason,
            };
            if (deps.paths) {
              persistTaskArtifact(
                deps.paths,
                taskId,
                `scout-attempt-${totalAttempt}.md`,
                scoutContext,
              );
            }
          }
        }
      }

      if (deps.paths && scoutMeta && scoutMeta.lastStatus !== "skipped") {
        const scoutNote =
          scoutMeta.lastStatus === "completed"
            ? `\u00b7 Task ${task.index}/${plan.tasks.length} scout completed`
            : `\u00b7 Task ${task.index}/${plan.tasks.length} scout unavailable${scoutMeta.lastReason ? `: ${scoutMeta.lastReason}` : ""}`;
        deps.updateState((prev) => checkpointPatch(prev, scoutNote));
      }
    }

    const implementerPrompt = buildImplementerPrompt({
      taskPacket: packet.markdown,
      worktreePath: effectiveWorktreePath,
      feedback: feedback ? formatFeedback(feedback) : undefined,
      scoutContext,
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
      cwd: worktreePath,
    });
    const implementerRef: AgentDisplayRef = {
      id: implementerId,
      role: "implementer",
      label: `Task ${task.index}/${plan.tasks.length} implementer \u00b7 ${shortTask(task.text)}`,
      startedAt: new Date().toISOString(),
      taskId,
      taskIndex: task.index,
      taskTotal: plan.tasks.length,
      taskTitle: shortTask(task.text),
    };
    setSchedulerActiveAgent(schedulerTask, implementerRef);
    deps.updateState((prev) => addActiveAgentPatch(prev, implementerRef));
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
        scout: scoutMeta,
        review: currentTaskReviewMetadata(deps.paths, taskId),
      });
      appendEvent(deps.paths, { type: "task_started", taskId });
    }
    const implementation = await deps.subagents.waitFor(
      implementerId,
      deps.signal,
    );
    clearSchedulerActiveAgent(schedulerTask, implementerId);
    deps.updateState((prev) => removeActiveAgentPatch(prev, implementerId));

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
          scout: scoutMeta,
          review: currentTaskReviewMetadata(deps.paths, taskId),
        });
      }
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        `Implementer subagent failed: ${implementation.error}`,
      );
      systemFailures++;
      priorReviewRequiredChanges = undefined;
      anchoredReviewChangeRequests = 0;
      attempt++;
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
        scout: scoutMeta,
        review: currentTaskReviewMetadata(deps.paths, taskId),
      });
    }

    // Boundary checks
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
    if (worktreePath && !(await deps.git.isCleanExcept(planArtifacts))) {
      throw new BlockedError(
        "implementer dirtied the main checkout outside the task worktree",
      );
    }
    if (worktreePath && (await taskGit.head()) !== taskHeadBefore) {
      throw new BlockedError("implementer changed task worktree HEAD");
    }

    const parsed = parseImplementerResult(implementation.result);
    deps.updateState((prev) =>
      checkpointPatch(
        prev,
        `\u00b7 Task ${task.index}/${plan.tasks.length} implementation finished: ${parsed.ok ? parsed.result.summary : parsed.reason}`,
      ),
    );
    if (parsed.ok) {
      const verificationSummary = parsed.result.verification
        .map((v) => `${v.command}: ${v.result}`)
        .join("; ");
      deps.updateState((prev) =>
        checkpointPatch(
          prev,
          `\u00b7 Task ${task.index}/${plan.tasks.length} verification: ${verificationSummary}`,
        ),
      );
    }
    if (!parsed.ok) {
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        parsed.reason,
      );
      systemFailures++;
      priorReviewRequiredChanges = undefined;
      anchoredReviewChangeRequests = 0;
      attempt++;
      continue;
    }
    priorSummary = parsed.result.summary;

    await taskGit.stageAllExcept(planArtifacts);
    const hasStaged = await taskGit.hasStagedChanges();

    if (hasStaged && parsed.result.outcome === "already_satisfied") {
      throw new BlockedError(
        "Implementer reported already_satisfied but produced staged changes; blocked to avoid carrying mutations into a retry.",
      );
    }

    let fingerprintBefore: string | undefined;
    let candidatePatch: string | undefined;
    let worktreeFingerprintBefore: string | undefined;
    let reviewHeadBefore: string;
    let reviewerPrompt: string | undefined;
    let skipReview = false;
    let skipReason: string | undefined;

    if (hasStaged) {
      fingerprintBefore = await taskGit.stagedFingerprint();
      candidatePatch = await taskGit.stagedDiff();
      worktreeFingerprintBefore =
        await taskGit.worktreeFingerprintExcept(planArtifacts);

      if (deps.paths) {
        persistTaskArtifact(deps.paths, taskId, "diff.patch", candidatePatch);
      }

      reviewHeadBefore = await taskGit.head();

      // ── Dynamic review decision ──
      const stagedSummary = await getStagedFileSummary(taskGit);
      const effectiveConfig =
        deps.effectiveTaskReview ?? resolveEffectiveTaskReview({});
      let validationEvidence: ValidationEvidence = { status: "not_required" };
      let reviewDecision = decideTaskReview({
        effectiveConfig,
        plannerDirective,
        isRetry,
        implementerOutcome: "changed",
        scoutFailed,
        stagedSummary,
        validation: validationEvidence,
      });

      if (reviewDecision.action === "needs_validation") {
        const validation = await runReviewSkipValidation(deps, taskGit, taskId);
        if (!validation.ok) {
          await taskGit.reset();
          feedback = recordSystemFailure(
            task.index,
            systemFailures,
            "system",
            `Validation failed: ${validation.reason}`,
          );
          systemFailures++;
          if (deps.paths) {
            persistReviewDecisionArtifact(
              deps.paths,
              taskId,
              attempt,
              reviewDecision,
              plannerDirective,
              stagedSummary,
              { status: "failed", reason: validation.reason },
              scoutFailed,
            );
            persistTaskArtifact(
              deps.paths,
              taskId,
              `review-validation-failure-attempt-${attempt}.log`,
              validation.log,
            );
          }
          priorReviewRequiredChanges = undefined;
          anchoredReviewChangeRequests = 0;
          attempt++;
          continue;
        }

        // Mutation detection after validation
        const postValidationHead = await taskGit.head();
        const postValidationStaged = await taskGit.stagedFingerprint();
        const postValidationWorktree =
          await taskGit.worktreeFingerprintExcept(planArtifacts);
        const changedPlanArtifactAfterValidation = changedSnapshotPath(
          planArtifacts,
          planArtifactSnapshot,
        );

        if (postValidationHead !== reviewHeadBefore) {
          throw new BlockedError("validation changed HEAD");
        }
        if (changedPlanArtifactAfterValidation) {
          throw new BlockedError(
            `validation changed a plan artifact: ${changedPlanArtifactAfterValidation}`,
          );
        }
        if (postValidationStaged !== fingerprintBefore) {
          throw new BlockedError("validation changed staged state");
        }
        if (postValidationWorktree !== worktreeFingerprintBefore) {
          throw new BlockedError("validation changed worktree state");
        }

        validationEvidence = {
          status: "passed",
          commands: validation.commands,
        };
        reviewDecision = decideTaskReview({
          effectiveConfig,
          plannerDirective,
          isRetry,
          implementerOutcome: "changed",
          scoutFailed,
          stagedSummary,
          validation: validationEvidence,
        });
      }

      if (deps.paths) {
        persistReviewDecisionArtifact(
          deps.paths,
          taskId,
          attempt,
          reviewDecision,
          plannerDirective,
          stagedSummary,
          validationEvidence,
          scoutFailed,
        );
        if (reviewDecision.action === "skip") {
          persistReviewSkippedArtifact(
            deps.paths,
            taskId,
            attempt,
            reviewDecision,
          );
        }
      }

      if (reviewDecision.action === "skip") {
        skipReview = true;
        skipReason = reviewDecision.reason;
        deps.updateState((prev) =>
          checkpointPatch(
            prev,
            `\u00b7 Task ${task.index}/${plan.tasks.length} review skipped: ${reviewDecision.reason}`,
          ),
        );
      } else {
        const outOfScopeTasks = plan.tasks
          .filter((t) => t.index !== task.index)
          .map((t) => t.originalLine);
        reviewerPrompt = buildReviewerPrompt({
          taskPacket: packet.markdown,
          worktreePath: effectiveWorktreePath,
          implementer: parsed.result,
          outOfScopeTasks,
          priorRequiredChanges: priorReviewRequiredChanges,
          baseSha: worktreePath ? baseSha : undefined,
        });
      }

      if (worktreePath) {
        const wipCommit = await taskGit.commit("pi-implement: candidate");
        if (wipCommit.exitCode !== 0) {
          await taskGit.resetHard(baseSha);
          feedback = recordSystemFailure(
            task.index,
            systemFailures,
            "commit-hook",
            `Commit failed. Fix the issue and try again.\n\n${wipCommit.stderr || wipCommit.stdout}`,
          );
          systemFailures++;
          priorReviewRequiredChanges = undefined;
          anchoredReviewChangeRequests = 0;
          attempt++;
          continue;
        }
        reviewHeadBefore = await taskGit.head();
        worktreeFingerprintBefore =
          await taskGit.worktreeFingerprintExcept(planArtifacts);
      }
    } else if (parsed.result.outcome === "already_satisfied" && !worktreePath) {
      await taskGit.reset();
      reviewHeadBefore = await taskGit.head();

      let accumulatedDiff: string | undefined;
      if (runBaseSha) {
        try {
          const diff = await deps.git.diffRange(
            runBaseSha,
            await deps.git.head(),
          );
          accumulatedDiff =
            diff.length <= MAX_ACCUMULATED_DIFF_CHARS ? diff : undefined;
        } catch {
          accumulatedDiff = undefined;
        }
      }

      const outOfScopeTasks = plan.tasks
        .filter((t) => t.index !== task.index)
        .map((t) => t.originalLine);
      reviewerPrompt = buildAlreadySatisfiedReviewerPrompt({
        taskPacket: packet.markdown,
        worktreePath: effectiveWorktreePath,
        implementer: parsed.result,
        headSha: reviewHeadBefore,
        accumulatedDiff,
        outOfScopeTasks,
        priorRequiredChanges: priorReviewRequiredChanges,
      });
    } else {
      const message =
        'No committable changes were produced after excluding plan artifacts and ignored files. Likely causes: the implementer produced no candidate code changes, only plan or ignored-file changes were made, or the task may already be satisfied and should be reported with outcome: "already_satisfied".';
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "system",
        message,
      );
      systemFailures++;
      await taskGit.reset();
      priorReviewRequiredChanges = undefined;
      anchoredReviewChangeRequests = 0;
      attempt++;
      continue;
    }
    if (schedulerTask) {
      schedulerTask.status = "reviewing";
    }
    deps.updateState({ phase: "reviewing", activeSubagentId: undefined });

    if (!skipReview && deps.paths) {
      persistTaskArtifact(deps.paths, taskId, "review.md", reviewerPrompt!);
    }

    if (!skipReview) {
      const reviewerId = await deps.subagents.spawn({
        type: deps.roles.reviewer.type,
        prompt: reviewerPrompt!,
        description: `review task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
        model: deps.roles.reviewer.model,
      });
      const reviewerRef: AgentDisplayRef = {
        id: reviewerId,
        role: "reviewer",
        label: `Task ${task.index}/${plan.tasks.length} reviewer \u00b7 ${shortTask(task.text)}`,
        startedAt: new Date().toISOString(),
        taskId,
        taskIndex: task.index,
        taskTotal: plan.tasks.length,
        taskTitle: shortTask(task.text),
      };
      setSchedulerActiveAgent(schedulerTask, reviewerRef);
      deps.updateState((prev) => addActiveAgentPatch(prev, reviewerRef));
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
          scout: scoutMeta,
          review: currentTaskReviewMetadata(deps.paths, taskId),
        });
      }
      const review = await deps.subagents.waitFor(reviewerId, deps.signal);
      clearSchedulerActiveAgent(schedulerTask, reviewerId);
      deps.updateState((prev) => removeActiveAgentPatch(prev, reviewerId));
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
          scout: scoutMeta,
          review: currentTaskReviewMetadata(deps.paths, taskId),
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
        priorReviewRequiredChanges = undefined;
        anchoredReviewChangeRequests = 0;
        attempt++;
        continue;
      }

      // Boundary checks
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

      if (
        !hasStaged &&
        !worktreePath &&
        !(await deps.git.isCleanExcept(planArtifacts))
      ) {
        throw new BlockedError("reviewer dirtied the serial checkout");
      }

      if (hasStaged) {
        await healReviewerMutations({
          taskGit,
          planArtifacts,
          stagedFingerprintBefore: fingerprintBefore!,
          candidatePatch: candidatePatch!,
          worktreeFingerprintBefore: worktreeFingerprintBefore!,
          committedSha: worktreePath ? reviewHeadBefore : undefined,
        });
      }
      const verdict = parseReviewerVerdict(review.result);
      if (verdict.verdict === "error") {
        await taskGit.reset();
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "system",
          `Reviewer produced invalid verdict: ${verdict.reason}`,
        );
        systemFailures++;
        priorReviewRequiredChanges = undefined;
        anchoredReviewChangeRequests = 0;
        attempt++;
        continue;
      }
      const isAnchoredReview = (priorReviewRequiredChanges?.length ?? 0) > 0;
      let unresolved: string[] = [];
      if (verdict.verdict === "changes_requested") {
        if (isAnchoredReview) {
          unresolved = verdict.requiredChanges.filter((change: string) =>
            priorReviewRequiredChanges!.includes(change),
          );
        } else {
          unresolved = verdict.requiredChanges;
        }
      }
      deps.updateState((prev) =>
        checkpointPatch(
          prev,
          verdict.verdict === "approved" || unresolved.length === 0
            ? `\u2713 Task ${task.index}/${plan.tasks.length} review approved`
            : `\u00b7 Task ${task.index}/${plan.tasks.length} review changes requested: ${formatRequiredChanges(unresolved)}`,
        ),
      );
      if (verdict.verdict === "changes_requested") {
        if (!isAnchoredReview) {
          if (worktreePath) {
            await taskGit.resetHard(baseSha);
          } else {
            await taskGit.reset();
          }
          priorReviewRequiredChanges = verdict.requiredChanges;
          feedback = reviewerFeedback(verdict.requiredChanges);
          attempt++;
          continue;
        }
        if (unresolved.length === 0) {
          // Anchored review returned only non-matching items — treat as approved.
          // Do NOT reset so the approved candidate diff remains staged.
          priorReviewRequiredChanges = undefined;
          anchoredReviewChangeRequests = 0;
          // Fall through to approval path below
        } else {
          anchoredReviewChangeRequests++;
          if (
            anchoredReviewChangeRequests >= MAX_ANCHORED_REVIEW_CHANGE_REQUESTS
          ) {
            await taskGit.reset();
            const message = unresolved
              .map((change) => `- ${change}`)
              .join("\n");
            throw new BlockedError(
              `anchored review change request limit reached for task ${task.index}:\n${message}`,
            );
          }
          if (worktreePath) {
            await taskGit.resetHard(baseSha);
          } else {
            await taskGit.reset();
          }
          priorReviewRequiredChanges = unresolved;
          feedback = reviewerFeedback(unresolved);
          attempt++;
          continue;
        }
      }
    }

    // Clear anchor on any approval path
    priorReviewRequiredChanges = undefined;
    anchoredReviewChangeRequests = 0;

    const taskReviewMeta = nextTaskReviewMetadata(
      deps.paths,
      taskId,
      skipReview,
      skipReason,
    );

    // Approved
    if (
      !hasStaged &&
      parsed.result.outcome === "already_satisfied" &&
      !worktreePath
    ) {
      throwIfStopped(deps);
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        throw new BlockedError(
          "satisfied approval succeeded but worktree is dirty",
        );
      }
      markTaskDone(deps.planPath, task);
      if (!(await deps.git.isCleanExcept(planArtifacts))) {
        markTaskUndone(deps.planPath, task);
        throw new BlockedError(
          "satisfied task marked done but worktree became dirty",
        );
      }
      try {
        throwIfStopped(deps);
      } catch (err) {
        if (err instanceof StoppedError) {
          markTaskUndone(deps.planPath, task);
          await taskGit.reset();
        }
        throw err;
      }
      if (deps.paths) {
        appendEvent(deps.paths, { type: "task_satisfied", taskId });
        writeTaskJson(deps.paths, taskId, {
          id: taskId,
          planIndex: task.index - 1,
          title: task.text,
          status: "satisfied",
          dependsOn: [],
          attempts: attempt,
          integrationAttempts: 0,
          baseSha,
          worktreePath,
          branchName,
          activeSubagentIds: [],
          scout: scoutMeta,
          review: taskReviewMeta,
        });
      }
      const satisfiedHead = await deps.git.head();
      deps.updateState((prev) => ({
        currentMainHead: satisfiedHead,
        ...checkpointPatch(
          prev,
          `\u2713 Task ${task.index}/${plan.tasks.length} satisfied`,
        ),
      }));
      return true;
    }

    // Approved (changed/legacy)
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
        scout: scoutMeta,
        review: taskReviewMeta,
      });
    }

    const commitMessage =
      parsed.result.outcome === "changed" ? parsed.result.commitMessage : "";
    const approvedMessage = isValidCommitMessage(commitMessage)
      ? commitMessage.trim()
      : fallbackCommitMessage(task.text);
    deps.updateState((prev) => ({
      phase: "committing" as const,
      lastReason: undefined,
      ...checkpointPatch(
        prev,
        `\u00b7 Task ${task.index}/${plan.tasks.length} committing: ${approvedMessage}`,
      ),
    }));
    await throwIfStoppedAndReset(deps, taskGit);

    if (worktreePath) {
      const taskCommit = await taskGit.reword(approvedMessage);
      if (taskCommit.exitCode !== 0) {
        const headAfterFailedCommit = await taskGit.head();
        if (headAfterFailedCommit !== reviewHeadBefore) {
          throw new BlockedError(
            "task reword failed but HEAD changed; inspect manually",
          );
        }
        await taskGit.resetHard(baseSha);
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "commit-hook",
          `Commit failed. Fix the issue and try again.\n\n${taskCommit.stderr || taskCommit.stdout}`,
        );
        systemFailures++;
        priorReviewRequiredChanges = undefined;
        anchoredReviewChangeRequests = 0;
        attempt++;
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
            scout: scoutMeta,
            review: currentTaskReviewMetadata(deps.paths, taskId),
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
        throw new BlockedError("task reword succeeded but HEAD did not change");
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
          commitMessage: approvedMessage,
          scout: scoutMeta,
          review: taskReviewMeta,
        });
        appendEvent(deps.paths, {
          type: "task_approved",
          taskId,
          commitSha: taskCommitSha,
        });
      }
      return true;
    }

    // Non-worktree serial mode
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
      const head = await deps.git.head();
      if (deps.paths) {
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
          scout: scoutMeta,
          review: taskReviewMeta,
        });
      }
      deps.updateState((prev) => ({
        currentMainHead: head,
        ...checkpointPatch(
          prev,
          `\u2713 Task ${task.index}/${plan.tasks.length} landed @ ${head.slice(0, 7)}`,
        ),
      }));
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
    priorReviewRequiredChanges = undefined;
    anchoredReviewChangeRequests = 0;
    attempt++;
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
        scout: scoutMeta,
        review: currentTaskReviewMetadata(deps.paths, taskId),
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
  committedSha?: string;
}): Promise<void> {
  const {
    taskGit,
    planArtifacts,
    stagedFingerprintBefore,
    candidatePatch,
    worktreeFingerprintBefore,
    committedSha,
  } = args;

  if (committedSha) {
    const worktreeFingerprintAfter =
      await taskGit.worktreeFingerprintExcept(planArtifacts);
    if (worktreeFingerprintAfter === worktreeFingerprintBefore) {
      return;
    }
    await taskGit.resetHard(committedSha);
    const healedWorktreeFingerprint =
      await taskGit.worktreeFingerprintExcept(planArtifacts);
    if (healedWorktreeFingerprint !== worktreeFingerprintBefore) {
      throw new BlockedError(
        "reviewer changed the candidate diff and auto-heal failed",
      );
    }
    return;
  }

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

export class OverallReviewFollowupError extends Error {
  readonly artifactPath: string;
  constructor(artifactPath: string, message: string) {
    super(message);
    this.name = "OverallReviewFollowupError";
    this.artifactPath = artifactPath;
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

function restorePlanArtifacts(
  paths: string[],
  snapshot: Map<string, string | undefined>,
): void {
  for (const path of paths) {
    const content = snapshot.get(path);
    if (content === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, content, "utf-8");
    }
  }
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

function reviewerFeedback(requiredChanges: string[]): RetryFeedback {
  const message = requiredChanges.map((change) => `- ${change}`).join("\n");
  return { source: "reviewer", message };
}

function formatFeedback(feedback: RetryFeedback): string {
  return `Source: ${feedback.source}\n${feedback.message}`;
}

function formatRequiredChanges(requiredChanges: string[]): string {
  return requiredChanges
    .map((change) => change.replace(/\s+/g, " ").trim())
    .join("; ");
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
