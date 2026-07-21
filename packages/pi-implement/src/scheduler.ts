import {
  validateCanonicalRunState,
  type CandidateRef,
  type CanonicalRunState,
} from "./canonical-state.js";
import type { ImplementGraph } from "./graph.js";
import type { IntegrationLedger } from "./integration-ledger.js";
import type { AgentDisplayRef } from "./status.js";

export type SchedulerEffect =
  | { kind: "start_worker"; taskId: string; leaseId: string }
  | {
      kind: "start_integration";
      taskId: string;
      attemptId: string;
      candidateId: string;
    }
  | { kind: "stop_workers"; leaseIds: string[] }
  | { kind: "cleanup"; debtId: string };

export type SchedulerEvent =
  | { kind: "run_started" }
  | { kind: "workers_selected"; now: string }
  | {
      kind: "worker_finished";
      taskId: string;
      leaseId: string;
      outcome:
        | { kind: "candidate_ready"; candidate: CandidateRef }
        | { kind: "satisfied" }
        | { kind: "waiting_rework"; candidateId: string }
        | {
            kind: "failed";
            reason: string;
            failureKind: "spawn" | "wait" | "timeout" | "safety" | "unknown";
          }
        | { kind: "cancelled" };
    }
  | {
      kind: "integration_requested";
      taskId: string;
      attemptId: string;
      pipelineHash: string;
      now: string;
    }
  | {
      kind: "integration_prepared";
      attemptId: string;
      preparedCommitSha: string;
    }
  | { kind: "integration_publishing"; attemptId: string }
  | {
      kind: "integration_landed";
      attemptId: string;
      receipt: CanonicalRunState["landingReceipts"][number];
    }
  | {
      kind: "integration_needs_rework";
      attemptId: string;
      candidateId: string;
    }
  | { kind: "integration_paused"; attemptId: string }
  | { kind: "integration_resumed"; attemptId: string }
  | { kind: "cleanup_completed"; debtId: string }
  | { kind: "run_stopping" }
  | { kind: "run_completed" }
  | { kind: "run_blocked"; reason: string };

export type SchedulerTransition = {
  state: CanonicalRunState;
  effects: SchedulerEffect[];
  accepted: boolean;
  error?: string;
};

const executablePhases = new Set(["queued", "waiting_rework"]);

export function selectWorkerTasks(state: CanonicalRunState): string[] {
  const capacity =
    state.run.effectiveWorkerConcurrency - state.workerLeases.length;
  if (capacity <= 0 || state.runtime.phase !== "running") {
    return [];
  }

  return [...state.graph.tasks]
    .sort((left, right) => left.planIndex - right.planIndex)
    .filter((task) => {
      const runtime = state.runtime.tasks[task.id];
      return (
        executablePhases.has(runtime?.phase ?? "") &&
        task.dependsOn.every((dependency) =>
          isDependencyComplete(state.runtime.tasks[dependency]),
        )
      );
    })
    .slice(0, capacity)
    .map((task) => task.id);
}

export function selectIntegrationTask(
  state: CanonicalRunState,
): string | undefined {
  if (
    state.runtime.phase !== "running" ||
    state.integrationAttempts.some(
      (attempt) =>
        attempt.phase === "preparing" ||
        attempt.phase === "prepared" ||
        attempt.phase === "publishing" ||
        attempt.phase === "paused",
    )
  ) {
    return undefined;
  }

  return [...state.graph.tasks]
    .sort((left, right) => left.planIndex - right.planIndex)
    .find((task) => {
      const runtime = state.runtime.tasks[task.id];
      return (
        runtime?.phase === "candidate_ready" &&
        task.dependsOn.every((dependency) =>
          isDependencyComplete(state.runtime.tasks[dependency]),
        )
      );
    })?.id;
}

