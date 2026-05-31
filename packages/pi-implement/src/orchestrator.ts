import { exec, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompts.js";
import {
  buildTaskPacket,
  markTaskDone,
  markTaskUndone,
  nextUncheckedTask,
  parsePlanFile,
} from "./plan.js";
import type { CommandResult, GitClient } from "./git.js";
import type { SubagentClient } from "./subagents.js";
import type { EffectiveRoles } from "./config.js";
import type { RunState, ParallelTaskState } from "./status.js";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseImplementerResult,
  parseReviewerVerdict,
} from "./verdict.js";
import type { StatePaths, TaskJson } from "./state.js";
import {
  writeTaskJson,
  appendEvent,
  taskIdFromTask,
  readTaskJson,
} from "./state.js";
import type { RunMode } from "./state.js";
import { readGraphJson } from "./graph.js";
import type { ImplementGraph } from "./graph.js";
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
} from "./scheduler.js";

const MAX_REVIEWER_REQUESTS = 3;
const MAX_SYSTEM_FAILURES = 2;
const MAX_REWORK_ATTEMPTS = 2;
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
  verifyCommand?: string;
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

  if (deps.mode === "serial") {
    await runSerialImplementation(deps, plan, planArtifacts);
    return;
  }

  // For auto/parallel: try to load a graph and run the scheduler
  const graph = deps.paths ? readGraphJson(deps.paths.runDir) : undefined;
  if (graph && deps.paths && deps.runId) {
    await runParallelImplementation(deps, graph, plan, planArtifacts);
    return;
  }

  // Fallback to serial if no graph (shouldn't happen in normal flow)
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
): Promise<void> {
  const sched = createSchedulerRun(graph, deps.maxConcurrency ?? 1);
  const runningWorkers = new Map<string, Promise<WorkerResult>>();
  let plan = initialPlan;
  let reworkInFlight = false;

  deps.updateState({
    phase: "scheduling",
    runId: deps.runId,
    mode: deps.mode,
    baseSha: graph.baseSha,
    maxConcurrency: deps.maxConcurrency,
    totalCount: graph.nodes.length,
    landedCount: 0,
  });

  while (!allTasksTerminal(sched)) {
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
      if (sched.tasks.get(taskId)?.status === "needs_rework") {
        reworkInFlight = true;
      }
      startTask(sched, taskId);

      const taskNode = graph.nodes.find((n) => n.id === taskId)!;
      const planTask = plan.tasks.find((t) => t.index === taskNode.planIndex);
      if (!planTask) {
        continue;
      }

      const promise = launchTaskWorker(
        deps,
        sched,
        taskId,
        planTask,
        planArtifacts,
      );
      runningWorkers.set(taskId, promise);
    }

    updateParallelState(deps, sched);

    // ── Try landing (serialized, plan-ordered) ──
    const toLand = nextTaskToLand(sched);
    if (toLand && !reworkInFlight) {
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
        reworkInFlight = true;
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

      const task = sched.tasks.get(result.taskId)!;
      if (result.outcome.kind === "approved") {
        task.status = "approved";
        task.taskCommitSha = result.outcome.taskCommitSha;
        task.approvedCommitMessage = result.outcome.commitMessage;
        task.activeAgentIds = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...(existing ?? taskToJson(task)),
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
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...(existing ?? taskToJson(task)),
            status: "failed",
            activeSubagentIds: [],
            lastReason: result.outcome.reason,
          });
        }
      } else {
        // stopped
        task.status = "stopped";
        task.activeAgentIds = [];
        if (deps.paths) {
          const existing = readTaskJson(deps.paths, result.taskId);
          writeTaskJson(deps.paths, result.taskId, {
            ...(existing ?? taskToJson(task)),
            status: "stopped",
            activeSubagentIds: [],
          });
        }
      }
      continue;
    }

    // Nothing running and nothing to land
    if (!toLand && !reworkInFlight) {
      if (anyTaskFailedBlockedStopped(sched)) {
        sched.phase = "blocked";
        break;
      }
      // Could be waiting for dependencies to complete — if all pending are blocked
      // by unlanded deps and nothing is running, that's a deadlock (shouldn't happen with valid graph)
      break;
    }

    // If rework in flight but nothing running, we need to wait for a worker
    // Actually this shouldn't happen since rework workers are in runningWorkers
    if (reworkInFlight && runningWorkers.size === 0) {
      reworkInFlight = false;
    }
  }

  if (allTasksTerminal(sched) && !anyTaskFailedBlockedStopped(sched)) {
    const finalValidation = await validateFinalParallelRun(deps);
    if (!finalValidation.ok) {
      sched.phase = "blocked";
      deps.updateState({
        phase: "blocked",
        lastReason: finalValidation.reason,
      });
      throw new BlockedError(finalValidation.reason);
    }
  }

  const landedCount = [...sched.tasks.values()].filter(
    (t) => t.status === "landed",
  ).length;
  deps.updateState({
    phase:
      sched.phase === "done" || allTasksTerminal(sched)
        ? "done"
        : (sched.phase as RunState["phase"]),
    landedCount,
    activeSubagentIds: [],
  });

  if (anyTaskFailedBlockedStopped(sched)) {
    const failed = [...sched.tasks.values()].find(
      (t) => t.status === "failed" || t.status === "integration_failed",
    );
    throw new BlockedError(
      failed?.lastReason ?? "One or more tasks failed or were blocked",
    );
  }
}

