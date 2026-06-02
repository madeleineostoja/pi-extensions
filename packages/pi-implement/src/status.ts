export type Phase =
  | "idle"
  | "preflight"
  | "strategy"
  | "scheduling"
  | "coding"
  | "reviewing"
  | "committing"
  | "integrating"
  | "reworking"
  | "blocked"
  | "stopping"
  | "stopped"
  | "done";

export type TaskStatus =
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

export type ParallelTaskState = {
  id: string;
  planIndex: number;
  title: string;
  status: TaskStatus;
  blockedReason?: string;
  worktreePath?: string;
  landedCommitSha?: string;
  activeAgentIds?: string[];
};

export type RunState = {
  phase: Phase;
  planPath?: string;
  taskIndex?: number;
  totalTasks?: number;
  attempt?: number;
  activeSubagentId?: string;
  activeSubagentIds?: string[];
  lastReason?: string;
  // Parallel-run fields
  runId?: string;
  mode?: "auto" | "serial" | "parallel";
  modeSource?: "cli" | "auto";
  baseSha?: string;
  currentMainHead?: string;
  maxConcurrency?: number;
  tasks?: ParallelTaskState[];
  landedCount?: number;
  totalCount?: number;
};

export const idleState: RunState = { phase: "idle" };

const FOOTER_GLYPH = "󰚩";

export function formatFooterStatus(state: RunState): string {
  if (state.phase === "idle") {
    return "";
  }
  if (state.phase === "blocked") {
    return withFooterGlyph(
      `implement blocked${state.lastReason ? ` · ${shorten(state.lastReason, 32)}` : ""}`,
    );
  }
  if (state.phase === "done") {
    return withFooterGlyph("implement done");
  }
  if (state.phase === "stopped") {
    return withFooterGlyph("implement stopped");
  }

  if (state.tasks && state.totalCount !== undefined) {
    const landed = state.landedCount ?? 0;
    const total = state.totalCount ?? 0;
    return withFooterGlyph(`implement ${landed}/${total}`);
  }

  const progress =
    state.taskIndex && state.totalTasks
      ? `${state.taskIndex}/${state.totalTasks}`
      : "…";
  return withFooterGlyph(`implement ${progress}`);
}

export function formatRunStatus(state: RunState): string {
  if (state.phase === "idle") {
    return "pi-implement: idle";
  }

  const lines: string[] = [`pi-implement: ${state.phase}`];

  if (state.runId) {
    lines.push(`Run ID: ${state.runId}`);
  }
  if (state.planPath) {
    lines.push(`Plan: ${state.planPath}`);
  }
  if (state.mode) {
    const source = state.modeSource ? ` (${state.modeSource})` : "";
    lines.push(`Mode: ${state.mode}${source}`);
  }
  if (state.baseSha) {
    lines.push(`Base SHA: ${state.baseSha}`);
  }
  if (state.currentMainHead) {
    lines.push(`Main HEAD: ${state.currentMainHead}`);
  }
  if (state.maxConcurrency !== undefined) {
    lines.push(`Max concurrency: ${state.maxConcurrency}`);
  }

  if (state.tasks && state.tasks.length > 0) {
    lines.push("Tasks:");
    const sorted = [...state.tasks].sort((a, b) => a.planIndex - b.planIndex);
    for (const task of sorted) {
      let line = `  ${task.id} ${task.title}: ${task.status}`;
      if (task.blockedReason) {
        line += ` (${task.blockedReason})`;
      }
      if (task.worktreePath) {
        line += ` [${task.worktreePath}]`;
      }
      if (task.landedCommitSha) {
        line += ` @ ${shortenSha(task.landedCommitSha)}`;
      }
      lines.push(line);
    }
  } else if (state.taskIndex && state.totalTasks) {
    lines.push(`Task: ${state.taskIndex}/${state.totalTasks}`);
  }

  if (state.attempt) {
    lines.push(`Attempt: ${state.attempt}`);
  }
  if (state.activeSubagentId) {
    lines.push(`Active subagent: ${state.activeSubagentId}`);
  }
  if (state.activeSubagentIds && state.activeSubagentIds.length > 0) {
    lines.push(`Active subagents: ${state.activeSubagentIds.join(", ")}`);
  }
  if (state.lastReason) {
    lines.push(`Reason: ${state.lastReason}`);
  }

  return lines.join("\n");
}

function withFooterGlyph(status: string): string {
  return `${FOOTER_GLYPH} ${status}`;
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function shortenSha(sha: string): string {
  return sha.slice(0, 7);
}
