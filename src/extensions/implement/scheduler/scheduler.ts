import { publicationPreparationId } from "../candidate-replay.js";
import {
  boundedRecoveryOutput,
  recoveryCycleSignature,
  type RecoveryAction,
  type RecoveryGateResult,
} from "../recovery/recovery.js";
import type { AnchoredWorkstreamReviewCompletion } from "../result-schemas.js";
import {
  applyAnchoredWorkstreamReview,
  applyInitialWorkstreamReview,
  retargetAnchoredReview,
  reviewKey,
  workstreamReviewState,
  type ReviewOutcome,
} from "../review.js";
import type { RunState } from "../store.js";

export type RuntimeWorkstream = RunState["candidates"][string]["workstream"];
type ProcessLease = RunState["processLeases"][string];
type RecoveryWorkspace = RunState["recoveryEpisodes"][string]["workspace"];

type ImplementationOutcome =
  | {
      kind: "candidate_ready";
      candidate: RunState["candidates"][string];
      checkpoints: Record<string, string>;
      satisfied: Record<string, string>;
    }
  | {
      kind: "satisfaction_claimed";
      candidate: RunState["candidates"][string];
      evidence: Record<string, string>;
    };

export type SchedulerEvent =
  | {
      kind: "workstreams_selected";
      now: string;
      baseShas: Record<string, string>;
    }
  | { kind: "planner_failed"; reason: string }
  | {
      kind: "implementation_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: ImplementationOutcome;
    }
  | { kind: "review_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "implementation_failed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      evidence: string;
      trustedCheckpoint?: string;
      trustedCandidate?: RunState["candidates"][string];
      workspace?: RunState["recoveryEpisodes"][string]["workspace"];
      executionFailure?: boolean;
    }
  | {
      kind: "effect_failed";
      effect: "review" | "reconciliation" | "publication";
      gateKind?: "hook";
      workstream: RuntimeWorkstream;
      leaseId: string;
      evidence: string;
      executionFailure?: boolean;
    }
  | { kind: "whole_plan_review_failed"; evidence: string }
  | { kind: "whole_plan_recovery_requested" }
  | { kind: "whole_plan_recovery_abandoned" }
  | { kind: "whole_plan_recovery_completed"; action: RecoveryAction }
  | { kind: "whole_plan_recovery_failed"; evidence: string }
  | {
      kind: "gate_recorded";
      workstream: RuntimeWorkstream;
      result: RecoveryGateResult;
      workspace: RecoveryWorkspace;
    }
  | {
      kind: "review_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: ReviewOutcome;
      projectionDebt?: RunState["projectionDebt"][number];
    }
  | { kind: "recovery_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "recovery_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      action: RecoveryAction;
      candidate?: RunState["candidates"][string];
      correction?: {
        fromCandidateId: string;
        changedPaths: string[];
        evidence: string;
      };
    }
  | {
      kind: "recovery_execution_failed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      error: string;
      now: string;
    }
  | {
      kind: "reconciliation_requested";
      workstream: RuntimeWorkstream;
      now: string;
    }
  | {
      kind: "satisfaction_reassessment_requested";
      workstream: Extract<RuntimeWorkstream, { kind: "source" }>;
      targetSha: string;
    }
  | {
      kind: "satisfaction_completed";
      workstream: Extract<RuntimeWorkstream, { kind: "source" }>;
      leaseId: string;
      targetSha: string;
      evidence: string;
      projectionDebt?: RunState["projectionDebt"][number];
    }
  | {
      kind: "repository_assessment_required";
      workstream: Extract<RuntimeWorkstream, { kind: "source" }>;
      leaseId: string;
      targetSha: string;
      evidence: string;
    }
  | {
      kind: "reconciliation_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome:
        | {
            kind: "prepared";
            evidence: string;
            workspace: RecoveryWorkspace;
          }
        | {
            kind:
              | "reconciliation_required"
              | "execution_failed"
              | "hook_rejected";
            evidence: string;
            command?: RecoveryGateResult["command"];
            workspace: RecoveryWorkspace;
          };
    }
  | {
      kind: "publication_preparation_recorded";
      preparation: RunState["publication"]["preparations"][string];
    }
  | {
      kind: "publication_intent_recorded";
      intent: RunState["publication"]["intents"][string];
    }
  | {
      kind: "publication_requested";
      workstream: RuntimeWorkstream;
      intentId: string;
      now: string;
    }
  | {
      kind: "publication_receipt_recorded";
      receipt: RunState["publication"]["receipts"][string];
    }
  | {
      kind: "publication_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      intentId: string;
      projectionDebt?: RunState["projectionDebt"][number];
    }
  | { kind: "whole_plan_review_requested" }
  | { kind: "overall_repair_queued"; repairId: string }
  | {
      kind: "whole_plan_review_completed";
      outcome:
        | {
            kind: "approved";
            evidence: string;
            reviewedTargetSha: string;
            reviewedTargetTreeSha: string;
          }
        | {
            kind: "changes_requested";
            repairId: string;
            candidate: RunState["candidates"][string];
            findings: Array<{
              summary: string;
              evidence: string;
              requiredChange: string;
              acceptanceCriteria: string[];
            }>;
            evidence: string;
            reviewedTargetSha: string;
            reviewedTargetTreeSha: string;
          }
        | {
            kind: "anchored";
            completion: AnchoredWorkstreamReviewCompletion;
            evidence: string;
            reviewedTargetSha: string;
            reviewedTargetTreeSha: string;
          };
    }
  | { kind: "process_abandoned"; leaseId: string }
  | {
      kind: "failure_requested";
      category: NonNullable<RunState["failure"]>["category"];
      reason: string;
      now: string;
    }
  | { kind: "run_failed" }
  | { kind: "run_completed"; targetSha: string; targetTreeSha: string }
  | {
      kind: "projection_debt_recorded";
      debt: RunState["projectionDebt"][number];
    }
  | { kind: "projection_debt_settled"; debtId: string };

export type SchedulerEffect =
  | {
      kind: "run_implementation";
      workstream: RuntimeWorkstream;
      leaseId: string;
    }
  | { kind: "run_review"; workstream: RuntimeWorkstream; leaseId: string }
  | {
      kind: "run_recovery";
      workstream: RuntimeWorkstream;
      leaseId: string;
      episodeId: string;
      independentlyEscalated: boolean;
    }
  | {
      kind: "run_reconciliation";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
    }
  | {
      kind: "run_publication";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
      intentId: string;
    }
  | { kind: "run_whole_plan_review" }
  | { kind: "run_whole_plan_recovery" }
  | { kind: "complete_whole_plan_run" }
  | { kind: "run_projection"; debtId: string };

export type SchedulerTransition = {
  state: RunState;
  effects: SchedulerEffect[];
  accepted: boolean;
  error?: string;
};

function hasCompletionReceipt(state: RunState, workstreamId: string): boolean {
  const workstream = state.workstreams.source[workstreamId];
  if (
    !workstream ||
    workstream.phase !== "completed" ||
    workstream.candidateId === undefined
  ) {
    return false;
  }
  return (
    Object.values(state.publication.receipts).some(
      (receipt) => receipt.candidateId === workstream.candidateId,
    ) ||
    Object.values(state.satisfaction.receipts).some(
      (receipt) => receipt.candidateId === workstream.candidateId,
    )
  );
}

export function selectReadyWorkstreams(state: RunState): string[] {
  return selectReadyRuntimeWorkstreams(state)
    .filter(
      (workstream): workstream is { kind: "source"; id: string } =>
        workstream.kind === "source",
    )
    .map((workstream) => workstream.id);
}

export function runtimeWorkstreams(state: RunState): RuntimeWorkstream[] {
  return [
    ...Object.values(state.workstreams.source).map((workstream) => ({
      kind: "source" as const,
      id: workstream.id,
    })),
    ...Object.values(state.workstreams.overall).map((workstream) => ({
      kind: "overall" as const,
      repairId: workstream.repairId,
    })),
  ];
}

export function selectReadyRuntimeWorkstreams(
  state: RunState,
): RuntimeWorkstream[] {
  const capacity = state.run.workerConcurrency - activeWorkerLeaseCount(state);
  if (capacity <= 0) {
    return [];
  }
  if (state.phase === "running") {
    return Object.values(state.workstreams.source)
      .filter(
        (workstream) =>
          workstream.phase === "queued" &&
          workstream.dependsOn.every((dependency) =>
            hasCompletionReceipt(state, dependency),
          ),
      )
      .slice(0, capacity)
      .map((workstream) => ({ kind: "source" as const, id: workstream.id }));
  }
  if (
    state.phase === "whole_plan_review" &&
    allSourceWorkstreamsComplete(state)
  ) {
    return Object.values(state.workstreams.overall)
      .filter((workstream) => workstream.phase === "queued")
      .slice(0, capacity)
      .map((workstream) => ({
        kind: "overall" as const,
        repairId: workstream.repairId,
      }));
  }
  return [];
}