export function transition(
  input: CanonicalRunState,
  event: SchedulerEvent,
): SchedulerTransition {
  const state = structuredClone(input);
  const reject = (error: string): SchedulerTransition => ({
    state: input,
    effects: [],
    accepted: false,
    error,
  });
  const accept = (effects: SchedulerEffect[] = []): SchedulerTransition => {
    try {
      return {
        state: validateCanonicalRunState(state, "<scheduler reducer>", input),
        effects,
        accepted: true,
      };
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error));
    }
  };

  switch (event.kind) {
    case "run_started":
      if (state.runtime.phase !== "preflight") {
        return reject("run is not in preflight");
      }
      state.runtime.phase = "running";
      return accept();

    case "workers_selected": {
      const selected = selectWorkerTasks(state);
      if (selected.length === 0) {
        return accept();
      }
      const effects: SchedulerEffect[] = [];
      for (const [index, taskId] of selected.entries()) {
        const leaseId = `worker:${state.run.id}:${state.revision + 1}:${index}`;
        const attempts = state.workerLeases.filter(
          (lease) => lease.taskId === taskId,
        ).length;
        state.workerLeases.push({
          id: leaseId,
          taskId,
          attempt: attempts + 1,
          acquiredAt: event.now,
        });
        state.runtime.tasks[taskId] = {
          phase: "executing",
          workerLeaseId: leaseId,
        };
        effects.push({ kind: "start_worker", taskId, leaseId });
      }
      return accept(effects);
    }

    case "worker_finished": {
      const runtime = state.runtime.tasks[event.taskId];
      const lease = state.workerLeases.find(
        (entry) => entry.id === event.leaseId,
      );
      if (
        runtime?.phase !== "executing" ||
        runtime.workerLeaseId !== event.leaseId ||
        lease?.taskId !== event.taskId
      ) {
        return reject("worker result does not own the active task lease");
      }
      state.workerLeases = state.workerLeases.filter(
        (entry) => entry.id !== event.leaseId,
      );
      switch (event.outcome.kind) {
        case "candidate_ready": {
          const existing = state.candidates[event.outcome.candidate.id];
          if (
            existing &&
            JSON.stringify(existing) !== JSON.stringify(event.outcome.candidate)
          ) {
            return reject("candidate identity is immutable");
          }
          if (event.outcome.candidate.reviewReceipt.verdict !== "approved") {
            return reject("candidate is not approved for integration");
          }
          if (!existing) {
            state.candidates[event.outcome.candidate.id] =
              event.outcome.candidate;
          }
          state.runtime.tasks[event.taskId] = {
            phase: "candidate_ready",
            candidateId: event.outcome.candidate.id,
          };
          break;
        }
        case "satisfied":
          state.runtime.tasks[event.taskId] = {
            phase: "completed",
            result: "satisfied",
          };
          break;
        case "waiting_rework":
          if (!state.candidates[event.outcome.candidateId]) {
            return reject("rework references an unknown candidate");
          }
          state.runtime.tasks[event.taskId] = {
            phase: "waiting_rework",
            candidateId: event.outcome.candidateId,
          };
          break;
        case "failed":
          state.runtime.tasks[event.taskId] = {
            phase: "failed",
            reason: event.outcome.reason,
            failureKind: event.outcome.failureKind,
          };
          break;
        case "cancelled":
          state.runtime.tasks[event.taskId] = { phase: "queued" };
          break;
      }
      return accept();
    }

    case "integration_requested": {
      if (selectIntegrationTask(state) !== event.taskId) {
        return reject("task is not eligible for integration");
      }
      const runtime = state.runtime.tasks[event.taskId];
      if (runtime?.phase !== "candidate_ready") {
        return reject("task has no candidate ready for integration");
      }
      if (
        state.candidates[runtime.candidateId]?.reviewReceipt.verdict !==
        "approved"
      ) {
        return reject("candidate is not approved for integration");
      }
      if (
        state.integrationAttempts.some(
          (attempt) => attempt.id === event.attemptId,
        )
      ) {
        return reject("integration attempt already exists");
      }
      state.integrationAttempts.push({
        id: event.attemptId,
        owner: { kind: "task", taskId: event.taskId },
        candidateId: runtime.candidateId,
        targetBaseSha: state.candidates[runtime.candidateId]!.baseSha,
        pipelineHash: event.pipelineHash,
        startedAt: event.now,
        phase: "preparing",
      });
      state.runtime.tasks[event.taskId] = {
        phase: "integrating",
        candidateId: runtime.candidateId,
        integrationAttemptId: event.attemptId,
      };
      return accept([
        {
          kind: "start_integration",
          taskId: event.taskId,
          attemptId: event.attemptId,
          candidateId: runtime.candidateId,
        },
      ]);
    }

    case "integration_prepared":
      return updateIntegration(
        state,
        event.attemptId,
        "preparing",
        (attempt) => ({
          ...attempt,
          phase: "prepared",
          preparedCommitSha: event.preparedCommitSha,
        }),
        accept,
        reject,
      );

    case "integration_publishing": {
      const attempt = state.integrationAttempts.find(
        (entry) => entry.id === event.attemptId,
      );
      if (attempt?.phase !== "prepared") {
        return reject("integration is not prepared");
      }
      state.integrationAttempts = state.integrationAttempts.map((entry) =>
        entry.id === attempt.id
          ? {
              ...attempt,
              phase: "publishing",
              preparedCommitSha: attempt.preparedCommitSha,
            }
          : entry,
      );
      return accept();
    }

    case "integration_landed": {
      const attempt = state.integrationAttempts.find(
        (entry) => entry.id === event.attemptId,
      );
      if (attempt?.phase !== "publishing") {
        return reject("integration is not publishing");
      }
      if (attempt.owner.kind !== "task") {
        return reject(
          "overall integration is not supported by this transition",
        );
      }
      if (
        event.receipt.attemptId !== attempt.id ||
        JSON.stringify(event.receipt.owner) !== JSON.stringify(attempt.owner)
      ) {
        return reject("landing receipt does not match integration attempt");
      }
      state.integrationAttempts = state.integrationAttempts.map((entry) =>
        entry.id === attempt.id
          ? {
              ...entry,
              phase: "completed",
              preparedCommitSha: attempt.preparedCommitSha,
            }
          : entry,
      );
      if (
        !state.landingReceipts.some(
          (receipt) => receipt.attemptId === event.receipt.attemptId,
        )
      ) {
        state.landingReceipts.push(event.receipt);
      }
      state.runtime.tasks[attempt.owner.taskId] = {
        phase: "completed",
        result: "landed",
      };
      const debtId = `integration:${attempt.id}`;
      if (!state.cleanupDebt.some((debt) => debt.id === debtId)) {
        state.cleanupDebt.push({
          id: debtId,
          kind: "integration-worktree",
          reason: "integration landed; owned workspace cleanup is pending",
        });
      }
      return accept([{ kind: "cleanup", debtId }]);
    }

    case "integration_needs_rework": {
      const attempt = state.integrationAttempts.find(
        (entry) => entry.id === event.attemptId,
      );
      const runtime =
        attempt?.owner.kind === "task"
          ? state.runtime.tasks[attempt.owner.taskId]
          : undefined;
      if (
        !attempt ||
        !["preparing", "prepared", "publishing"].includes(attempt.phase) ||
        attempt.candidateId !== event.candidateId ||
        attempt.owner.kind !== "task" ||
        runtime?.phase !== "integrating" ||
        runtime.integrationAttemptId !== attempt.id ||
        runtime.candidateId !== event.candidateId
      ) {
        return reject(
          "integration result does not match an active task attempt",
        );
      }
      state.integrationAttempts = state.integrationAttempts.map((entry) =>
        entry.id === event.attemptId ? closeReworkAttempt(entry) : entry,
      );
      state.runtime.tasks[attempt.owner.taskId] = {
        phase: "waiting_rework",
        candidateId: event.candidateId,
      };
      return accept();
    }

    case "integration_paused": {
      const attempt = state.integrationAttempts.find(
        (entry) => entry.id === event.attemptId,
      );
      if (
        !attempt ||
        !["preparing", "prepared", "publishing"].includes(attempt.phase)
      ) {
        return reject("integration attempt is not active");
      }
      state.integrationAttempts = state.integrationAttempts.map((entry) =>
        entry.id === event.attemptId
          ? attempt.phase === "preparing"
            ? { ...attempt, phase: "paused", resumePhase: "preparing" }
            : attempt.phase === "prepared" || attempt.phase === "publishing"
              ? {
                  ...attempt,
                  phase: "paused",
                  resumePhase: attempt.phase,
                  preparedCommitSha: attempt.preparedCommitSha,
                }
              : entry
          : entry,
      );
      return accept();
    }

    case "integration_resumed": {
      const attempt = state.integrationAttempts.find(
        (entry) => entry.id === event.attemptId,
      );
      if (
        !attempt ||
        attempt.phase !== "paused" ||
        attempt.owner.kind !== "task"
      ) {
        return reject("integration attempt is not resumable");
      }
      const runtime = state.runtime.tasks[attempt.owner.taskId];
      if (
        runtime?.phase !== "integrating" ||
        runtime.integrationAttemptId !== attempt.id ||
        runtime.candidateId !== attempt.candidateId ||
        (attempt.resumePhase !== "preparing" && !attempt.preparedCommitSha)
      ) {
        return reject("integration task no longer owns the paused attempt");
      }
      state.integrationAttempts = state.integrationAttempts.map((entry) =>
        entry.id === attempt.id ? resumeIntegrationAttempt(attempt) : entry,
      );
      return accept([
        {
          kind: "start_integration",
          taskId: attempt.owner.taskId,
          attemptId: attempt.id,
          candidateId: attempt.candidateId,
        },
      ]);
    }

    case "cleanup_completed":
      if (!state.cleanupDebt.some((debt) => debt.id === event.debtId)) {
        return reject("cleanup debt does not exist");
      }
      state.cleanupDebt = state.cleanupDebt.filter(
        (debt) => debt.id !== event.debtId,
      );
      return accept();

    case "run_stopping":
      if (state.runtime.phase !== "running") {
        return reject("only a running run can stop");
      }
      state.runtime.phase = "stopping";
      return accept([
        {
          kind: "stop_workers",
          leaseIds: state.workerLeases.map((lease) => lease.id),
        },
      ]);

    case "run_completed":
      if (state.runtime.phase !== "running" || !allTasksCompleted(state)) {
        return reject("run still has incomplete tasks");
      }
      state.runtime.phase = "completed";
      return accept();

    case "run_blocked":
      state.runtime.phase = "blocked";
      state.runtime.terminalReason = event.reason;
      return accept();
  }
}

