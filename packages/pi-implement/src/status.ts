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

export type AgentRole = "implementer" | "reviewer" | "planner" | "triage";

export type AgentDisplayRef = {
  id: string;
  role: AgentRole;
  label: string;
  startedAt: string;
  taskId?: string;
  taskIndex?: number;
  taskTotal?: number;
  taskTitle?: string;
};

export type ParallelTaskState = {
  id: string;
  planIndex: number;
  title: string;
  status: TaskStatus;
  blockedReason?: string;
  worktreePath?: string;
  landedCommitSha?: string;
  activeAgentIds?: string[];
  activeAgentRefs?: AgentDisplayRef[];
};

export type StatePatch =
  | Partial<RunState>
  | ((prev: RunState) => Partial<RunState>);

export type RunState = {
  phase: Phase;
  planPath?: string;
  taskIndex?: number;
  totalTasks?: number;
  attempt?: number;
  activeSubagentId?: string;
  activeSubagentIds?: string[];
  activeAgentRefs?: AgentDisplayRef[];
  lastReason?: string;
  startedAt?: string;
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
  const activeRefs = (state.activeAgentRefs ?? []).filter((ref) =>
    state.activeSubagentIds === undefined
      ? true
      : state.activeSubagentIds.includes(ref.id),
  );
  if (activeRefs.length > 0) {
    lines.push("Active agents:");
    for (const ref of activeRefs) {
      lines.push(`  ${ref.label}`);
      lines.push(`    agent id: ${ref.id}`);
    }
  } else if (state.activeSubagentId) {
    lines.push(`Active subagent: ${state.activeSubagentId}`);
  } else if (state.activeSubagentIds && state.activeSubagentIds.length > 0) {
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

export function makeAgentLabel(ref: AgentDisplayRef): string {
  if (ref.taskIndex !== undefined && ref.taskTotal !== undefined) {
    return `Task ${ref.taskIndex}/${ref.taskTotal} ${ref.role}${ref.taskTitle ? ` \u00b7 ${ref.taskTitle}` : ""}`;
  }
  if (ref.role === "planner") {
    return `Planner \u00b7 Select implementation strategy`;
  }
  if (ref.role === "triage") {
    return `Triage \u00b7 Analyze plan dependencies`;
  }
  return ref.label || `${ref.role} \u00b7 ${ref.id}`;
}

export function formatWidgetLines(
  state: RunState,
  nowMs = Date.now(),
): string[] {
  const MAX_LINES = 5;
  const lines: string[] = [];

  if (
    state.phase === "idle" ||
    state.phase === "done" ||
    state.phase === "blocked" ||
    state.phase === "stopped"
  ) {
    return lines;
  }

  const total = state.totalCount ?? state.totalTasks ?? 0;
  const landed =
    state.landedCount ??
    (state.taskIndex ? Math.max(0, state.taskIndex - 1) : 0);
  const phaseLabel = state.phase;
  const startedAt = state.activeAgentRefs?.[0]?.startedAt;
  const elapsed = startedAt
    ? formatDuration(nowMs - new Date(startedAt).getTime())
    : "";

  const headerParts = ["pi-implement", `${landed}/${total}`];
  if (state.tasks) {
    headerParts.push("landed");
  }
  headerParts.push(phaseLabel);
  if (elapsed) {
    headerParts.push(elapsed);
  }
  const header = headerParts.join(" \u00b7 ");
  lines.push(header);

  const refs = state.activeAgentRefs ?? [];
  const displayRefs = refs.filter((r) =>
    state.activeSubagentIds === undefined
      ? true
      : state.activeSubagentIds.includes(r.id),
  );
  const rawActiveIds = (
    state.activeSubagentIds ??
    (state.activeSubagentId ? [state.activeSubagentId] : [])
  ).filter((id) => !displayRefs.some((ref) => ref.id === id));
  const entryLines = [
    ...displayRefs.map((ref) => {
      const label = makeAgentLabel(ref);
      const duration = formatDuration(
        nowMs - new Date(ref.startedAt).getTime(),
      );
      return `${ref.role === "implementer" ? "\u25b6" : "\u00b7"} ${label}${duration ? ` \u00b7 ${duration}` : ""}`;
    }),
    ...rawActiveIds.map((id) => `· Active subagent · ${id}`),
  ];

  const shown = entryLines.slice(0, MAX_LINES - 2);
  lines.push(...shown);
  const hidden = entryLines.length - shown.length;
  if (hidden > 0) {
    lines.push(`\u2026 ${hidden} more active task${hidden > 1 ? "s" : ""}`);
  }

  return lines;
}

function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) {
    return "";
  }
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "";
}