function failRun(
  state: RunState,
  category: NonNullable<RunState["failure"]>["category"],
  reason: string,
  at: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  if (
    state.phase !== "planning" &&
    state.phase !== "running" &&
    state.phase !== "whole_plan_review"
  ) {
    return reject("only an active run can enter orderly failure");
  }
  state.failure = { category, reason, originPhase: state.phase, at };
  if (state.wholePlanReview.recovery?.status === "running") {
    state.wholePlanReview.recovery.status = "open";
  }
  state.phase = "stopping";
  return { state, effects: [], accepted: true };
}

export function reduceRunEvent(
  input: RunState,
  event: SchedulerEvent,
): SchedulerTransition {
  const state = structuredClone(input);
  const reject = (error: string): SchedulerTransition => ({
    state: input,
    effects: [],
    accepted: false,
    error,
  });
  const accept = (effects: SchedulerEffect[] = []): SchedulerTransition => ({
    state,
    effects,
    accepted: true,
  });

  if (state.phase === "failed" || state.phase === "completed") {
    return reject("terminal runs do not accept lifecycle events");
  }
  if (state.phase === "stopping" && !isStoppingSettlementEvent(event)) {
    return reject("stopping runs only settle owned processes");
  }

  switch (event.kind) {
    case "planner_failed":
      if (state.phase !== "planning") {
        return reject("only a planning run can retain a planner failure");
      }
      return failRun(
        state,
        "runtime",
        event.reason,
        new Date().toISOString(),
        reject,
      );

    case "workstreams_selected": {
      if (hasIntegrationLease(state)) {
        return reject(
          "implementation cannot start while integration owns the target",
        );
      }
      const ready = selectReadyRuntimeWorkstreams(state);
      const effects: SchedulerEffect[] = [];
      for (const [index, workstream] of ready.entries()) {
        if (workstream.kind === "source") {
          const runtime = state.workstreams.source[workstream.id]!;
          const assignedBase = runtime.baseSha ?? event.baseShas[workstream.id];
          if (!assignedBase) {
            return reject("source workstream requires a captured runtime base");
          }
          if (
            runtime.baseSha !== undefined &&
            event.baseShas[workstream.id] !== undefined &&
            event.baseShas[workstream.id] !== runtime.baseSha
          ) {
            return reject("workstream runtime base is immutable");
          }
          const staleSatisfactionDependency = runtime.dependsOn.some(
            (dependencyId) => {
              const dependency = state.workstreams.source[dependencyId];
              const receipts = Object.values(
                state.satisfaction.receipts,
              ).filter(
                (receipt) => receipt.candidateId === dependency?.candidateId,
              );
              return (
                receipts.length > 0 &&
                !receipts.some(
                  (receipt) => receipt.assessedTargetSha === assignedBase,
                )
              );
            },
          );
          if (staleSatisfactionDependency) {
            return reject(
              "a dependency satisfaction receipt is stale for the assigned target base",
            );
          }
          runtime.baseSha = assignedBase;
        }
        const lease = createLease(
          state,
          workstream,
          "implementation",
          event.now,
          index,
        );
        state.processLeases[lease.id] = lease;
        getWorkstream(state, workstream)!.phase = "implementing";
        effects.push({
          kind: "run_implementation",
          workstream,
          leaseId: lease.id,
        });
      }
      return accept(effects);
    }

    case "implementation_failed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "implementation",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (!lease || !workstream || workstream.phase !== "implementing") {
        return reject("implementation failure does not own an active lease");
      }
      delete state.processLeases[lease.id];
      try {
        const priorEpisode = openRecoveryEpisodeForWorkstream(
          state,
          event.workstream,
        );
        if (
          event.trustedCandidate &&
          priorEpisode &&
          priorEpisode.candidateId !== event.trustedCandidate.id
        ) {
          priorEpisode.status = "completed";
        }
        if (event.trustedCandidate) {
          if (
            !sameWorkstream(
              event.trustedCandidate.workstream,
              event.workstream,
            ) ||
            (event.workstream.kind === "source" &&
              event.trustedCandidate.baseSha !==
                state.workstreams.source[event.workstream.id]?.baseSha) ||
            event.trustedCandidate.commitSha !== event.trustedCheckpoint
          ) {
            return reject(
              "Implementation checkpoint does not match its workstream boundary.",
            );
          }
          const existing = state.candidates[event.trustedCandidate.id];
          if (
            existing &&
            JSON.stringify(existing) !== JSON.stringify(event.trustedCandidate)
          ) {
            return reject("candidate identity is immutable");
          }
          state.candidates[event.trustedCandidate.id] = event.trustedCandidate;
          workstream.candidateId = event.trustedCandidate.id;
        }
        const failureCandidateId =
          event.trustedCandidate?.id ?? workstream.candidateId;
        recordGateResult(
          state,
          event.workstream,
          {
            id: `environment:${workstreamId(event.workstream)}:${state.gates.length + 1}`,
            kind: "environment",
            owner: workstreamId(event.workstream),
            ...(failureCandidateId ? { candidateId: failureCandidateId } : {}),
            attempt: state.gates.length + 1,
            outcome: "failed",
            evidence: event.evidence.slice(0, 12_000),
            outstandingFindingIds: [],
          },
          event.workspace ?? {
            id: workstreamId(event.workstream),
            ...(event.trustedCheckpoint
              ? { checkpoint: event.trustedCheckpoint }
              : {}),
            changedPaths: [],
            stateEvidence: event.evidence.slice(0, 12_000),
          },
          event.executionFailure ? 1 : 0,
        );
        return accept();
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
    }

    case "effect_failed": {
      const lease = state.processLeases[event.leaseId];
      const workstream = getWorkstream(state, event.workstream);
      const expectedKind =
        event.effect === "review"
          ? "review"
          : event.effect === "reconciliation"
            ? "reconciliation"
            : "publication";
      if (
        !lease ||
        lease.kind !== expectedKind ||
        !sameWorkstream(lease.workstream, event.workstream) ||
        !workstream
      ) {
        return reject("failed effect does not own its active lease");
      }
      const candidateId = workstream.candidateId;
      delete state.processLeases[lease.id];
      try {
        recordGateResult(
          state,
          event.workstream,
          {
            id: `${event.gateKind === "hook" ? "hook" : `environment:${event.effect}`}:${workstreamId(event.workstream)}:${state.gates.length + 1}`,
            kind: event.gateKind === "hook" ? "hook" : "environment",
            owner: workstreamId(event.workstream),
            ...(candidateId ? { candidateId } : {}),
            attempt: state.gates.length + 1,
            outcome: "failed",
            evidence: boundedRecoveryOutput(event.evidence),
            outstandingFindingIds: [],
          },
          recoveryWorkspace(state, event.workstream, candidateId),
          event.executionFailure ? 1 : 0,
        );
        return accept();
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
    }

    case "whole_plan_review_failed":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing"
      ) {
        return reject(
          "whole-plan failure is not owned by an active assessment",
        );
      }
      const priorRecovery = state.wholePlanReview.recovery;
      const recovery = {
        status: "open" as const,
        evidence: [
          ...(priorRecovery?.evidence ?? []),
          boundedRecoveryOutput(event.evidence),
        ],
        executionFailures: (priorRecovery?.executionFailures ?? 0) + 1,
        actions: priorRecovery?.actions ?? [],
      };
      state.wholePlanReview = {
        status: "pending",
        ...(state.wholePlanReview.epoch
          ? { epoch: state.wholePlanReview.epoch }
          : {}),
        recovery,
      };
      if (recovery.executionFailures >= 3) {
        return failRun(
          state,
          "recovery_exhausted",
          "Whole-plan reviewer failed three consecutive times.",
          new Date().toISOString(),
          reject,
        );
      }
      return accept();

    case "whole_plan_recovery_requested":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.recovery?.status !== "open"
      ) {
        return reject("whole-plan recovery is not ready to run");
      }
      state.wholePlanReview.recovery.status = "running";
      return accept([{ kind: "run_whole_plan_recovery" }]);

    case "whole_plan_recovery_abandoned":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.recovery?.status !== "running"
      ) {
        return reject("whole-plan recovery has no interrupted owner");
      }
      state.wholePlanReview.recovery.status = "open";
      return accept();

    case "whole_plan_recovery_completed": {
      const recovery = state.wholePlanReview.recovery;
      if (
        state.phase !== "whole_plan_review" ||
        recovery?.status !== "running" ||
        !["retry", "diagnose", "no_safe_action"].includes(event.action.kind)
      ) {
        return reject("whole-plan recovery does not own an active failure");
      }
      recovery.actions.push(event.action);
      recovery.executionFailures = 0;
      if (event.action.kind === "no_safe_action") {
        recovery.status = "completed";
        return failRun(
          state,
          "recovery_exhausted",
          event.action.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      if (event.action.kind === "retry") {
        recovery.status = "completed";
        return accept();
      }
      recovery.status = "open";
      return accept();
    }

    case "whole_plan_recovery_failed": {
      const recovery = state.wholePlanReview.recovery;
      if (
        state.phase !== "whole_plan_review" ||
        recovery?.status !== "running"
      ) {
        return reject("whole-plan recovery failure has no active owner");
      }
      recovery.evidence.push(boundedRecoveryOutput(event.evidence));
      recovery.executionFailures++;
      recovery.status = "open";
      if (recovery.executionFailures >= 3) {
        return failRun(
          state,
          "recovery_exhausted",
          "Whole-plan recovery worker failed three consecutive times.",
          new Date().toISOString(),
          reject,
        );
      }
      return accept();
    }

    case "implementation_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "implementation",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "implementing" ||
        (!processIsAllowed(state, event.workstream) &&
          state.phase !== "stopping")
      ) {
        return reject("implementation result does not own an active lease");
      }
      if (
        event.workstream.kind === "source" &&
        !sourceTaskOutcomeIsComplete(state, event.workstream, event.outcome)
      ) {
        return reject(
          "implementation outcome does not cover its source workstream",
        );
      }
      if (event.outcome.kind === "candidate_ready") {
        if (
          !sameWorkstream(event.outcome.candidate.workstream, event.workstream)
        ) {
          return reject("candidate belongs to a different workstream");
        }
        const existing = state.candidates[event.outcome.candidate.id];
        if (
          existing &&
          JSON.stringify(existing) !== JSON.stringify(event.outcome.candidate)
        ) {
          return reject("candidate identity is immutable");
        }
        state.candidates[event.outcome.candidate.id] = event.outcome.candidate;
        if (event.workstream.kind === "overall") {
          const review = workstreamReviewState(state, event.workstream);
          if (review) {
            try {
              state.reviews[reviewKey(event.workstream)] =
                retargetAnchoredReview({
                  state: review,
                  candidateId: event.outcome.candidate.id,
                  correction: {
                    fromCandidateId: review.candidateId,
                    changedPaths:
                      event.outcome.candidate.implementationEvidence
                        ?.changedPaths ?? [],
                    evidence:
                      event.outcome.candidate.implementationEvidence
                        ?.artifactPath ??
                      "Overall repair candidate was checkpointed.",
                  },
                });
            } catch (error) {
              return reject(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
        workstream.candidateId = event.outcome.candidate.id;
        if (event.workstream.kind === "source") {
          const sourceWorkstream =
            state.workstreams.source[event.workstream.id]!;
          for (const taskId of sourceWorkstream.taskIds) {
            const checkpoint = event.outcome.checkpoints[taskId];
            state.tasks[taskId] = checkpoint
              ? {
                  workstreamId: taskIdOwner(state, taskId),
                  phase: "checkpointed",
                  checkpoint,
                }
              : {
                  workstreamId: taskIdOwner(state, taskId),
                  phase: "satisfaction_claimed",
                  evidence: event.outcome.satisfied[taskId]!,
                };
          }
        }
        workstream.phase = "candidate_ready";
      } else {
        if (
          event.workstream.kind !== "source" ||
          !sameWorkstream(event.outcome.candidate.workstream, event.workstream)
        ) {
          return reject("only source workstreams can claim satisfaction");
        }
        const existing = state.candidates[event.outcome.candidate.id];
        if (
          existing &&
          JSON.stringify(existing) !== JSON.stringify(event.outcome.candidate)
        ) {
          return reject("candidate identity is immutable");
        }
        state.candidates[event.outcome.candidate.id] = event.outcome.candidate;
        workstream.candidateId = event.outcome.candidate.id;
        const sourceWorkstream = state.workstreams.source[event.workstream.id]!;
        for (const taskId of sourceWorkstream.taskIds) {
          state.tasks[taskId] = {
            workstreamId: taskIdOwner(state, taskId),
            phase: "satisfaction_claimed",
            evidence: event.outcome.evidence[taskId]!,
          };
        }
        workstream.phase = "candidate_ready";
      }
      delete state.processLeases[lease.id];
      for (const episode of Object.values(state.recoveryEpisodes)) {
        if (
          episode.status === "open" &&
          sameWorkstream(episode.workstream, event.workstream)
        ) {
          episode.status = "completed";
        }
      }
      return accept();
    }

    case "review_requested":
      return startProcess(state, event.workstream, "review", event.now, reject);

    case "gate_recorded":
      try {
        recordGateResult(
          state,
          event.workstream,
          event.result,
          event.workspace,
        );
        return accept();
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }

    case "review_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "review",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "reviewing" ||
        lease.candidateId !== workstream.candidateId ||
        lease.candidateId !== event.outcome.candidateId ||
        !state.candidates[event.outcome.candidateId] ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("review result does not own the current candidate lease");
      }
      const key = reviewKey(event.workstream);
      const assessedTargetSha =
        event.outcome.kind === "repository_state"
          ? event.outcome.assessedTargetSha
          : undefined;
      const assessment = assessedTargetSha
        ? Object.values(state.satisfaction.assessments).find(
            (entry) =>
              entry.status === "pending" &&
              entry.candidateId === event.outcome.candidateId &&
              entry.targetSha === assessedTargetSha &&
              sameWorkstream(entry.workstream, event.workstream),
          )
        : undefined;
      if (event.outcome.kind === "repository_state" && !assessment) {
        return reject(
          "repository-state review does not own a pending assessment",
        );
      }
      try {
        if (event.outcome.kind === "initial") {
          if (state.reviews[key]) {
            return reject(
              "initial review cannot replace an existing review epoch",
            );
          }
          const update = applyInitialWorkstreamReview({
            workstream: event.workstream,
            candidateId: event.outcome.candidateId,
            completion: event.outcome.completion,
            evidence: event.outcome.evidence,
          });
          state.reviews[key] = update.review;
          for (const finding of update.findings) {
            state.findings[finding.id] = finding;
          }
        } else if (event.outcome.kind === "repository_state") {
          const review = workstreamReviewState(state, event.workstream);
          if (!review || review.candidateId !== event.outcome.candidateId) {
            return reject(
              "repository-state review is not bound to its candidate",
            );
          }
          const findings =
            event.outcome.completion.verdict === "changes_requested"
              ? event.outcome.completion.findings.map((finding, index) => ({
                  ...finding,
                  id: `${reviewKey(event.workstream).replace(":", "-")}-repository-${review.round + 1}-${index + 1}`,
                  candidateId: event.outcome.candidateId,
                  workstream: event.workstream,
                  origin: "regression" as const,
                  introducedRound: review.round + 1,
                  status: "open" as const,
                }))
              : [];
          state.reviews[key] = {
            ...review,
            round: review.round + 1,
            outstandingIds: findings.map((finding) => finding.id),
            evidence: [...review.evidence, event.outcome.evidence],
          };
          for (const finding of findings) {
            state.findings[finding.id] = finding;
          }
          assessment!.status = findings.length === 0 ? "approved" : "rejected";
        } else {
          const review = workstreamReviewState(state, event.workstream);
          if (!review || review.candidateId !== event.outcome.candidateId) {
            return reject(
              "anchored review is not bound to the current review epoch",
            );
          }
          const update = applyAnchoredWorkstreamReview({
            state: review,
            workstream: event.workstream,
            completion: event.outcome.completion,
            findings: Object.values(state.findings).filter((finding) =>
              sameWorkstream(finding.workstream, event.workstream),
            ),
            evidence: event.outcome.evidence,
          });
          state.reviews[key] = update.review;
          for (const finding of update.findings) {
            state.findings[finding.id] = finding;
          }
        }
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
      delete state.processLeases[lease.id];
      const outstandingFindingIds = state.reviews[key]!.outstandingIds;
      recordGateResult(
        state,
        event.workstream,
        {
          id: `review:${workstreamId(event.workstream)}:${event.outcome.candidateId}:${state.reviews[key]!.round + 1}`,
          kind: "review",
          owner: workstreamId(event.workstream),
          candidateId: event.outcome.candidateId,
          attempt: state.reviews[key]!.round + 1,
          outcome: outstandingFindingIds.length > 0 ? "failed" : "passed",
          evidence: event.outcome.evidence,
          outstandingFindingIds,
        },
        recoveryWorkspace(state, event.workstream, event.outcome.candidateId),
      );
      if (outstandingFindingIds.length > 0) {
        workstream.phase = "recovering";
        return accept();
      }
      if (event.outcome.kind === "repository_state") {
        if (event.workstream.kind !== "source") {
          return reject(
            "only source workstreams may record satisfaction receipts",
          );
        }
        const receiptId = `satisfaction:${event.outcome.candidateId}:${event.outcome.assessedTargetSha}`;
        state.satisfaction.receipts[receiptId] = {
          id: receiptId,
          candidateId: event.outcome.candidateId,
          workstream: event.workstream,
          assessedTargetSha: event.outcome.assessedTargetSha,
          evidence: event.outcome.evidence,
          assessedAt: new Date().toISOString(),
        };
        workstream.phase = "completed";
        if (
          event.projectionDebt &&
          !state.projectionDebt.some(
            (debt) => debt.id === event.projectionDebt!.id,
          )
        ) {
          state.projectionDebt.push(event.projectionDebt);
        }
        return accept(
          event.projectionDebt
            ? [{ kind: "run_projection", debtId: event.projectionDebt.id }]
            : [],
        );
      }
      approveWorkstream(state, event.workstream);
      return accept();
    }

    case "recovery_requested":
      return startRecoveryProcess(state, event.workstream, event.now, reject);

    case "recovery_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "recovery",
      );
      const workstream = getWorkstream(state, event.workstream);
      const episode = lease?.recoveryEpisodeId
        ? state.recoveryEpisodes[lease.recoveryEpisodeId]
        : undefined;
      if (
        !lease ||
        !episode ||
        !workstream ||
        workstream.phase !== "recovering" ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("recovery result does not own an active episode lease");
      }
      if (event.action.kind === "no_safe_action") {
        if (event.action.outcome !== "no_safe_action") {
          return reject(
            "no-safe-action recovery must report a no-safe-action outcome",
          );
        }
        episode.cycle = {
          signature: recoverySignatureFor(state, episode, "no_safe_action"),
          identicalNoActionCycles: episode.cycle.identicalNoActionCycles + 1,
          independentlyEscalated: true,
        };
        episode.actions.push(event.action);
        episode.executionFailures = 0;
        delete state.processLeases[lease.id];
        episode.status = "completed";
        return failRun(
          state,
          "recovery_exhausted",
          event.action.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      if (event.action.outcome !== "completed") {
        return reject("completed recovery requires a completed safe action");
      }
      const trackedAction = ["rework_candidate", "reconcile"].includes(
        event.action.kind,
      );
      if (Boolean(event.candidate) !== trackedAction) {
        return reject(
          "tracked recovery changes require a new candidate, and runtime repair must retain the candidate",
        );
      }
      if (event.candidate) {
        if (!sameWorkstream(event.candidate.workstream, event.workstream)) {
          return reject("recovery candidate belongs to a different workstream");
        }
        const existing = state.candidates[event.candidate.id];
        if (
          existing &&
          JSON.stringify(existing) !== JSON.stringify(event.candidate)
        ) {
          return reject("candidate identity is immutable");
        }
        const review = workstreamReviewState(state, event.workstream);
        if (review) {
          if (!event.correction) {
            return reject(
              "tracked rework requires an anchored correction delta",
            );
          }
          state.reviews[reviewKey(event.workstream)] = retargetAnchoredReview({
            state: review,
            candidateId: event.candidate.id,
            correction: event.correction,
          });
        } else if (event.correction) {
          return reject("a correction delta requires an existing review epoch");
        }
        state.candidates[event.candidate.id] = event.candidate;
        workstream.candidateId = event.candidate.id;
        if (event.workstream.kind === "source") {
          for (const taskId of state.workstreams.source[event.workstream.id]!
            .taskIds) {
            const task = state.tasks[taskId]!;
            if (task.phase === "satisfaction_claimed") {
              state.tasks[taskId] = {
                workstreamId: task.workstreamId,
                phase: "checkpointed",
                checkpoint: event.candidate.commitSha,
              };
            }
          }
        }
        workstream.phase = "candidate_ready";
      }
      episode.actions.push(event.action);
      episode.executionFailures = 0;
      episode.cycle = {
        signature: recoverySignatureFor(
          state,
          episode,
          "retry",
          event.action.evidence,
        ),
        identicalNoActionCycles: 0,
        independentlyEscalated: false,
      };
      delete state.processLeases[lease.id];
      if (event.candidate) {
        episode.status = "completed";
        return accept();
      }
      if (event.action.kind === "diagnose") {
        return accept();
      }
      workstream.phase = retryPhaseForGate(episode.gateId);
      return accept();
    }

    case "recovery_execution_failed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "recovery",
      );
      const episode = lease?.recoveryEpisodeId
        ? state.recoveryEpisodes[lease.recoveryEpisodeId]
        : undefined;
      if (!lease || !episode) {
        return reject(
          "worker execution failure does not own an active recovery episode",
        );
      }
      const executionFailures = episode.executionFailures + 1;
      episode.executionFailures = executionFailures;
      episode.actions.push({
        kind: "retry",
        outcome: "execution_failure",
        summary: "Recovery worker failed before a successful model turn.",
        evidence: event.error,
        at: event.now,
      });
      delete state.processLeases[lease.id];
      if (executionFailures >= 3) {
        episode.status = "completed";
        return failRun(
          state,
          "recovery_exhausted",
          "Recovery worker failed three consecutive times after Pi retries settled.",
          event.now,
          reject,
        );
      }
      return accept();
    }

    case "satisfaction_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "reconciliation",
      );
      const workstream = state.workstreams.source[event.workstream.id];
      const candidateId = workstream?.candidateId;
      const candidate = candidateId ? state.candidates[candidateId] : undefined;
      if (
        !lease ||
        !workstream ||
        !candidate ||
        workstream.phase !== "reconciling" ||
        candidate.commitSha !== candidate.baseSha ||
        candidate.baseSha !== event.targetSha
      ) {
        return reject(
          "satisfaction completion does not own a current candidate",
        );
      }
      const assessmentId = `assessment:${candidate.id}:${event.targetSha}`;
      state.satisfaction.assessments[assessmentId] = {
        id: assessmentId,
        candidateId: candidate.id,
        workstream: event.workstream,
        historicalBaseSha: candidate.baseSha,
        targetSha: event.targetSha,
        evidence: event.evidence,
        status: "approved",
      };
      const receiptId = `satisfaction:${candidate.id}:${event.targetSha}`;
      state.satisfaction.receipts[receiptId] = {
        id: receiptId,
        candidateId: candidate.id,
        workstream: event.workstream,
        assessedTargetSha: event.targetSha,
        evidence: event.evidence,
        assessedAt: new Date().toISOString(),
      };
      delete state.processLeases[lease.id];
      workstream.phase = "completed";
      if (
        event.projectionDebt &&
        !state.projectionDebt.some(
          (debt) => debt.id === event.projectionDebt!.id,
        )
      ) {
        state.projectionDebt.push(event.projectionDebt);
      }
      return accept(
        event.projectionDebt
          ? [{ kind: "run_projection", debtId: event.projectionDebt.id }]
          : [],
      );
    }

    case "repository_assessment_required": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "reconciliation",
      );
      const workstream = state.workstreams.source[event.workstream.id];
      const candidateId = workstream?.candidateId;
      const candidate = candidateId ? state.candidates[candidateId] : undefined;
      if (
        !lease ||
        !workstream ||
        !candidate ||
        workstream.phase !== "reconciling" ||
        candidate.commitSha !== candidate.baseSha
      ) {
        return reject(
          "repository assessment does not own a satisfied candidate",
        );
      }
      const assessmentId = `assessment:${candidate.id}:${event.targetSha}`;
      const existing = state.satisfaction.assessments[assessmentId];
      if (
        existing &&
        JSON.stringify(existing) !==
          JSON.stringify({
            id: assessmentId,
            candidateId: candidate.id,
            workstream: event.workstream,
            historicalBaseSha: candidate.baseSha,
            targetSha: event.targetSha,
            evidence: event.evidence,
            status: "pending",
          })
      ) {
        return reject("repository assessment identity is immutable");
      }
      state.satisfaction.assessments[assessmentId] = {
        id: assessmentId,
        candidateId: candidate.id,
        workstream: event.workstream,
        historicalBaseSha: candidate.baseSha,
        targetSha: event.targetSha,
        evidence: event.evidence,
        status: "pending",
      };
      delete state.processLeases[lease.id];
      workstream.phase = "candidate_ready";
      return accept();
    }

    case "satisfaction_reassessment_requested": {
      const workstream = state.workstreams.source[event.workstream.id];
      const candidateId = workstream?.candidateId;
      const candidate = candidateId ? state.candidates[candidateId] : undefined;
      if (
        !workstream ||
        !candidate ||
        workstream.phase !== "completed" ||
        candidate.commitSha !== candidate.baseSha ||
        !Object.values(state.satisfaction.receipts).some(
          (receipt) => receipt.candidateId === candidate.id,
        ) ||
        Object.values(state.satisfaction.receipts).some(
          (receipt) =>
            receipt.candidateId === candidate.id &&
            receipt.assessedTargetSha === event.targetSha,
        )
      ) {
        return reject("satisfaction receipt is not eligible for reassessment");
      }
      const assessmentId = `assessment:${candidate.id}:${event.targetSha}`;
      state.satisfaction.assessments[assessmentId] = {
        id: assessmentId,
        candidateId: candidate.id,
        workstream: event.workstream,
        historicalBaseSha: candidate.baseSha,
        targetSha: event.targetSha,
        evidence:
          "A later target publication made the satisfaction receipt stale.",
        status: "pending",
      };
      workstream.phase = "candidate_ready";
      return accept();
    }

    case "reconciliation_requested":
      return startReconciliation(state, event.workstream, event.now, reject);

    case "reconciliation_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "reconciliation",
      );
      const workstream = getWorkstream(state, event.workstream);
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "reconciling" ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("reconciliation result does not own an active lease");
      }
      const candidateId = workstream.candidateId;
      if (!candidateId) {
        return reject("reconciliation requires an approved candidate");
      }
      if (event.outcome.kind === "prepared") {
        try {
          recordGateResult(
            state,
            event.workstream,
            {
              id: `reconciliation:${workstreamId(event.workstream)}:${candidateId}:${state.gates.length + 1}`,
              kind: "reconciliation",
              owner: workstreamId(event.workstream),
              candidateId,
              attempt: state.gates.length + 1,
              outcome: "passed",
              evidence: event.outcome.evidence,
              outstandingFindingIds: [],
            },
            event.outcome.workspace,
          );
          const intent = Object.values(state.publication.intents).find(
            (entry) =>
              entry.candidateId === candidateId &&
              sameWorkstream(entry.workstream, event.workstream),
          );
          if (!intent) {
            return reject(
              "prepared reconciliation requires a durable publication intent",
            );
          }
          state.processLeases[lease.id] = {
            ...lease,
            kind: "publication",
            publicationIntentId: intent.id,
          };
          workstream.phase = "publishing";
          return accept([
            {
              kind: "run_publication",
              workstream: event.workstream,
              leaseId: lease.id,
              candidateId,
              intentId: intent.id,
            },
          ]);
        } catch (error) {
          return reject(error instanceof Error ? error.message : String(error));
        }
      }
      try {
        delete state.processLeases[lease.id];
        recordGateResult(
          state,
          event.workstream,
          {
            id: `${event.outcome.kind === "hook_rejected" ? "hook" : event.outcome.kind === "execution_failed" ? "environment:reconciliation" : "reconciliation"}:${workstreamId(event.workstream)}:${candidateId}:${state.gates.length + 1}`,
            kind:
              event.outcome.kind === "hook_rejected"
                ? "hook"
                : event.outcome.kind === "execution_failed"
                  ? "environment"
                  : "reconciliation",
            owner: workstreamId(event.workstream),
            candidateId,
            attempt: state.gates.length + 1,
            outcome: "failed",
            evidence: event.outcome.evidence,
            ...(event.outcome.command
              ? { command: event.outcome.command }
              : {}),
            outstandingFindingIds: [],
          },
          recoveryWorkspace(
            state,
            event.workstream,
            candidateId,
            event.outcome.workspace,
          ),
        );
        return accept();
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
    }

    case "publication_preparation_recorded": {
      const candidate = state.candidates[event.preparation.candidateId];
      const existing = state.publication.preparations[event.preparation.id];
      if (
        !candidate ||
        event.preparation.id !==
          publicationPreparationId({
            runId: state.run.id,
            candidateId: event.preparation.candidateId,
            candidateCommitSha: event.preparation.candidateCommitSha,
            targetBaseSha: event.preparation.targetBaseSha,
          }) ||
        candidate.commitSha !== event.preparation.candidateCommitSha ||
        (event.preparation.disposition === "same_base" &&
          event.preparation.targetBaseSha !== candidate.baseSha) ||
        (event.preparation.disposition === "clean_non_overlap" &&
          event.preparation.targetBaseSha === candidate.baseSha) ||
        event.preparation.targetRef !== state.run.checkout.branchRef ||
        (existing &&
          JSON.stringify(existing) !== JSON.stringify(event.preparation))
      ) {
        return reject(
          "publication preparation is not immutable candidate replay",
        );
      }
      state.publication.preparations[event.preparation.id] = event.preparation;
      return accept();
    }

    case "publication_intent_recorded": {
      const candidate = state.candidates[event.intent.candidateId];
      const preparation =
        state.publication.preparations[event.intent.preparationId];
      if (
        !candidate ||
        !preparation ||
        !sameWorkstream(candidate.workstream, event.intent.workstream) ||
        getWorkstream(state, event.intent.workstream)?.candidateId !==
          candidate.id ||
        preparation.candidateId !== candidate.id ||
        preparation.targetBaseSha !== event.intent.targetBaseSha ||
        preparation.preparedCommitSha !== event.intent.preparedCommitSha ||
        preparation.preparedTreeSha !== event.intent.preparedTreeSha ||
        preparation.targetRef !== event.intent.targetRef
      ) {
        return reject(
          "publication intent does not match its immutable preparation",
        );
      }
      const existing = state.publication.intents[event.intent.id];
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(event.intent)
      ) {
        return reject("publication intent is immutable");
      }
      state.publication.intents[event.intent.id] = event.intent;
      return accept();
    }

    case "publication_requested": {
      const intent = state.publication.intents[event.intentId];
      const workstream = getWorkstream(state, event.workstream);
      const candidate = intent && state.candidates[intent.candidateId];
      if (
        !intent ||
        !candidate ||
        !sameWorkstream(candidate.workstream, event.workstream) ||
        !workstream ||
        workstream.candidateId !== candidate.id ||
        workstream.phase !== "approved" ||
        !processIsAllowed(state, event.workstream) ||
        activeLeaseFor(state, event.workstream) ||
        activeWorkerLeaseCount(state) > 0 ||
        hasIntegrationLease(state)
      ) {
        return reject("workstream is not ready for its publication intent");
      }
      const lease = createLease(
        state,
        event.workstream,
        "publication",
        event.now,
        0,
      );
      state.processLeases[lease.id] = {
        ...lease,
        candidateId: candidate.id,
        publicationIntentId: intent.id,
      };
      workstream.phase = "publishing";
      return accept([
        {
          kind: "run_publication",
          workstream: event.workstream,
          leaseId: lease.id,
          candidateId: candidate.id,
          intentId: intent.id,
        },
      ]);
    }

    case "publication_receipt_recorded": {
      const intent = state.publication.intents[event.receipt.intentId];
      if (
        !intent ||
        intent.preparedCommitSha !== event.receipt.publishedCommitSha
      ) {
        return reject("publication receipt does not match its intent");
      }
      const existing = state.publication.receipts[event.receipt.intentId];
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(event.receipt)
      ) {
        return reject("publication receipt is immutable");
      }
      state.publication.receipts[event.receipt.intentId] = event.receipt;
      return accept();
    }

    case "publication_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "publication",
      );
      const workstream = getWorkstream(state, event.workstream);
      const intent = state.publication.intents[event.intentId];
      if (
        !lease ||
        !workstream ||
        workstream.phase !== "publishing" ||
        !processIsAllowed(state, event.workstream) ||
        !intent ||
        lease.publicationIntentId !== event.intentId ||
        lease.candidateId !== intent.candidateId ||
        workstream.candidateId !== intent.candidateId ||
        !state.publication.receipts[event.intentId] ||
        !sameWorkstream(
          state.candidates[intent.candidateId]?.workstream ?? event.workstream,
          event.workstream,
        )
      ) {
        return reject("publication result does not own a receipted intent");
      }
      delete state.processLeases[lease.id];
      workstream.phase = "completed";
      if (
        event.projectionDebt &&
        !state.projectionDebt.some(
          (debt) => debt.id === event.projectionDebt!.id,
        )
      ) {
        state.projectionDebt.push(event.projectionDebt);
      }
      if (event.workstream.kind === "overall") {
        const epoch = state.wholePlanReview.epoch;
        const candidate = state.candidates[intent.candidateId];
        const receipt = state.publication.receipts[event.intentId];
        const preparation =
          state.publication.preparations[intent.preparationId];
        if (!epoch || !candidate || !receipt || !preparation) {
          return reject("overall publication has no retained review epoch");
        }
        state.wholePlanReview = {
          status: "pending",
          epoch: {
            ...epoch,
            latestRepair: {
              candidateId: candidate.id,
              targetBaseSha: receipt.targetBaseSha,
              publishedCommitSha: receipt.publishedCommitSha,
              publishedTreeSha: receipt.publishedTreeSha,
              changedPaths: preparation.changedPaths,
            },
          },
          ...(state.wholePlanReview.recovery
            ? { recovery: state.wholePlanReview.recovery }
            : {}),
        };
      }
      return accept(
        event.projectionDebt
          ? [{ kind: "run_projection", debtId: event.projectionDebt.id }]
          : [],
      );
    }

    case "whole_plan_review_requested":
      if (
        !["running", "whole_plan_review"].includes(state.phase) ||
        state.wholePlanReview.status !== "pending" ||
        !allSourceWorkstreamsComplete(state)
      ) {
        return reject("whole-plan review is not ready to run");
      }
      state.phase = "whole_plan_review";
      state.wholePlanReview = {
        status: "reviewing",
        ...(state.wholePlanReview.epoch
          ? { epoch: state.wholePlanReview.epoch }
          : {}),
        ...(state.wholePlanReview.recovery
          ? { recovery: state.wholePlanReview.recovery }
          : {}),
      };
      return accept([{ kind: "run_whole_plan_review" }]);

    case "overall_repair_queued":
      return reject(
        "overall repairs require a reviewed baseline candidate and findings payload",
      );

    case "whole_plan_review_completed": {
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing" ||
        Object.values(state.workstreams.overall).some(
          (workstream) => workstream.phase !== "completed",
        )
      ) {
        return reject("whole-plan review cannot complete while repairs exist");
      }
      if (state.wholePlanReview.recovery) {
        state.wholePlanReview.recovery.executionFailures = 0;
      }
      if (event.outcome.kind === "approved") {
        if (state.wholePlanReview.epoch) {
          return reject("an anchored whole-plan review requires assessments");
        }
        state.wholePlanReview = {
          status: "approved",
          evidence: event.outcome.evidence,
          reviewedTargetSha: event.outcome.reviewedTargetSha,
          reviewedTargetTreeSha: event.outcome.reviewedTargetTreeSha,
          ...(state.wholePlanReview.recovery
            ? { recovery: state.wholePlanReview.recovery }
            : {}),
        };
        return accept();
      }
      if (event.outcome.kind === "anchored") {
        const epoch = state.wholePlanReview.epoch;
        if (
          !epoch?.latestRepair ||
          epoch.latestRepair.publishedCommitSha !==
            event.outcome.reviewedTargetSha ||
          epoch.latestRepair.publishedTreeSha !==
            event.outcome.reviewedTargetTreeSha
        ) {
          return reject(
            "anchored whole-plan review lost its published repair boundary",
          );
        }
        const expected = new Set(epoch.outstandingFindingIds);
        const assessments = new Map(
          event.outcome.completion.assessments.map((assessment) => [
            assessment.id,
            assessment,
          ]),
        );
        if (
          event.outcome.completion.assessments.length !== expected.size ||
          assessments.size !== expected.size ||
          [...expected].some((findingId) => !assessments.has(findingId))
        ) {
          return reject(
            "anchored whole-plan review must assess each outstanding finding exactly once",
          );
        }
        const changedPaths = new Set(epoch.latestRepair.changedPaths);
        const regressions = event.outcome.completion.regressions.filter(
          (finding) =>
            finding.changedPaths.some((path) => changedPaths.has(path)),
        );
        const assessedFindings = epoch.findings.map((finding) => {
          const assessment = expected.has(finding.id)
            ? assessments.get(finding.id)
            : undefined;
          return assessment
            ? { ...finding, evidence: assessment.evidence }
            : finding;
        });
        const unresolved = assessedFindings.filter(
          (finding) =>
            expected.has(finding.id) &&
            assessments.get(finding.id)?.status === "unresolved",
        );
        const nextFindings = [
          ...unresolved,
          ...regressions.map((finding, index) => ({
            id: `whole-plan-regression-${epoch.findings.length + index + 1}`,
            summary: finding.summary,
            evidence: finding.evidence,
            requiredChange: finding.requiredChange,
            acceptanceCriteria: finding.acceptanceCriteria,
          })),
        ];
        const nextEpoch = {
          ...epoch,
          findings: [
            ...assessedFindings,
            ...nextFindings.filter(
              (finding) =>
                !assessedFindings.some((known) => known.id === finding.id),
            ),
          ],
          outstandingFindingIds: nextFindings.map((finding) => finding.id),
        };
        if (nextFindings.length === 0) {
          state.wholePlanReview = {
            status: "approved",
            evidence: event.outcome.evidence,
            reviewedTargetSha: event.outcome.reviewedTargetSha,
            reviewedTargetTreeSha: event.outcome.reviewedTargetTreeSha,
            epoch: nextEpoch,
            ...(state.wholePlanReview.recovery
              ? { recovery: state.wholePlanReview.recovery }
              : {}),
          };
          return accept();
        }
        return queueWholePlanRepair(
          state,
          {
            repairId: nextOverallRepairId(state),
            targetSha: event.outcome.reviewedTargetSha,
            targetTreeSha: event.outcome.reviewedTargetTreeSha,
            findings: nextFindings,
            evidence: event.outcome.evidence,
            epoch: nextEpoch,
          },
          reject,
        );
      }
      const { repairId, candidate } = event.outcome;
      if (
        candidate.baseSha !== event.outcome.reviewedTargetSha ||
        candidate.commitSha !== event.outcome.reviewedTargetSha ||
        candidate.treeSha !== event.outcome.reviewedTargetTreeSha
      ) {
        return reject("whole-plan baseline does not match its reviewed target");
      }
      const initialFindings = event.outcome.findings.map((finding, index) => ({
        id: `overall-${repairId}-r${index + 1}`,
        ...finding,
      }));
      return queueWholePlanRepair(
        state,
        {
          repairId,
          targetSha: event.outcome.reviewedTargetSha,
          targetTreeSha: event.outcome.reviewedTargetTreeSha,
          candidate,
          findings: initialFindings,
          evidence: event.outcome.evidence,
          epoch: {
            initialTargetSha: event.outcome.reviewedTargetSha,
            initialTargetTreeSha: event.outcome.reviewedTargetTreeSha,
            originalFindingIds: initialFindings.map((finding) => finding.id),
            outstandingFindingIds: initialFindings.map((finding) => finding.id),
            findings: initialFindings,
          },
        },
        reject,
      );
    }

    case "process_abandoned": {
      const lease = state.processLeases[event.leaseId];
      if (!lease) {
        return reject("process lease does not exist");
      }
      const workstream = getWorkstream(state, lease.workstream);
      if (!workstream) {
        return reject("process lease references an unknown workstream");
      }
      delete state.processLeases[lease.id];
      workstream.phase = abandonedPhase(lease.kind);
      if (lease.kind === "recovery" && lease.recoveryEpisodeId) {
        const episode = state.recoveryEpisodes[lease.recoveryEpisodeId];
        if (episode?.status === "open") {
          episode.actions.push({
            kind: "retry",
            outcome: "interrupted",
            summary: "Recovery process settled without a completion result.",
            evidence:
              "The actor retained the candidate for the next live recovery attempt.",
            at: lease.acquiredAt,
          });
        }
      }
      return accept();
    }

    case "failure_requested":
      return failRun(state, event.category, event.reason, event.now, reject);

    case "run_failed":
      if (
        state.phase !== "stopping" ||
        Object.keys(state.processLeases).length > 0
      ) {
        return reject("run cannot fail before owned processes settle");
      }
      state.phase = "failed";
      return accept();

    case "run_completed":
      if (
        state.phase !== "whole_plan_review" ||
        !allSourceWorkstreamsComplete(state) ||
        Object.values(state.workstreams.overall).some(
          (workstream) => workstream.phase !== "completed",
        ) ||
        state.projectionDebt.length > 0 ||
        Object.keys(state.processLeases).length > 0 ||
        state.wholePlanReview.status !== "approved" ||
        state.wholePlanReview.reviewedTargetSha !== event.targetSha ||
        state.wholePlanReview.reviewedTargetTreeSha !== event.targetTreeSha ||
        Object.values(state.publication.intents).some(
          (intent) => !state.publication.receipts[intent.id],
        )
      ) {
        return reject("run still has incomplete workstreams or cleanup debt");
      }
      state.phase = "completed";
      return accept();

    case "projection_debt_recorded":
      if (!state.projectionDebt.some((debt) => debt.id === event.debt.id)) {
        state.projectionDebt.push(event.debt);
        return accept([{ kind: "run_projection", debtId: event.debt.id }]);
      }
      return accept();

    case "projection_debt_settled":
      if (!state.projectionDebt.some((debt) => debt.id === event.debtId)) {
        return reject("projection debt does not exist");
      }
      state.projectionDebt = state.projectionDebt.filter(
        (debt) => debt.id !== event.debtId,
      );
      return accept();
  }
}

