import type { Phase, RunState, TaskStatus } from "./status.js";

const PHASE_LABEL: Partial<Record<Phase, string>> = {
  preflight: "running preflight checks",
  strategy: "selecting execution strategy",
  scheduling: "scheduling tasks",
  coding: "implementing",
  reviewing: "under review",
  committing: "committing",
  integrating: "integrating",
  reworking: "reworking",
  final_review: "running final review",
};

const STATUS_NOTE: Partial<
  Record<TaskStatus, { icon: string; verb: string; withReason?: boolean }>
> = {
  coding: { icon: "▶", verb: "started" },
  reviewing: { icon: "·", verb: "under review" },
  approved: { icon: "✓", verb: "approved" },
  integrating: { icon: "·", verb: "integrating" },
  landed: { icon: "✓", verb: "landed" },
  satisfied: { icon: "✓", verb: "satisfied" },
  needs_rework: { icon: "↻", verb: "needs rework", withReason: true },
  integration_failed: {
    icon: "✗",
    verb: "integration failed",
    withReason: true,
  },
  failed: { icon: "✗", verb: "failed", withReason: true },
  blocked: { icon: "✗", verb: "blocked", withReason: true },
  stopped: { icon: "⏹", verb: "stopped" },
};

/**
 * Derive user-facing progress notes from a state transition. Pure: emits a
 * line only when `next` represents a meaningful change from `prev`, so the
 * many no-op updateState calls (e.g. activeSubagentId churn) produce nothing.
 * `taskTitles` is the plan's task text indexed 0-based; only needed for serial
 * runs, since parallel task state already carries its own title.
 */
export function diffProgress(
  prev: RunState,
  next: RunState,
  taskTitles: string[],
): string[] {
  const lines: string[] = [];

  if (next.tasks) {
    lines.push(...parallelNotes(prev, next));
  } else {
    lines.push(...serialNotes(prev, next, taskTitles));
  }

  lines.push(...runLevelNotes(prev, next));
  lines.push(...checkpointNotes(prev, next));
  return lines;
}

function checkpointNotes(prev: RunState, next: RunState): string[] {
  const nextQueue = next.checkpointQueue ?? [];
  const prevSequence =
    prev.checkpointSequence ?? prev.checkpointQueue?.length ?? 0;
  const nextSequence = next.checkpointSequence ?? nextQueue.length;
  const newCount = Math.max(0, nextSequence - prevSequence);
  return newCount === 0 ? [] : nextQueue.slice(-newCount);
}

function serialNotes(
  prev: RunState,
  next: RunState,
  taskTitles: string[],
): string[] {
  const lines: string[] = [];
  const idx = next.taskIndex;
  const total = next.totalTasks;
  const tag = idx && total ? `Task ${idx}/${total}` : "pi-implement";
  const title = idx ? taskTitles[idx - 1] : undefined;

  const taskChanged = idx !== undefined && prev.taskIndex !== idx;

  if (taskChanged && prev.taskIndex && prev.totalTasks) {
    lines.push(`✓ Task ${prev.taskIndex}/${prev.totalTasks} completed`);
  }

  if (next.phase === "coding") {
    if (taskChanged) {
      lines.push(`▶ ${tag} started${title ? `: ${title}` : ""}`);
    } else if ((next.attempt ?? 0) > (prev.attempt ?? 0)) {
      lines.push(
        `↻ ${tag} retry (attempt ${next.attempt})${reasonSuffix(next.lastReason)}`,
      );
    }
    return lines;
  }

  if (next.phase !== prev.phase) {
    const label = PHASE_LABEL[next.phase];
    if (label) {
      lines.push(idx && total ? `· ${tag} ${label}` : `· ${label}`);
    }
  }
  return lines;
}

function parallelNotes(prev: RunState, next: RunState): string[] {
  const lines: string[] = [];
  const total = next.totalCount;
  const prevById = new Map((prev.tasks ?? []).map((t) => [t.id, t]));

  for (const task of next.tasks ?? []) {
    const before = prevById.get(task.id);
    if (before?.status === task.status) {
      continue;
    }
    const note = STATUS_NOTE[task.status];
    if (!note) {
      continue;
    }
    const tag = `Task ${task.planIndex + 1}${total ? `/${total}` : ""}`;
    let line = `${note.icon} ${tag} ${note.verb}: ${task.title}`;
    if (task.status === "landed" && task.landedCommitSha) {
      line += ` @ ${task.landedCommitSha.slice(0, 7)}`;
    }
    if (note.withReason && task.blockedReason) {
      line += ` — ${task.blockedReason}`;
    }
    lines.push(line);
  }
  return lines;
}

function runLevelNotes(prev: RunState, next: RunState): string[] {
  if (next.phase === prev.phase) {
    return [];
  }
  if (next.phase === "done") {
    const completed = completedTaskCount(next);
    return [
      completed !== undefined
        ? `✓ pi-implement complete: ${completed} task(s) completed`
        : "✓ pi-implement complete",
    ];
  }
  if (next.phase === "blocked") {
    return [`✗ pi-implement blocked${reasonSuffix(next.lastReason)}`];
  }
  if (next.phase === "followup_required") {
    return [
      `⚠ pi-implement follow-up required${reasonSuffix(next.lastReason)}`,
    ];
  }
  if (next.phase === "stopped") {
    return ["⏹ pi-implement stopped"];
  }
  return [];
}

function completedTaskCount(state: RunState): number | undefined {
  if (state.landedCount !== undefined || state.satisfiedCount !== undefined) {
    return (state.landedCount ?? 0) + (state.satisfiedCount ?? 0);
  }
  if (state.tasks) {
    return state.tasks.filter(
      (task) => task.status === "landed" || task.status === "satisfied",
    ).length;
  }
  return state.totalCount ?? state.totalTasks;
}

function reasonSuffix(reason: string | undefined): string {
  if (!reason) {
    return "";
  }
  const trimmed = reason.replace(/\s+/g, " ").trim();
  const short = trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 119)}…`;
  return `: ${short}`;
}
