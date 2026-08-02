import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import type { SchedulerEvent } from "./scheduler/scheduler.js";
import type { RunState } from "./store.js";

export const TEMPORARY_ACTIVITY_WIDGET_KEY =
  "pipkin.implement.temporary-activity";

type TransitionEvent = SchedulerEvent | { kind: "planner_bound" };
type RuntimeWorkstream =
  | { kind: "source"; id: string }
  | { kind: "overall"; repairId: string };

export function createTemporaryActivity(ctx: ExtensionCommandContext): {
  starting(label: string): void;
  update(state: RunState, event?: TransitionEvent): void;
  clear(): void;
} {
  let plan: ExecutionPlan | undefined;
  let planPath: string | undefined;
  let enabled = true;

  return {
    starting(label) {
      if (!enabled) {
        return;
      }
      bestEffort(() => {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(TEMPORARY_ACTIVITY_WIDGET_KEY, [
            `implement · starting · ${sanitize(label)}`,
          ]);
        }
      });
    },
    update(state, event) {
      if (!enabled) {
        return;
      }
      if (state.executionPlan?.path !== planPath) {
        const nextPath = state.executionPlan?.path;
        const nextPlan = nextPath
          ? bestEffort(() => readExecutionPlan(dirname(nextPath)))
          : undefined;
        planPath = nextPath && nextPlan ? nextPath : undefined;
        plan = nextPlan;
      }
      bestEffort(() => {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(
            TEMPORARY_ACTIVITY_WIDGET_KEY,
            formatTemporaryActivity(state, plan),
          );
        }
      });
      if (event) {
        bestEffort(() => notifyAttentionTransition(ctx, state, event, plan));
      }
    },
    clear() {
      enabled = false;
      bestEffort(() => {
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(TEMPORARY_ACTIVITY_WIDGET_KEY, undefined);
        }
      });
    },
  };
}

export function formatTemporaryActivity(
  state: RunState,
  plan?: ExecutionPlan,
): string[] {
  const taskTitles = new Map(
    plan?.tasks.map((task) => [task.id, sanitize(task.title)]),
  );
  const published = Object.values(state.tasks).filter(
    (task) => task.phase === "published",
  ).length;
  const total = Object.keys(state.tasks).length;
  const progress = total > 0 ? ` · ${published}/${total} published` : "";
  const lines = [
    `implement ${sanitize(state.run.id)} · ${runPhase(state)}${progress}`,
  ];

  for (const workstream of Object.values(state.workstreams.source)) {
    const titles = workstream.taskIds.map(
      (taskId) => taskTitles.get(taskId) ?? taskId,
    );
    lines.push(
      `  ${workstreamPhase(workstream.phase)} · ${workstream.id} · ${titles.join("; ")}`,
    );
    appendAttentionLines(lines, state, workstream);
  }

  for (const workstream of Object.values(state.workstreams.overall)) {
    lines.push(
      `  ${workstreamPhase(workstream.phase)} · ${workstream.repairId} · whole-plan repair`,
    );
    appendAttentionLines(lines, state, {
      kind: "overall",
      repairId: workstream.repairId,
    });
  }

  if (state.wholePlanReview.reviewRetry) {
    const retry = state.wholePlanReview.reviewRetry;
    lines.push(
      `  whole-plan review retry · ${retry.status} · ${shorten(retry.evidence.at(-1) ?? "retrying review")}`,
    );
  }
  if (state.failure) {
    lines.push(
      `  failed · ${state.failure.category} · ${shorten(state.failure.reason)}`,
    );
  }
  return lines;
}

function appendAttentionLines(
  lines: string[],
  state: RunState,
  workstream: RuntimeWorkstream,
): void {
  const sameWorkstream = (candidate: RuntimeWorkstream) =>
    candidate.kind === workstream.kind &&
    (candidate.kind === "source"
      ? candidate.id ===
        (workstream as Extract<RuntimeWorkstream, { kind: "source" }>).id
      : candidate.repairId ===
        (workstream as Extract<RuntimeWorkstream, { kind: "overall" }>)
          .repairId);
  const failure = Object.values(state.failures)
    .filter((entry) => sameWorkstream(entry.workstream))
    .at(-1);
  if (failure) {
    lines.push(
      `    last failure · ${failure.category} · ${shorten(failure.evidence)}`,
    );
  }
  const review =
    state.reviews[
      workstream.kind === "source"
        ? `source:${workstream.id}`
        : `overall:${workstream.repairId}`
    ];
  if (review?.latestCorrection) {
    lines.push(
      `    final review · ${review.latestCorrection.mode} correction · ${shorten(review.latestCorrection.evidence)}`,
    );
  }
  const findings = Object.values(state.findings).filter(
    (finding) =>
      finding.status === "open" && sameWorkstream(finding.workstream),
  );
  for (const finding of findings.slice(0, 2)) {
    lines.push(`    finding · ${shorten(finding.summary)}`);
  }
  if (findings.length > 2) {
    lines.push(`    findings · ${findings.length - 2} more`);
  }
}

function notifyAttentionTransition(
  ctx: ExtensionCommandContext,
  state: RunState,
  event: TransitionEvent,
  plan?: ExecutionPlan,
): void {
  if (event.kind === "planner_failed") {
    ctx.ui.notify(
      `Implement planner failed: ${shorten(event.reason)}`,
      "warning",
    );
    return;
  }
  if (
    event.kind === "implementation_failed" ||
    event.kind === "effect_failed"
  ) {
    const sourceId =
      event.workstream.kind === "source" ? event.workstream.id : undefined;
    const id =
      event.workstream.kind === "source"
        ? event.workstream.id
        : event.workstream.repairId;
    const titles = sourceId
      ? plan?.workstreams
          .find((workstream) => workstream.id === sourceId)
          ?.taskIds.map((taskId) =>
            sanitize(
              plan.tasks.find((task) => task.id === taskId)?.title ?? taskId,
            ),
          )
          .join("; ")
      : "whole-plan repair";
    ctx.ui.notify(
      `Implement ${id} failed${titles ? ` (${titles})` : ""}: ${shorten(event.evidence)}`,
      "warning",
    );
    return;
  }
  if (event.kind === "revision_failed") {
    ctx.ui.notify(
      `Implement revision failed: ${shorten(event.evidence)}`,
      "warning",
    );
    return;
  }
  if (event.kind === "whole_plan_review_failed") {
    ctx.ui.notify(
      `Implement review failed: ${shorten(event.evidence)}`,
      "warning",
    );
    return;
  }
  if (event.kind === "failure_requested") {
    ctx.ui.notify(
      `Implement failed safely: ${shorten(event.reason)}`,
      "warning",
    );
    return;
  }
  if (event.kind === "run_completed") {
    ctx.ui.notify(`Implement completed run ${state.run.id}.`, "info");
    return;
  }
  if (event.kind === "run_incomplete") {
    ctx.ui.notify(
      `Implement settled incomplete run ${state.run.id}; inspect retained lane failures.`,
      "warning",
    );
  }
}

function runPhase(state: RunState): string {
  if (state.phase === "whole_plan_review") {
    return state.wholePlanReview.status === "repairing"
      ? "whole-plan repair"
      : "whole-plan review";
  }
  return state.phase.replaceAll("_", " ");
}

function workstreamPhase(phase: string): string {
  return phase.replaceAll("_", " ");
}

function shorten(value: string, max = 180): string {
  const normalized = sanitize(value);
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

function bestEffort<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

/* eslint-disable no-control-regex */
const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC_PATTERN = /\x1b./g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

function sanitize(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESC_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}