type WholePlanEpoch = NonNullable<RunState["wholePlanReview"]["epoch"]>;
type WholePlanEpochFinding = WholePlanEpoch["findings"][number];

function nextOverallRepairId(state: RunState): string {
  let number = 1;
  while (state.workstreams.overall[`overall-repair-${number}`]) {
    number++;
  }
  return `overall-repair-${number}`;
}

function queueWholePlanRepair(
  state: RunState,
  args: {
    repairId: string;
    targetSha: string;
    targetTreeSha: string;
    candidate?: RunState["candidates"][string];
    findings: WholePlanEpochFinding[];
    evidence: string;
    epoch: WholePlanEpoch;
  },
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  if (
    !safeId(args.repairId) ||
    state.workstreams.overall[args.repairId] ||
    args.findings.length === 0
  ) {
    return reject("whole-plan findings have an invalid repair identity");
  }
  const workstream: RuntimeWorkstream = {
    kind: "overall",
    repairId: args.repairId,
  };
  const candidate =
    args.candidate ??
    ({
      id: `overall-baseline:${state.run.id}:${args.repairId}:${args.targetSha}`,
      workstream,
      baseSha: args.targetSha,
      commitSha: args.targetSha,
      treeSha: args.targetTreeSha,
    } satisfies RunState["candidates"][string]);
  if (
    !sameWorkstream(candidate.workstream, workstream) ||
    candidate.baseSha !== args.targetSha ||
    candidate.commitSha !== args.targetSha ||
    candidate.treeSha !== args.targetTreeSha
  ) {
    return reject("whole-plan findings have an invalid repair baseline");
  }
  const existing = state.candidates[candidate.id];
  if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
    return reject("overall baseline candidate identity is immutable");
  }
  state.candidates[candidate.id] = candidate;
  state.workstreams.overall[args.repairId] = {
    kind: "overall",
    repairId: args.repairId,
    phase: "queued",
    candidateId: candidate.id,
  };
  const update = applyInitialWorkstreamReview({
    workstream,
    candidateId: candidate.id,
    completion: {
      verdict: "changes_requested",
      findings: args.findings.map(({ id: _, ...finding }) => finding),
    },
    evidence: args.evidence,
  });
  state.reviews[reviewKey(workstream)] = update.review;
  for (const finding of update.findings) {
    state.findings[finding.id] = finding;
  }
  state.wholePlanReview = {
    status: "repairing",
    epoch: args.epoch,
    ...(state.wholePlanReview.recovery
      ? { recovery: state.wholePlanReview.recovery }
      : {}),
  };
  return { state, effects: [], accepted: true };
}

