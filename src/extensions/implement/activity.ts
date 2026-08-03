import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  EventBus,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createActivityPublisher,
  type ActivityPublisher,
  type ActivityState,
} from "#ui/activity";
import { readExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import type { SchedulerEvent } from "./scheduler/scheduler.js";
import type { RunState } from "./store.js";

type TransitionEvent = SchedulerEvent | { kind: "planner_bound" };
export function createImplementActivity(
  events: EventBus,
  ctx: ExtensionCommandContext,
  publisher: ActivityPublisher = createActivityPublisher(events, "implement"),
): {
  update(state: RunState, event?: TransitionEvent): void;
  clear(): void;
} {
  let plan: ExecutionPlan | undefined;
  let planPath: string | undefined;
  let enabled = true;
  let published = new Set<string>();

  return {
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
      published =
        bestEffort(() => publishActivity(publisher, state, plan, published)) ??
        published;
      if (event) {
        bestEffort(() => notifyAttentionTransition(ctx, state, event, plan));
      }
    },
    clear() {
      if (!enabled) {
        return;
      }
      enabled = false;
      published.clear();
      publisher.dispose();
    },
  };
}

function publishActivity(
  publisher: ActivityPublisher,
  state: RunState,
  plan: ExecutionPlan | undefined,
  previous: ReadonlySet<string>,
): Set<string> {
  const runId = activityId("run", state.run.id);
  const current = publishedIds(state);
  const accepted = new Set<string>();
  for (const id of previous) {
    if (current.has(id)) {
      accepted.add(id);
      continue;
    }
    try {
      if (!publisher.remove(id)) {
        accepted.add(id);
      }
    } catch {
      accepted.add(id);
    }
  }
  const published = Object.values(state.tasks).filter(
    (task) => task.phase === "published",
  ).length;
  const total = Object.keys(state.tasks).length;
  if (
    publisher.upsert({
      id: runId,
      label: "Implement",
      title: "Implementation run",
      detail: shorten(runPhase(state), 120),
      state: runState(state),
      ...(total ? { progress: { completed: published, total } } : {}),
      updatedAt: Date.now(),
    })
  ) {
    accepted.add(runId);
  }
  const taskTitles = new Map(
    plan?.tasks.map((task) => [task.id, sanitize(task.title)]),
  );
  for (const workstream of Object.values(state.workstreams.source)) {
    if (terminalWorkstream(workstream.phase)) {
      continue;
    }
    const title =
      workstream.taskIds
        .map((id) => taskTitles.get(id))
        .find((value): value is string => Boolean(value)) ??
      "Source workstream";
    const id = activityId("source", workstream.id);
    if (
      publisher.upsert({
        id,
        parent: { source: "implement", id: runId },
        label: "Workstream",
        title: shorten(title, 240),
        detail: shorten(workstreamPhase(workstream.phase), 120),
        state: workstreamState(workstream.phase),
        updatedAt: Date.now(),
      })
    ) {
      accepted.add(id);
    }
  }
  for (const workstream of Object.values(state.workstreams.overall)) {
    if (terminalWorkstream(workstream.phase)) {
      continue;
    }
    const id = activityId("repair", workstream.repairId);
    if (
      publisher.upsert({
        id,
        parent: { source: "implement", id: runId },
        label: "Repair",
        title: "Whole-plan repair",
        detail: shorten(workstreamPhase(workstream.phase), 120),
        state: workstreamState(workstream.phase),
        updatedAt: Date.now(),
      })
    ) {
      accepted.add(id);
    }
  }
  return accepted;
}

function publishedIds(state: RunState): Set<string> {
  const result = new Set<string>([activityId("run", state.run.id)]);
  for (const workstream of Object.values(state.workstreams.source)) {
    if (!terminalWorkstream(workstream.phase)) {
      result.add(activityId("source", workstream.id));
    }
  }
  for (const workstream of Object.values(state.workstreams.overall)) {
    if (!terminalWorkstream(workstream.phase)) {
      result.add(activityId("repair", workstream.repairId));
    }
  }
  return result;
}

function activityId(kind: "run" | "source" | "repair", value: string): string {
  const prefix = `${kind}-`;
  return `${prefix}${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 64 - prefix.length)}`;
}

function terminalWorkstream(phase: string): boolean {
  return ["completed", "stopped", "dependency_skipped"].includes(phase);
}

function runState(state: RunState): ActivityState {
  if (
    state.failure ||
    state.phase === "failed" ||
    state.phase === "incomplete"
  ) {
    return "failed";
  }
  if (state.phase === "completed") {
    return "completed";
  }
  if (state.phase === "planning") {
    return "queued";
  }
  return "running";
}

function workstreamState(phase: string): ActivityState {
  if (phase.includes("failed")) {
    return "attention";
  }
  if (phase === "queued") {
    return "queued";
  }
  return "running";
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
    const residuals = (state.wholePlanReview.epoch?.findingIds ?? []).filter(
      (id) => state.findings[id]?.status === "open",
    ).length;
    ctx.ui.notify(
      `Implement completed run ${state.run.id}${residuals > 0 ? ` with ${residuals} residual findings.` : "."}`,
      "info",
    );
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
