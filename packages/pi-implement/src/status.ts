export type Phase =
  | "idle"
  | "preflight"
  | "coding"
  | "reviewing"
  | "committing"
  | "blocked"
  | "stopping"
  | "stopped"
  | "done";

export type RunState = {
  phase: Phase;
  planPath?: string;
  taskIndex?: number;
  totalTasks?: number;
  attempt?: number;
  activeSubagentId?: string;
  lastReason?: string;
};

export const idleState: RunState = { phase: "idle" };

export function formatFooterStatus(state: RunState): string {
  if (state.phase === "idle") {
    return "";
  }
  if (state.phase === "blocked") {
    return `implement blocked${state.lastReason ? ` · ${shorten(state.lastReason, 32)}` : ""}`;
  }
  if (state.phase === "done") {
    return "implement done";
  }
  if (state.phase === "stopped") {
    return "implement stopped";
  }
  const progress =
    state.taskIndex && state.totalTasks
      ? `${state.taskIndex}/${state.totalTasks}`
      : "…";
  const attempt = state.attempt ? ` · attempt ${state.attempt}` : "";
  return `implement ${progress} · ${state.phase}${attempt}`;
}

export function formatRunStatus(state: RunState): string {
  if (state.phase === "idle") {
    return "pi-implement: idle";
  }
  const lines = [`pi-implement: ${state.phase}`];
  if (state.planPath) {
    lines.push(`Plan: ${state.planPath}`);
  }
  if (state.taskIndex && state.totalTasks) {
    lines.push(`Task: ${state.taskIndex}/${state.totalTasks}`);
  }
  if (state.attempt) {
    lines.push(`Attempt: ${state.attempt}`);
  }
  if (state.activeSubagentId) {
    lines.push(`Active subagent: ${state.activeSubagentId}`);
  }
  if (state.lastReason) {
    lines.push(`Reason: ${state.lastReason}`);
  }
  return lines.join("\n");
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