function startProcess(
  state: RunState,
  workstream: RuntimeWorkstream,
  kind: "review",
  now: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const current = getWorkstream(state, workstream);
  const allowed = kind === "review" && current?.phase === "candidate_ready";
  if (
    !allowed ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeWorkerLeaseCount(state) >= state.run.workerConcurrency ||
    hasIntegrationLease(state)
  ) {
    return reject("workstream is not ready for this process");
  }
  const lease = createLease(state, workstream, kind, now, 0);
  state.processLeases[lease.id] = lease;
  current!.phase = "reviewing";
  return {
    state,
    effects: [{ kind: "run_review", workstream, leaseId: lease.id }],
    accepted: true,
  };
}

function startRecoveryProcess(
  state: RunState,
  workstream: RuntimeWorkstream,
  now: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const current = getWorkstream(state, workstream);
  const episode = openRecoveryEpisodeForWorkstream(state, workstream);
  if (
    !current ||
    !episode ||
    episode.status !== "open" ||
    current.phase !== "recovering" ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeWorkerLeaseCount(state) >= state.run.workerConcurrency ||
    hasIntegrationLease(state)
  ) {
    return reject("workstream is not ready for recovery");
  }
  const lease = createLease(state, workstream, "recovery", now, 0);
  lease.recoveryEpisodeId = episode.id;
  state.processLeases[lease.id] = lease;
  return {
    state,
    effects: [
      {
        kind: "run_recovery",
        workstream,
        leaseId: lease.id,
        episodeId: episode.id,
        independentlyEscalated: episode.cycle.independentlyEscalated,
      },
    ],
    accepted: true,
  };
}

