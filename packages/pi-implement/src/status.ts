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
  | "final_review"
  | "final_rework"
  | "followup_required"
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
  | "satisfied"
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

export type AgentRuntimeSnapshot = {
  id: string;
  status?: string;
  description?: string;
  toolUses?: number;
  tokensTotal?: number;
  compactionCount?: number;
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
  satisfiedCount?: number;
  totalCount?: number;
  checkpointQueue?: string[];
  checkpointSequence?: number;
};

export const idleState: RunState = { phase: "idle" };

const FOOTER_GLYPH = "󰚩";
const MAX_RECENT_CHECKPOINTS = 25;

export type FooterStatusTone = "active" | "warning" | "success";

export type FooterStatusParts = {
  glyph: string;
  text: string;
  tone: FooterStatusTone;
};

export function formatFooterStatusParts(
  state: RunState,
): FooterStatusParts | undefined {
  if (state.phase === "idle") {
    return undefined;
  }
  if (state.phase === "blocked") {
    return footerStatusParts(
      `implement blocked${state.lastReason ? ` · ${shorten(state.lastReason, 32)}` : ""}`,
      "warning",
    );
  }
  if (state.phase === "done") {
    return footerStatusParts("implement done", "success");
  }
  if (state.phase === "followup_required") {
    return footerStatusParts(
      `implement follow-up required${state.lastReason ? ` · ${shorten(state.lastReason, 32)}` : ""}`,
      "warning",
    );
  }
  if (state.phase === "stopped") {
    return footerStatusParts("implement stopped", "warning");
  }

  if (state.tasks && state.totalCount !== undefined) {
    const completed = completedTaskCount(state);
    const failed = failedTaskCount(state);
    const total = state.totalCount ?? 0;
    const failedText = failed > 0 ? ` · ${failed} failed` : "";
    return footerStatusParts(
      `implement ${completed}/${total}${failedText}`,
      failed > 0 ? "warning" : "active",
    );
  }

  const progress =
    state.taskIndex && state.totalTasks
      ? `${state.taskIndex}/${state.totalTasks}`
      : "…";
  return footerStatusParts(`implement ${progress}`, "active");
}

export function formatFooterStatus(state: RunState): string {
  const parts = formatFooterStatusParts(state);
  return parts ? `${parts.glyph} ${parts.text}` : "";
}