export const reduceRunEvent = transition;

function closeReworkAttempt(
  attempt: CanonicalRunState["integrationAttempts"][number],
): CanonicalRunState["integrationAttempts"][number] {
  if (attempt.phase === "preparing") {
    const { phase: _, ...base } = attempt;
    return { ...base, phase: "completed", preparedCommitSha: "rework" };
  }
  if (attempt.phase === "paused") {
    const { resumePhase: _, ...base } = attempt;
    return {
      ...base,
      phase: "completed",
      preparedCommitSha:
        attempt.resumePhase === "preparing"
          ? "rework"
          : attempt.preparedCommitSha,
    };
  }
  return { ...attempt, phase: "completed" };
}

function resumeIntegrationAttempt(
  attempt: Extract<
    CanonicalRunState["integrationAttempts"][number],
    { phase: "paused" }
  >,
): CanonicalRunState["integrationAttempts"][number] {
  if (attempt.resumePhase === "preparing") {
    const { resumePhase: _, ...base } = attempt;
    return { ...base, phase: "preparing" };
  }
  const { resumePhase: _, ...base } = attempt;
  return {
    ...base,
    phase: attempt.resumePhase,
    preparedCommitSha: attempt.preparedCommitSha,
  };
}

function updateIntegration(
  state: CanonicalRunState,
  attemptId: string,
  expectedPhase: "preparing" | "prepared",
  update: (
    attempt:
      | Extract<
          CanonicalRunState["integrationAttempts"][number],
          { phase: "preparing" }
        >
      | Extract<
          CanonicalRunState["integrationAttempts"][number],
          { phase: "prepared" }
        >,
  ) => CanonicalRunState["integrationAttempts"][number],
  accept: (effects?: SchedulerEffect[]) => SchedulerTransition,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const attempt = state.integrationAttempts.find(
    (entry) => entry.id === attemptId,
  );
  if (attempt?.phase !== expectedPhase) {
    return reject(`integration is not ${expectedPhase}`);
  }
  state.integrationAttempts = state.integrationAttempts.map((entry) =>
    entry.id === attemptId
      ? update(
          attempt as
            | Extract<
                CanonicalRunState["integrationAttempts"][number],
                { phase: "preparing" }
              >
            | Extract<
                CanonicalRunState["integrationAttempts"][number],
                { phase: "prepared" }
              >,
        )
      : entry,
  );
  return accept();
}