function startReconciliation(
  state: RunState,
  workstream: RuntimeWorkstream,
  now: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const current = getWorkstream(state, workstream);
  const candidateId = current?.candidateId;
  if (
    !current ||
    !candidateId ||
    current.phase !== "approved" ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeWorkerLeaseCount(state) > 0 ||
    hasIntegrationLease(state)
  ) {
    return reject("workstream is not ready for reconciliation");
  }
  const lease = createLease(state, workstream, "reconciliation", now, 0);
  state.processLeases[lease.id] = lease;
  current.phase = "reconciling";
  return {
    state,
    effects: [
      {
        kind: "run_reconciliation",
        workstream,
        leaseId: lease.id,
        candidateId,
      },
    ],
    accepted: true,
  };
}

function createLease(
  state: RunState,
  workstream: RuntimeWorkstream,
  kind: ProcessLease["kind"],
  acquiredAt: string,
  index: number,
): ProcessLease {
  const attempt =
    Object.values(state.processLeases).filter(
      (lease) =>
        sameWorkstream(lease.workstream, workstream) && lease.kind === kind,
    ).length + 1;
  return {
    id: `${kind}:${state.run.id}:${state.revision + 1}:${index}`,
    workstream,
    kind,
    ...(getWorkstream(state, workstream)?.candidateId
      ? { candidateId: getWorkstream(state, workstream)!.candidateId }
      : {}),
    attempt,
    acquiredAt,
  };
}