export function formatRunStatus(state: RunState, nowMs = Date.now()): string {
  if (state.phase === "idle") {
    return "pi-implement: idle";
  }

  const lines: string[] = [`pi-implement: ${state.phase}`];

  if (state.phase === "followup_required" && state.lastReason) {
    lines.push(`Follow-up: ${state.lastReason}`);
  }

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

  if (state.startedAt) {
    const elapsed = formatDuration(nowMs - new Date(state.startedAt).getTime());
    if (elapsed) {
      lines.push(`Elapsed: ${elapsed}`);
    }
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
      const agentElapsed = ref.startedAt
        ? formatDuration(nowMs - new Date(ref.startedAt).getTime())
        : "";
      lines.push(`  ${ref.label}${agentElapsed ? ` · ${agentElapsed}` : ""}`);
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

  const recent = (state.checkpointQueue ?? []).slice(-5);
  if (recent.length > 0) {
    lines.push("Recent checkpoints:");
    for (const cp of recent) {
      lines.push(`  ${cp}`);
    }
  }

  return lines.join("\n");
}

function footerStatusParts(
  text: string,
  tone: FooterStatusTone,
): FooterStatusParts {
  return { glyph: FOOTER_GLYPH, text, tone };
}

function completedTaskCount(state: RunState): number {
  return landedTaskCount(state) + satisfiedTaskCount(state);
}

function landedTaskCount(state: RunState): number {
  if (state.tasks) {
    return state.tasks.filter((task) => task.status === "landed").length;
  }
  return state.landedCount ?? 0;
}

function satisfiedTaskCount(state: RunState): number {
  if (state.tasks) {
    return state.tasks.filter((task) => task.status === "satisfied").length;
  }
  return state.satisfiedCount ?? 0;
}

function failedTaskCount(state: RunState): number {
  return (
    state.tasks?.filter(
      (task) =>
        task.status === "failed" ||
        task.status === "integration_failed" ||
        task.status === "blocked",
    ).length ?? 0
  );
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function shortenSha(sha: string): string {
  return sha.slice(0, 7);
}

export function checkpointPatch(
  prev: RunState,
  message: string,
): Partial<RunState> {
  const sequence =
    (prev.checkpointSequence ?? prev.checkpointQueue?.length ?? 0) + 1;
  return {
    checkpointQueue: [...(prev.checkpointQueue ?? []), message].slice(
      -MAX_RECENT_CHECKPOINTS,
    ),
    checkpointSequence: sequence,
  };
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
  runtimeSnapshots: AgentRuntimeSnapshot[] = [],
): string[] {
  const MAX_LINES = 6;
  const lines: string[] = [];

  if (
    state.phase === "idle" ||
    state.phase === "done" ||
    state.phase === "blocked" ||
    state.phase === "stopped" ||
    state.phase === "followup_required"
  ) {
    return lines;
  }

  const isParallel =
    state.tasks !== undefined || state.totalCount !== undefined;
  let progressText: string;
  if (isParallel) {
    const landed = landedTaskCount(state);
    const satisfied = satisfiedTaskCount(state);
    const completed = completedTaskCount(state);
    const failed = failedTaskCount(state);
    const total = state.totalCount ?? state.totalTasks ?? 0;
    const baseProgress =
      satisfied > 0
        ? `${completed}/${total} complete`
        : `${landed}/${total} landed`;
    progressText =
      failed > 0 ? `${baseProgress} · ${failed} failed` : baseProgress;
  } else if (state.taskIndex !== undefined && state.totalTasks !== undefined) {
    progressText = `${state.taskIndex}/${state.totalTasks} current`;
  } else {
    progressText = "…";
  }

  const phaseLabel = state.phase;
  const startedAt = state.activeAgentRefs?.[0]?.startedAt;
  const elapsed = startedAt
    ? formatDuration(nowMs - new Date(startedAt).getTime())
    : "";

  const headerParts = ["pi-implement", progressText, phaseLabel];
  if (elapsed) {
    headerParts.push(elapsed);
  }
  const header = headerParts.join(" \u00b7 ");
  lines.push(header);

  const snapshotMap = new Map(runtimeSnapshots.map((s) => [s.id, s]));

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
      const snapshot = snapshotMap.get(ref.id);
      const glyph = ref.role === "implementer" ? "\u25b6" : "\u00b7";
      let line = `${glyph} ${label}${duration ? ` \u00b7 ${duration}` : ""}`;
      const shortId = ref.id.slice(0, 8);
      line += ` \u00b7 ${shortId}`;
      if (snapshot?.status) {
        line += ` \u00b7 ${snapshot.status}`;
      }
      if (snapshot?.toolUses !== undefined) {
        line += ` \u00b7 ${snapshot.toolUses} tool`;
      }
      if (snapshot?.tokensTotal !== undefined) {
        line += ` \u00b7 ${formatTokenCount(snapshot.tokensTotal)} tok`;
      }
      if (snapshot?.compactionCount !== undefined) {
        line += ` \u00b7 \u21ca${snapshot.compactionCount}`;
      }
      line += " \u00b7 /agents";
      return line;
    }),
    ...rawActiveIds.map((id) => {
      const snapshot = snapshotMap.get(id);
      let line = "·";
      if (snapshot?.description) {
        line += ` ${snapshot.description}`;
      } else {
        line += " Active subagent";
      }
      line += ` · ${id.slice(0, 8)}`;
      if (snapshot?.status) {
        line += ` · ${snapshot.status}`;
      }
      if (snapshot?.toolUses !== undefined) {
        line += ` · ${snapshot.toolUses} tool`;
      }
      if (snapshot?.tokensTotal !== undefined) {
        line += ` · ${formatTokenCount(snapshot.tokensTotal)} tok`;
      }
      if (snapshot?.compactionCount !== undefined) {
        line += ` · \u21ca${snapshot.compactionCount}`;
      }
      line += " · /agents";
      return line;
    }),
  ];

  const shown = entryLines.slice(0, MAX_LINES - 2);
  lines.push(...shown);
  const hidden = entryLines.length - shown.length;
  if (hidden > 0) {
    lines.push(
      `\u2026 ${hidden} more active task${hidden > 1 ? "s" : ""} · /agents`,
    );
  }

  return lines;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${n}`;
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
