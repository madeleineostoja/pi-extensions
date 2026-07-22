import type { Phase, ReviewProgress, RunState, TaskStatus } from "./status.js";

const PHASE_LABEL: Partial<Record<Phase, string>> = {
  coding: "implementing",
  reviewing: "under review",
  integrating: "integrating",
  reworking: "reworking",
  final_review: "running final review",
  final_rework: "reworking overall",
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
 * `taskTitles` is the plan's task text indexed 0-based; only needed when task
 * state has not yet been projected, since scheduled task state carries titles.
 */
export function diffProgress(
  prev: RunState,
  next: RunState,
  taskTitles: string[],
): string[] {
  const lines: string[] = [];

  lines.push(...strategyNotes(prev, next));

  if (next.tasks) {
    lines.push(...scheduledTaskNotes(prev, next));
    lines.push(...reviewProgressNotes(prev, next));
  } else {
    lines.push(...serialNotes(prev, next, taskTitles));
  }

  lines.push(...overallReviewProgressNotes(prev, next));
  lines.push(...runLevelNotes(prev, next));
  lines.push(...checkpointNotes(prev, next));
  return lines;
}

function strategyNotes(prev: RunState, next: RunState): string[] {
  if (prev.phase !== "strategy" || next.phase === "strategy") {
    return [];
  }
  if (!next.mode) {
    return [];
  }
  const concurrency = next.maxConcurrency ?? "?";
  return [
    `✓ selected implementation (effective concurrency ${concurrency})${reasonSuffix(next.lastReason)}`,
  ];
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
  const enteredCoding = next.phase === "coding" && prev.phase !== "coding";

  // "landed"/"satisfied" checkpoints already signal task completion,
  // so skip a redundant generic "completed" note here.

  if (next.phase === "coding") {
    if (taskChanged || enteredCoding) {
      lines.push(`▶ ${tag} started${title ? `: ${title}` : ""}`);
    } else if (
      prev.attempt !== undefined &&
      (next.attempt ?? 0) > prev.attempt
    ) {
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

function scheduledTaskNotes(prev: RunState, next: RunState): string[] {
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

function reviewProgressNotes(prev: RunState, next: RunState): string[] {
  const previous = new Map((prev.tasks ?? []).map((task) => [task.id, task]));
  return (next.tasks ?? []).flatMap((task) => {
    const before = previous.get(task.id);
    const tag = `Task ${task.planIndex + 1}${next.totalCount ? `/${next.totalCount}` : ""}`;
    return [
      formatReviewProgressNote(
        tag,
        before?.reviewProgress,
        task.reviewProgress,
      ),
      formatReviewProgressNote(
        tag,
        before?.integrationReviewProgress,
        task.integrationReviewProgress,
      ),
    ].filter((line): line is string => Boolean(line));
  });
}

function overallReviewProgressNotes(prev: RunState, next: RunState): string[] {
  const note = formatReviewProgressNote(
    "Overall",
    prev.overallReviewProgress,
    next.overallReviewProgress,
  );
  return note ? [note] : [];
}

function formatReviewProgressNote(
  label: string,
  prev: ReviewProgress | undefined,
  next: ReviewProgress | undefined,
): string | undefined {
  if (!next || reviewProgressEqual(prev, next)) {
    return undefined;
  }
  const scope =
    next.scope === "integration" ? " integration review" : " review";
  const candidate = next.previousCandidate
    ? ` candidate ${next.previousCandidate.slice(0, 7)}→${next.currentCandidate.slice(0, 7)}`
    : "";
  const counts = `outstanding ${next.currentOutstandingCount}${next.previousOutstandingCount === undefined ? "" : ` (previous ${next.previousOutstandingCount}`}${next.previousOutstandingCount === undefined ? "" : ")"}, best ${next.bestOutstandingCount}`;
  if (next.retryKind) {
    return `↻ ${label}${scope} ${next.retryKind} retry`;
  }
  if (next.stage === "stalled") {
    return `⚠ ${label}${scope} stalled: ${counts}`;
  }
  if (next.stage === "approved") {
    return `✓ ${label}${scope} approved${candidate ? ` at ${next.currentCandidate.slice(0, 7)}` : ""}`;
  }
  const changes = [
    next.admittedIds.length ? `admitted ${next.admittedIds.join(", ")}` : "",
    next.resolvedIds.length ? `resolved ${next.resolvedIds.join(", ")}` : "",
    next.deferredIds.length ? `deferred ${next.deferredIds.join(", ")}` : "",
    next.rejectedIds.length ? `rejected ${next.rejectedIds.join(", ")}` : "",
    next.addressedIds.length ? `addressed ${next.addressedIds.join(", ")}` : "",
    next.notAddressedIds.length
      ? `not addressed ${next.notAddressedIds.join(", ")}`
      : "",
    next.unresolvedIds.length
      ? `unresolved ${next.unresolvedIds.join(", ")}`
      : "",
    next.newRegressionIds.length
      ? `admitted regression ${next.newRegressionIds.join(", ")}`
      : "",
  ].filter(Boolean);
  return `· ${label}${scope}${candidate}${changes.length ? `: ${changes.join("; ")}; ` : ": "}${counts}`;
}

function reviewProgressEqual(
  prev: ReviewProgress | undefined,
  next: ReviewProgress,
): boolean {
  if (!prev) {
    return false;
  }
  return (
    formatReviewProgressComparable(prev) ===
    formatReviewProgressComparable(next)
  );
}

function formatReviewProgressComparable(progress: ReviewProgress): string {
  return [
    progress.scope,
    progress.stage,
    progress.previousCandidate,
    progress.currentCandidate,
    progress.admittedIds.join(","),
    progress.resolvedIds.join(","),
    progress.deferredIds.join(","),
    progress.rejectedIds.join(","),
    progress.addressedIds.join(","),
    progress.notAddressedIds.join(","),
    progress.unresolvedIds.join(","),
    progress.newRegressionIds.join(","),
    progress.previousOutstandingCount,
    progress.currentOutstandingCount,
    progress.bestOutstandingCount,
    progress.retryKind,
  ].join("|");
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