function ownedLease(
  state: RunState,
  leaseId: string,
  workstream: RuntimeWorkstream,
  kind: ProcessLease["kind"],
): ProcessLease | undefined {
  const lease = state.processLeases[leaseId];
  return lease?.kind === kind && sameWorkstream(lease.workstream, workstream)
    ? lease
    : undefined;
}

function processIsAllowed(
  state: RunState,
  workstream: RuntimeWorkstream,
): boolean {
  return workstream.kind === "source"
    ? state.phase === "running"
    : state.phase === "whole_plan_review";
}

export function hasIntegrationLease(state: RunState): boolean {
  return Object.values(state.processLeases).some(
    (lease) => lease.kind === "reconciliation" || lease.kind === "publication",
  );
}

export function activeLeaseFor(
  state: RunState,
  workstream: RuntimeWorkstream,
): boolean {
  return Object.values(state.processLeases).some((lease) =>
    sameWorkstream(lease.workstream, workstream),
  );
}

export function activeWorkerLeaseCount(state: RunState): number {
  return Object.values(state.processLeases).filter(
    (lease) =>
      lease.kind === "implementation" ||
      lease.kind === "review" ||
      lease.kind === "recovery",
  ).length;
}

export function getWorkstream(
  state: RunState,
  workstream: RuntimeWorkstream,
):
  | RunState["workstreams"]["source"][string]
  | RunState["workstreams"]["overall"][string]
  | undefined {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]
    : state.workstreams.overall[workstream.repairId];
}

