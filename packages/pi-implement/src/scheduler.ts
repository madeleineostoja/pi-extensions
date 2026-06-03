import type { ImplementGraph } from "./graph.js";
import type { AgentDisplayRef } from "./status.js";

export type SchedulerTaskStatus =
  | "pending"
  | "ready"
  | "coding"
  | "reviewing"
  | "approved"
  | "integrating"
  | "landed"
  | "blocked"
  | "needs_rework"
  | "integration_failed"
  | "failed"
  | "stopped";

export type SchedulerTask = {
  id: string;
  planIndex: number;
  title: string;
  status: SchedulerTaskStatus;
  dependsOn: string[];
  mode: "serial" | "parallel";
  worktreePath?: string;
  branchName?: string;
  taskCommitSha?: string;
  landedCommitSha?: string;
  activeAgentIds: string[];
  activeAgentRefs: AgentDisplayRef[];
  integrationAttempts: number;
  lastReason?: string;
  approvedCommitMessage?: string;
};

export type SchedulerRun = {
  runId: string;
  maxConcurrency: number;
  tasks: Map<string, SchedulerTask>;
  landedOrder: string[];
  phase:
    | "scheduling"
    | "integrating"
    | "reworking"
    | "blocked"
    | "stopped"
    | "done";
};

export function createSchedulerRun(
  graph: ImplementGraph,
  maxConcurrency: number,
): SchedulerRun {
  const tasks = new Map<string, SchedulerTask>();
  for (const node of graph.nodes) {
    tasks.set(node.id, {
      id: node.id,
      planIndex: node.planIndex,
      title: node.title,
      status: "pending",
      dependsOn: [...node.dependsOn],
      mode: node.mode,
      activeAgentIds: [],
      activeAgentRefs: [],
      integrationAttempts: 0,
    });
  }
  return {
    runId: graph.runId,
    maxConcurrency,
    tasks,
    landedOrder: [],
    phase: "scheduling",
  };
}

export function computeReadyTasks(run: SchedulerRun): string[] {
  const ready: string[] = [];
  for (const task of run.tasks.values()) {
    if (
      task.status !== "pending" &&
      task.status !== "blocked" &&
      task.status !== "needs_rework"
    ) {
      continue;
    }
    const allDepsLanded = task.dependsOn.every((depId) => {
      const dep = run.tasks.get(depId);
      return dep?.status === "landed";
    });
    if (allDepsLanded) {
      ready.push(task.id);
    }
  }
  ready.sort((a, b) => {
    const ta = run.tasks.get(a)!;
    const tb = run.tasks.get(b)!;
    return ta.planIndex - tb.planIndex;
  });
  return ready;
}

export function countActiveCodingReviewing(run: SchedulerRun): number {
  let count = 0;
  for (const task of run.tasks.values()) {
    if (task.status === "coding" || task.status === "reviewing") {
      count++;
    }
  }
  return count;
}

export function anyActiveSerialTask(run: SchedulerRun): boolean {
  for (const task of run.tasks.values()) {
    if (
      task.mode === "serial" &&
      (task.status === "coding" ||
        task.status === "reviewing" ||
        task.status === "integrating")
    ) {
      return true;
    }
  }
  return false;
}

export function canStartTask(run: SchedulerRun, taskId: string): boolean {
  const task = run.tasks.get(taskId);
  if (!task) {
    return false;
  }
  if (
    task.status !== "pending" &&
    task.status !== "blocked" &&
    task.status !== "ready" &&
    task.status !== "needs_rework"
  ) {
    return false;
  }

  const activeCodingReviewing = countActiveCodingReviewing(run);
  if (activeCodingReviewing >= run.maxConcurrency) {
    return false;
  }

  if (task.mode === "serial" && activeCodingReviewing > 0) {
    return false;
  }
  if (task.mode === "parallel" && anyActiveSerialTask(run)) {
    return false;
  }

  return task.dependsOn.every((depId) => {
    const dep = run.tasks.get(depId);
    return dep?.status === "landed";
  });
}

export function startTask(run: SchedulerRun, taskId: string): void {
  const task = run.tasks.get(taskId);
  if (!task) {
    return;
  }
  task.status = "coding";
  task.activeAgentIds = [];
  task.activeAgentRefs = [];
}

export function nextTaskToLand(run: SchedulerRun): string | undefined {
  const candidates: SchedulerTask[] = [];
  for (const task of run.tasks.values()) {
    if (task.status === "approved" || task.status === "integrating") {
      candidates.push(task);
    }
  }
  candidates.sort((a, b) => a.planIndex - b.planIndex);
  for (const task of candidates) {
    const allEarlierLanded = [...run.tasks.values()].every((t) => {
      if (t.planIndex >= task.planIndex) {
        return true;
      }
      return t.status === "landed";
    });
    if (allEarlierLanded && task.status === "approved") {
      return task.id;
    }
  }
  return undefined;
}

export function hasAnyTaskInFlight(run: SchedulerRun): boolean {
  for (const task of run.tasks.values()) {
    if (
      task.status === "coding" ||
      task.status === "reviewing" ||
      task.status === "integrating"
    ) {
      return true;
    }
  }
  return false;
}

export function allTasksTerminal(run: SchedulerRun): boolean {
  for (const task of run.tasks.values()) {
    if (!isTerminalStatus(task.status)) {
      return false;
    }
  }
  return true;
}

export function anyTaskFailedBlockedStopped(run: SchedulerRun): boolean {
  for (const task of run.tasks.values()) {
    if (
      task.status === "failed" ||
      task.status === "blocked" ||
      task.status === "stopped" ||
      task.status === "integration_failed"
    ) {
      return true;
    }
  }
  return false;
}

function isTerminalStatus(status: SchedulerTaskStatus): boolean {
  return (
    status === "landed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "stopped" ||
    status === "integration_failed"
  );
}

export function getBlockedReason(
  task: SchedulerTask,
  run: SchedulerRun,
): string | undefined {
  if (
    task.status !== "pending" &&
    task.status !== "blocked" &&
    task.status !== "ready" &&
    task.status !== "needs_rework"
  ) {
    return undefined;
  }
  const unlandedDeps = task.dependsOn.filter((depId) => {
    const dep = run.tasks.get(depId);
    return dep?.status !== "landed";
  });
  if (unlandedDeps.length > 0) {
    return `waiting for ${unlandedDeps.join(", ")}`;
  }
  const activeCodingReviewing = countActiveCodingReviewing(run);
  if (activeCodingReviewing >= run.maxConcurrency) {
    return "concurrency limit";
  }
  if (task.mode === "serial" && activeCodingReviewing > 0) {
    return "serial task waiting for active tasks";
  }
  if (task.mode === "parallel" && anyActiveSerialTask(run)) {
    return "waiting for serial task";
  }
  return undefined;
}