function isDependencyComplete(
  runtime: CanonicalRunState["runtime"]["tasks"][string] | undefined,
): boolean {
  return runtime?.phase === "completed";
}

function allTasksCompleted(state: CanonicalRunState): boolean {
  return Object.values(state.runtime.tasks).every(
    (task) => task.phase === "completed",
  );
}

export type SchedulerTaskStatus =
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
  | "stalled"
  | "failed"
  | "stopped";

export type SchedulerTask = {
  id: string;
  planIndex: number;
  title: string;
  status: SchedulerTaskStatus;
  dependsOn: string[];
  mode?: "serial" | "parallel";
  sourceBaseSha?: string;
  baseSha?: string;
  candidateBaseSha?: string;
  candidateSha?: string;
  candidateTree?: string;
  trustedCheckpoint?: string;
  discardedBundles: string[];
  worktreePath?: string;
  branchName?: string;
  taskCommitSha?: string;
  landedCommitSha?: string;
  activeAgentIds: string[];
  activeAgentRefs: AgentDisplayRef[];
  integrationAttempts: number;
  selfHealAttempts: number;
  lastReason?: string;
  approvedCommitMessage?: string;
  integrationLedger?: IntegrationLedger;
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
  return {
    runId: graph.runId,
    maxConcurrency,
    tasks: new Map(
      graph.nodes.map((node) => [
        node.id,
        {
          id: node.id,
          planIndex: node.planIndex,
          title: node.title,
          status: "pending",
          dependsOn: [...node.dependsOn],
          activeAgentIds: [],
          activeAgentRefs: [],
          discardedBundles: [],
          integrationAttempts: 0,
          selfHealAttempts: 0,
        },
      ]),
    ),
    landedOrder: [],
    phase: "scheduling",
  };
}