function recordGateResult(
  state: RunState,
  workstream: RuntimeWorkstream,
  result: RecoveryGateResult,
  workspace: RunState["recoveryEpisodes"][string]["workspace"],
  executionFailures = 0,
): void {
  const runtime = getWorkstream(state, workstream);
  const candidate = result.candidateId
    ? state.candidates[result.candidateId]
    : undefined;
  if (
    !runtime ||
    result.owner !== workstreamId(workstream) ||
    result.attempt < 1 ||
    state.gates.some((gate) => gate.id === result.id) ||
    (result.candidateId &&
      (!candidate ||
        runtime.candidateId !== result.candidateId ||
        !sameWorkstream(candidate.workstream, workstream)))
  ) {
    throw new Error(
      "Gate result does not match the current workstream candidate.",
    );
  }
  state.gates.push({
    id: result.id,
    kind: result.kind,
    workstream,
    ...(result.candidateId ? { candidateId: result.candidateId } : {}),
    attempt: result.attempt,
    outcome: result.outcome,
    evidence: result.evidence,
    ...(result.command
      ? {
          command: {
            ...result.command,
            output: boundedRecoveryOutput(result.command.output),
          },
        }
      : {}),
    ...(result.targetEvidence ? { targetEvidence: result.targetEvidence } : {}),
    outstandingFindingIds: [...result.outstandingFindingIds],
  });
  const active = openRecoveryEpisodeForWorkstream(state, workstream);
  if (active) {
    if (active.candidateId !== result.candidateId) {
      throw new Error(
        "Gate retry does not match the active recovery candidate.",
      );
    }
    active.gateAttempts.push(result.id);
    if (result.outcome === "passed") {
      active.status = "completed";
      runtime.phase = "candidate_ready";
    } else {
      active.gateId = result.id;
      active.outstandingFindingIds = [...result.outstandingFindingIds];
      active.workspace = workspace;
      active.cycle = recoveryCycleForGate(state, active, result);
      runtime.phase = "recovering";
    }
    return;
  }
  if (result.outcome === "passed") {
    return;
  }
  runtime.phase = "recovering";
  const episodeId = `recovery:${result.id}`;
  state.recoveryEpisodes[episodeId] = {
    id: episodeId,
    gateId: result.id,
    gateAttempts: [result.id],
    workstream,
    ...(result.candidateId ? { candidateId: result.candidateId } : {}),
    workspace,
    outstandingFindingIds: [...result.outstandingFindingIds],
    status: "open",
    cycle: recoveryCycleForGate(
      state,
      {
        gateId: result.id,
        candidateId: result.candidateId,
        workspace,
        outstandingFindingIds: result.outstandingFindingIds,
      },
      result,
    ),
    executionFailures,
    actions: [],
  };
}

