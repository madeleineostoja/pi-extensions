import { readFileSync } from "node:fs";
import { buildImplementerPrompt, buildReviewerPrompt } from "./prompts.js";
import {
  buildTaskPacket,
  markTaskDone,
  markTaskUndone,
  nextUncheckedTask,
  parsePlanFile,
} from "./plan.js";
import type { ParsedPlan } from "./plan.js";
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
  roles: EffectiveRoles;
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
  let planArtifacts = collectPlanArtifactPaths(plan);
  if (!(await deps.git.isCleanExcept(planArtifacts))) {
    throw new BlockedError("dirty worktree");
  }

  for (;;) {
    throwIfStopped(deps);
    plan = parsePlanFile(deps.planPath);
    planArtifacts = collectPlanArtifactPaths(plan);
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

    let feedback: RetryFeedback | undefined;
    let priorSummary: string | undefined;
    let reviewerRequests = 0;
    let systemFailures = 0;
    for (;;) {
      throwIfStopped(deps);
      const attempt = reviewerRequests + systemFailures + 1;
      const headBefore = await deps.git.head();
      const planArtifactSnapshot = snapshotPlanArtifacts(planArtifacts);
      const packet = buildTaskPacket(plan, task);
      deps.updateState({
        phase: "coding",
        taskIndex: task.index,
        totalTasks: plan.tasks.length,
        attempt,
        activeSubagentId: undefined,
        lastReason: feedback ? formatFeedback(feedback) : undefined,
      });
      const implementerId = await deps.subagents.spawn({
        type: deps.roles.implementer.type,
        prompt: buildImplementerPrompt({
          taskPacket: packet.markdown,
          feedback: feedback ? formatFeedback(feedback) : undefined,
          priorSummary,
        }),
        description: `implement task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
        model: deps.roles.implementer.model,
      });
      deps.updateState({ activeSubagentId: implementerId });
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
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "system",
          `Implementer subagent failed: ${implementation.error}`,
        );
        systemFailures++;
        continue;
      }
      if ((await deps.git.head()) !== headBefore) {
        throw new BlockedError("implementer changed HEAD");
      }
      const changedPlanArtifact = changedSnapshotPath(planArtifactSnapshot);
      if (changedPlanArtifact) {
        throw new BlockedError(
          `implementer changed a plan artifact: ${changedPlanArtifact}`,
        );
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

      await deps.git.stageAllExcept(planArtifacts);
      if (!(await deps.git.hasStagedChanges())) {
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "system",
          "No committable changes were produced after excluding plan artifacts and ignored files.",
        );
        systemFailures++;
        await deps.git.reset();
        continue;
      }
      const fingerprintBefore = await deps.git.stagedFingerprint();
      const reviewHeadBefore = await deps.git.head();
      deps.updateState({ phase: "reviewing", activeSubagentId: undefined });
      const reviewerId = await deps.subagents.spawn({
        type: deps.roles.reviewer.type,
        prompt: buildReviewerPrompt({
          taskPacket: packet.markdown,
          implementer: parsed.result,
        }),
        description: `review task ${task.index}/${plan.tasks.length}: ${shortTask(task.text)}`,
        model: deps.roles.reviewer.model,
      });
      deps.updateState({ activeSubagentId: reviewerId });
      const review = await deps.subagents.waitFor(reviewerId, deps.signal);
      deps.updateState({ activeSubagentId: undefined });
      if (review.status === "stopped") {
        await deps.git.reset();
        throw new StoppedError();
      }
      await throwIfStoppedAndReset(deps);
      if (review.status === "failed") {
        await deps.git.reset();
        feedback = recordSystemFailure(
          task.index,
          systemFailures,
          "system",
          `Reviewer subagent failed: ${review.error}`,
        );
        systemFailures++;
        continue;
      }
      if ((await deps.git.head()) !== reviewHeadBefore) {
        throw new BlockedError("reviewer changed HEAD");
      }
      if ((await deps.git.stagedFingerprint()) !== fingerprintBefore) {
        throw new BlockedError("reviewer changed the staged diff");
      }
      const verdict = parseReviewerVerdict(review.result);
      if (verdict.verdict === "changes_requested") {
        await deps.git.reset();
        feedback = recordReviewerRequest(
          task.index,
          reviewerRequests,
          verdict.requiredChanges,
        );
        reviewerRequests++;
        continue;
      }

      const approvedMessage = isValidCommitMessage(parsed.result.commitMessage)
        ? parsed.result.commitMessage.trim()
        : fallbackCommitMessage(task.text);
      deps.updateState({ phase: "committing", lastReason: undefined });
      await throwIfStoppedAndReset(deps);
      markTaskDone(deps.planPath, task);
      try {
        throwIfStopped(deps);
      } catch (err) {
        if (err instanceof StoppedError) {
          markTaskUndone(deps.planPath, task);
          await deps.git.reset();
        }
        throw err;
      }
      const commit = await deps.git.commit(approvedMessage);
      if (commit.exitCode === 0) {
        if (!(await deps.git.isCleanExcept(planArtifacts))) {
          throw new BlockedError("commit succeeded but worktree is dirty");
        }
        break;
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
      await deps.git.reset();
      feedback = recordSystemFailure(
        task.index,
        systemFailures,
        "commit-hook",
        `Commit failed. Fix the issue and try again.\n\n${commit.stderr || commit.stdout}`,
      );
      systemFailures++;
    }
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

function collectPlanArtifactPaths(plan: ParsedPlan): string[] {
  return [plan.path];
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
  snapshot: Map<string, string | undefined>,
): string | undefined {
  for (const [path, content] of snapshot) {
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

async function throwIfStoppedAndReset(deps: OrchestratorDeps): Promise<void> {
  try {
    throwIfStopped(deps);
  } catch (err) {
    if (err instanceof StoppedError) {
      await deps.git.reset();
    }
    throw err;
  }
}

function shortTask(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}