export function computeReadyTasks(run: SchedulerRun): string[] {
  return [...run.tasks.values()]
    .filter(
      (task) =>
        ["pending", "blocked", "needs_rework"].includes(task.status) &&
        task.dependsOn.every((id) =>
          legacyDependencyComplete(run.tasks.get(id)?.status),
        ),
    )
    .sort((left, right) => left.planIndex - right.planIndex)
    .map((task) => task.id);
}

export function anyActiveSerialTask(_run: SchedulerRun): boolean {
  return false;
}

export function countActiveCodingReviewing(run: SchedulerRun): number {
  return [...run.tasks.values()].filter(
    (task) => task.status === "coding" || task.status === "reviewing",
  ).length;
}

export function canStartTask(run: SchedulerRun, taskId: string): boolean {
  const task = run.tasks.get(taskId);
  return Boolean(
    task &&
    ["pending", "blocked", "ready", "needs_rework"].includes(task.status) &&
    countActiveCodingReviewing(run) < run.maxConcurrency &&
    task.dependsOn.every((id) =>
      legacyDependencyComplete(run.tasks.get(id)?.status),
    ),
  );
}

export function startTask(run: SchedulerRun, taskId: string): void {
  const task = run.tasks.get(taskId);
  if (!task || !canStartTask(run, taskId)) {
    return;
  }
  task.status = "coding";
  task.activeAgentIds = [];
  task.activeAgentRefs = [];
}

export function nextTaskToLand(run: SchedulerRun): string | undefined {
  if ([...run.tasks.values()].some((task) => task.status === "integrating")) {
    return undefined;
  }
  return [...run.tasks.values()]
    .filter(
      (task) =>
        task.status === "approved" &&
        task.dependsOn.every((id) =>
          legacyDependencyComplete(run.tasks.get(id)?.status),
        ),
    )
    .sort((left, right) => left.planIndex - right.planIndex)[0]?.id;
}

export function hasAnyTaskInFlight(run: SchedulerRun): boolean {
  return [...run.tasks.values()].some((task) =>
    ["coding", "reviewing", "integrating"].includes(task.status),
  );
}

export function allTasksTerminal(run: SchedulerRun): boolean {
  return [...run.tasks.values()].every((task) =>
    [
      "landed",
      "satisfied",
      "failed",
      "blocked",
      "stopped",
      "integration_failed",
      "stalled",
    ].includes(task.status),
  );
}

export function anyTaskFailedBlockedStopped(run: SchedulerRun): boolean {
  return [...run.tasks.values()].some((task) =>
    ["failed", "blocked", "stopped", "integration_failed", "stalled"].includes(
      task.status,
    ),
  );
}

export function getBlockedReason(
  task: SchedulerTask,
  run: SchedulerRun,
): string | undefined {
  if (!["pending", "blocked", "ready", "needs_rework"].includes(task.status)) {
    return undefined;
  }
  const waiting = task.dependsOn.filter(
    (id) => !legacyDependencyComplete(run.tasks.get(id)?.status),
  );
  if (waiting.length) {
    return `waiting for ${waiting.join(", ")}`;
  }
  return countActiveCodingReviewing(run) >= run.maxConcurrency
    ? "concurrency limit"
    : undefined;
}

function legacyDependencyComplete(
  status: SchedulerTaskStatus | undefined,
): boolean {
  return status === "landed" || status === "satisfied";
}