function recoveryWorkspace(
  state: RunState,
  workstream: RuntimeWorkstream,
  candidateId?: string,
  failedWorkspace?: {
    changedPaths: string[];
    stateEvidence: string;
    stagingComparison?: { baseSha: string; treeSha: string };
  },
): RunState["recoveryEpisodes"][string]["workspace"] {
  const candidate = candidateId ? state.candidates[candidateId] : undefined;
  return {
    id: workstreamId(workstream),
    ...(candidate ? { checkpoint: candidate.commitSha } : {}),
    changedPaths: failedWorkspace?.changedPaths ?? [],
    stateEvidence:
      failedWorkspace?.stateEvidence ??
      "Workspace state was retained by the failed gate.",
    ...(failedWorkspace?.stagingComparison
      ? { stagingComparison: failedWorkspace.stagingComparison }
      : {}),
  };
}

function openRecoveryEpisodeForWorkstream(
  state: RunState,
  workstream: RuntimeWorkstream,
): RunState["recoveryEpisodes"][string] | undefined {
  return Object.values(state.recoveryEpisodes)
    .filter(
      (episode) =>
        episode.status === "open" &&
        sameWorkstream(episode.workstream, workstream),
    )
    .at(-1);
}

function recoveryCycleForGate(
  state: RunState,
  episode: Pick<
    RunState["recoveryEpisodes"][string],
    "candidateId" | "gateId" | "outstandingFindingIds" | "workspace"
  >,
  gate: RecoveryGateResult,
): RunState["recoveryEpisodes"][string]["cycle"] {
  return {
    signature: recoveryCycleSignature({
      gateId: gate.id,
      candidateTree: episode.candidateId
        ? state.candidates[episode.candidateId]?.treeSha
        : undefined,
      failureEvidence: gate.evidence,
      workspaceEvidence: episode.workspace.stateEvidence,
      outstandingFindings: episode.outstandingFindingIds.map((id) => ({
        id,
        evidence: state.findings[id]?.evidence ?? "",
      })),
      workspaceId: episode.workspace.id,
      nextAction: "retry",
    }),
    identicalNoActionCycles: 0,
    independentlyEscalated: false,
  };
}

function recoverySignatureFor(
  state: RunState,
  episode: RunState["recoveryEpisodes"][string],
  nextAction: RecoveryAction["kind"],
  diagnosis?: string,
): string {
  const gate = state.gates.find(
    (candidate) => candidate.id === episode.gateAttempts.at(-1),
  )!;
  return recoveryCycleSignature({
    gateId: episode.gateId,
    candidateTree: episode.candidateId
      ? state.candidates[episode.candidateId]?.treeSha
      : undefined,
    failureEvidence: gate.evidence,
    diagnosis,
    workspaceEvidence: episode.workspace.stateEvidence,
    outstandingFindings: episode.outstandingFindingIds.map((id) => ({
      id,
      evidence: state.findings[id]?.evidence ?? "",
    })),
    workspaceId: episode.workspace.id,
    nextAction,
  });
}

function retryPhaseForGate(
  gateId: string,
): RunState["workstreams"]["source"][string]["phase"] {
  if (
    gateId.startsWith("review:") ||
    gateId.startsWith("environment:review:")
  ) {
    return "candidate_ready";
  }
  if (
    gateId.startsWith("hook:") ||
    gateId.startsWith("reconciliation:") ||
    gateId.startsWith("environment:reconciliation:") ||
    gateId.startsWith("environment:publication:")
  ) {
    return "approved";
  }
  return "queued";
}

function workstreamId(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function sourceTaskOutcomeIsComplete(
  state: RunState,
  workstream: RuntimeWorkstream,
  outcome: ImplementationOutcome,
): boolean {
  if (workstream.kind !== "source") {
    return false;
  }
  const taskIds = state.workstreams.source[workstream.id]?.taskIds ?? [];
  const values =
    outcome.kind === "candidate_ready"
      ? { ...outcome.checkpoints, ...outcome.satisfied }
      : outcome.evidence;
  const mappingsDoNotOverlap =
    outcome.kind !== "candidate_ready" ||
    Object.keys(outcome.checkpoints).every(
      (taskId) => outcome.satisfied[taskId] === undefined,
    );
  return (
    mappingsDoNotOverlap &&
    taskIds.every(
      (taskId) =>
        typeof values[taskId] === "string" && values[taskId].trim() !== "",
    ) &&
    Object.keys(values).every((taskId) => taskIds.includes(taskId)) &&
    (outcome.kind !== "candidate_ready" ||
      Object.keys(outcome.checkpoints).some((taskId) =>
        taskIds.includes(taskId),
      ))
  );
}

function approveWorkstream(
  state: RunState,
  workstream: RuntimeWorkstream,
): void {
  const runtime = getWorkstream(state, workstream)!;
  if (workstream.kind === "source") {
    const source = state.workstreams.source[workstream.id]!;
    for (const taskId of source.taskIds) {
      const task = state.tasks[taskId]!;
      if (task.phase === "satisfaction_claimed") {
        state.tasks[taskId] = {
          workstreamId: task.workstreamId,
          phase: "reviewed_satisfied",
          evidence: task.evidence,
        };
      }
    }
    const candidate = runtime.candidateId
      ? state.candidates[runtime.candidateId]
      : undefined;
    if (
      candidate?.commitSha === candidate?.baseSha &&
      source.taskIds.every(
        (taskId) => state.tasks[taskId]?.phase === "reviewed_satisfied",
      )
    ) {
      // A satisfied receipt is only safe after replay checks the current target.
      runtime.phase = "approved";
      return;
    }
  }
  runtime.phase = "approved";
}

function taskIdOwner(state: RunState, taskId: string): string {
  return state.tasks[taskId]!.workstreamId;
}

export function allSourceWorkstreamsComplete(state: RunState): boolean {
  return Object.values(state.workstreams.source).every(
    (workstream) => workstream.phase === "completed",
  );
}

function abandonedPhase(
  kind: ProcessLease["kind"],
): "queued" | "candidate_ready" | "recovering" | "approved" {
  if (kind === "implementation") {
    return "queued";
  }
  if (kind === "review") {
    return "candidate_ready";
  }
  if (kind === "recovery") {
    return "recovering";
  }
  return "approved";
}

export function sameWorkstream(
  left: RuntimeWorkstream,
  right: RuntimeWorkstream,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "source"
      ? left.id === (right as { id: string }).id
      : left.repairId === (right as { repairId: string }).repairId)
  );
}

export function isStoppingSettlementEvent(event: SchedulerEvent): boolean {
  return [
    "process_abandoned",
    "implementation_completed",
    "implementation_failed",
    "effect_failed",
    "run_failed",
  ].includes(event.kind);
}

function safeId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}