async function launchTaskWorker(
  deps: OrchestratorDeps,
  sched: SchedulerRun,
  taskId: string,
  planTask: ReturnType<typeof parsePlanFile>["tasks"][number],
  planArtifacts: string[],
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
      if (task.status === "needs_rework") {
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
          ...(existing ?? taskToJson(task)),
          status: "coding",
          baseSha,
          worktreePath,
          branchName,
        });
        appendEvent(deps.paths, { type: "task_started", taskId });
      }
    } catch (err) {
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

  try {
    const cherryPick = await deps.git.cherryPickNoCommit(task.taskCommitSha);
    if (cherryPick.exitCode !== 0) {
      return await failForRework(
        "cherry-pick",
        cherryPick.stderr ||
          cherryPick.stdout ||
          "git cherry-pick --no-commit failed",
      );
    }

    const validation = await validateIntegratedTask(
      deps,
      taskId,
      planArtifacts,
    );
    if (!validation.ok) {
      return await failForRework("validation", validation.reason);
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
      writeTaskJson(deps.paths, taskId, {
        ...taskToJson(task),
        status: "landed",
        landedCommitSha: landedHead,
      });
    }

    deps.updateState({ currentMainHead: landedHead });
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
    writeTaskJson(deps.paths, taskId, {
      ...taskToJson(task),
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
  restorePlanArtifacts(planArtifacts, planArtifactSnapshot);
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

async function validateIntegratedTask(
  deps: OrchestratorDeps,
  taskId: string,
  planArtifacts: string[],
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
): Promise<ValidationResult> {
  const diff = await deps.git.stagedDiff();
  const prompt = `Review this integrated parallel task diff on the main checkout.

No command validation is configured or auto-detected. Decide whether the integrated diff is safe to commit.

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
  const result = await deps.subagents.waitFor(id, deps.signal);
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

function safeArtifactName(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") ||
    "validation"
  );
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
    tasks.push({
      id: task.id,
      planIndex: task.planIndex,
      title: task.title,
      status: task.status as ParallelTaskState["status"],
      blockedReason: getBlockedReason(task, sched),
      worktreePath: task.worktreePath,
      landedCommitSha: task.landedCommitSha,
      activeAgentIds: task.activeAgentIds,
    });
    for (const id of task.activeAgentIds) {
      activeAgentIds.push(id);
    }
  }

  deps.updateState({
    tasks,
    activeSubagentIds: activeAgentIds,
    landedCount,
    totalCount: sched.tasks.size,
  });
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
  };
}

// ── Task worker (shared serial + parallel) ─────────────────────────────────

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

    // Approved
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
          commitMessage: approvedMessage,
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
