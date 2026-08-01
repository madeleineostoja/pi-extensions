import { join } from "node:path";
import {
  publicationIntentId,
  publicationPreparationId,
  stagingIdentity,
} from "../candidate-replay.js";
import {
  boundedFailureOutput,
  noProgressSignature,
  type FailureCategory,
  type FailureCommandEvidence,
} from "../failure-policy.js";
import type { AnchoredWorkstreamReviewCompletion } from "../result-schemas.js";
import {
  applyAnchoredWorkstreamReview,
  applyInitialWorkstreamReview,
  retargetAnchoredReview,
  reviewKey,
  workstreamReviewFindings,
  workstreamReviewState,
  type ReviewOutcome,
} from "../review.js";
import { sha256 } from "../source-integrity.js";
import type { RunState } from "../store.js";

export type RuntimeWorkstream = RunState["candidates"][string]["workstream"];
type ProcessLease = RunState["processLeases"][string];
type WorkspaceObservation = {
  branch: string;
  head: string;
  tree?: string;
  clean: boolean;
  activeOperation?: string;
  status: ReadonlyArray<{ status: string; path: string }>;
};

type FailedReplayContext = {
  candidateCommitSha: string;
  candidateTreeSha: string;
  targetSha: string;
  targetTreeSha: string;
  disposition: "overlap" | "conflict" | "changed_patch";
  paths: { candidate: string[]; target: string[]; replay: string[] };
  staging: {
    id: string;
    operationId: string;
    branchName: string;
    targetRef: string;
    replayPatchHash?: string;
    hookCommand?: FailureCommandEvidence;
  };
  evidence: string;
  hookEvidence?: string;
};

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
      trustedCandidate?: RunState["candidates"][string];
      observation?: WorkspaceObservation;
      category: FailureCategory;
    }
  | {
      kind: "effect_failed";
      effect: "review" | "reconciliation" | "publication";
      workstream: RuntimeWorkstream;
      leaseId: string;
      evidence: string;
      category: FailureCategory;
      observation?: WorkspaceObservation;
      command?: FailureCommandEvidence;
      provenNoWrite?: boolean;
    }
  | {
      kind: "whole_plan_review_failed";
      evidence: string;
      category: FailureCategory;
    }
  | {
      kind: "review_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: ReviewOutcome;
      projectionDebt?: RunState["projectionDebt"][number];
    }
  | { kind: "revision_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "revision_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      assignmentId: string;
      outcome:
        | {
            kind: "candidate_ready";
            candidate: RunState["candidates"][string];
            correction: {
              fromCandidateId: string;
              changedPaths: string[];
              evidence: string;
            };
          }
        | { kind: "unchanged"; evidence: string };
    }
  | {
      kind: "revision_failed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      assignmentId: string;
      category: FailureCategory;
      evidence: string;
      observation?: WorkspaceObservation;
    }
  | { kind: "workspace_recreation_requested"; id: string; now: string }
  | {
      kind: "workspace_recreation_completed";
      id: string;
      leaseId: string;
      before: WorkspaceObservation;
      after: WorkspaceObservation;
      outcome: "restored" | "still_quarantined" | "unsafe";
    }
  | {
      kind: "reconciliation_requested";
      workstream: RuntimeWorkstream;
      now: string;
    }
  | {
      kind: "reconciliation_assignment_requested";
      workstream: RuntimeWorkstream;
      now: string;
    }
  | {
      kind: "reconciliation_worker_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      assignmentId: string;
      outcome: {
        candidate: RunState["candidates"][string];
        correction: {
          fromCandidateId: string;
          changedPaths: string[];
          evidence: string;
        };
      };
    }
  | {
      kind: "reconciliation_worker_failed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      assignmentId: string;
      category: FailureCategory;
      evidence: string;
      observation?: WorkspaceObservation;
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
            workspace: {
              id: string;
              checkpoint?: string;
              changedPaths: string[];
              stateEvidence: string;
              targetSha?: string;
              stagingComparison?: { baseSha: string; treeSha: string };
            };
          }
        | {
            kind: "reconciliation_required";
            evidence: string;
            command?: FailureCommandEvidence;
            failedReplay: FailedReplayContext;
            workspace: {
              id: string;
              checkpoint?: string;
              changedPaths: string[];
              stateEvidence: string;
              targetSha?: string;
              stagingComparison?: { baseSha: string; treeSha: string };
            };
          }
        | {
            kind: "execution_failed" | "hook_rejected";
            evidence: string;
            command?: FailureCommandEvidence;
            workspace: {
              id: string;
              checkpoint?: string;
              changedPaths: string[];
              stateEvidence: string;
              targetSha?: string;
              stagingComparison?: { baseSha: string; treeSha: string };
            };
          };
    }
  | {
      kind: "publication_preparation_recorded";
      operationId: string;
      preparation: RunState["publication"]["preparations"][string];
    }
  | {
      kind: "publication_intent_recorded";
      operationId: string;
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
      operationId: string;
      receipt: RunState["publication"]["receipts"][string];
    }
  | {
      kind: "publication_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      intentId: string;
      projectionDebt?: RunState["projectionDebt"][number];
    }
  | {
      kind: "publication_target_moved";
      workstream: RuntimeWorkstream;
      leaseId: string;
      intentId: string;
      candidateId: string;
      expectedTargetSha: string;
      actualTargetSha: string;
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
              disposition: "blocking" | "advisory";
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
  | { kind: "run_incomplete" }
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
      kind: "run_revision";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
      assignmentId: string;
    }
  | {
      kind: "recreate_workspace";
      workstream: RuntimeWorkstream;
      leaseId: string;
      recreationId: string;
    }
  | {
      kind: "run_reconciliation";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
    }
  | {
      kind: "run_reconciliation_worker";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
      assignmentId: string;
    }
  | {
      kind: "run_publication";
      workstream: RuntimeWorkstream;
      leaseId: string;
      candidateId: string;
      intentId: string;
    }
  | { kind: "run_whole_plan_review" }
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
  state.phase = "stopping";
  return { state, effects: [], accepted: true };
}

export function reduceRunEvent(
  input: RunState,
  event: SchedulerEvent,
): SchedulerTransition {
  const priorOperationId = "leaseId" in event ? event.leaseId : undefined;
  if (priorOperationId) {
    const settlement = input.operationSettlements[priorOperationId];
    if (settlement) {
      if (settlement.eventFingerprint === JSON.stringify(event)) {
        return { state: input, effects: [], accepted: true };
      }
      return {
        state: input,
        effects: [],
        accepted: false,
        error: `operation ${priorOperationId} is already settled`,
      };
    }
  }
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

  if (
    state.phase === "failed" ||
    state.phase === "incomplete" ||
    state.phase === "completed"
  ) {
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
      if (hasQuiescentApprovedCandidate(state)) {
        return reject(
          "approved candidates must integrate before another implementation batch starts",
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
      settleLease(state, lease, event.kind, event);
      if (event.trustedCandidate) {
        if (
          !sameWorkstream(event.trustedCandidate.workstream, event.workstream)
        ) {
          return reject("observed candidate belongs to another workstream");
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
        workstream.phase = "candidate_ready";
        recordFailure(state, {
          category: event.category,
          assignment: "operational_retry",
          workstream: event.workstream,
          candidateId: event.trustedCandidate.id,
          gate: "implementation_completion",
          evidence: event.evidence,
          observation: event.observation,
        });
        return accept();
      }
      recordFailure(state, {
        category: event.category,
        assignment:
          event.category === "workspace_unsafe" &&
          isKnownOwnedDirtyWorkspace(state, event.workstream, event.observation)
            ? "workspace_recreation"
            : "operational_retry",
        workstream: event.workstream,
        ...(workstream.candidateId
          ? { candidateId: workstream.candidateId }
          : {}),
        gate: "implementation",
        evidence: event.evidence,
        observation: event.observation,
      });
      if (event.category === "workspace_unsafe") {
        if (
          isKnownOwnedDirtyWorkspace(state, event.workstream, event.observation)
        ) {
          createWorkspaceRecreation(
            state,
            event.workstream,
            "queued",
            event.evidence,
          );
          workstream.phase = "recreating_workspace";
          return accept();
        }
        return failRun(
          state,
          "workspace_unsafe",
          event.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      return scheduleOperationalRetry(
        state,
        event.workstream,
        "implementation",
        event.evidence,
        "queued",
        reject,
      );
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
      settleLease(state, lease, event.kind, event);
      const candidateId = workstream.candidateId;
      recordFailure(state, {
        category: event.category,
        assignment:
          event.category === "hook_rejected"
            ? "candidate_revision"
            : "operational_retry",
        workstream: event.workstream,
        ...(candidateId ? { candidateId } : {}),
        gate: event.effect,
        evidence: event.evidence,
        ...(event.command ? { command: event.command } : {}),
        ...(event.observation ? { observation: event.observation } : {}),
      });
      if (event.category === "workspace_unsafe") {
        if (
          isKnownOwnedDirtyWorkspace(state, event.workstream, event.observation)
        ) {
          createWorkspaceRecreation(
            state,
            event.workstream,
            event.effect === "review" ? "candidate_ready" : "approved",
            event.evidence,
          );
          workstream.phase = "recreating_workspace";
          return accept();
        }
        return failRun(
          state,
          "workspace_unsafe",
          event.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      if (
        event.category === "publication_uncertain" ||
        event.category === "target_moved"
      ) {
        return failRun(
          state,
          event.category,
          event.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      if (event.category === "hook_rejected" && candidateId) {
        return createRevisionAssignment(
          state,
          event.workstream,
          candidateId,
          [],
          event.evidence,
          reject,
        );
      }
      return scheduleOperationalRetry(
        state,
        event.workstream,
        event.effect,
        event.evidence,
        event.effect === "review" ? "candidate_ready" : "approved",
        reject,
        event.effect === "publication" && event.provenNoWrite === true,
      );
    }

    case "whole_plan_review_failed": {
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing"
      ) {
        return reject(
          "whole-plan failure is not owned by an active assessment",
        );
      }
      const retry = state.wholePlanReview.reviewRetry ?? {
        attempts: 0,
        evidence: [],
        status: "open" as const,
      };
      retry.attempts++;
      retry.evidence.push(boundedFailureOutput(event.evidence));
      if (retry.attempts >= 3) {
        retry.status = "exhausted";
        state.wholePlanReview = {
          status: "pending",
          ...(state.wholePlanReview.epoch
            ? { epoch: state.wholePlanReview.epoch }
            : {}),
          reviewRetry: retry,
        };
        return accept();
      }
      state.wholePlanReview = {
        status: "pending",
        ...(state.wholePlanReview.epoch
          ? { epoch: state.wholePlanReview.epoch }
          : {}),
        reviewRetry: retry,
      };
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
                  comparisonBase:
                    event.outcome.candidate.integrationBaseSha ??
                    event.outcome.candidate.baseSha,
                  correction: {
                    fromCandidateId: review.candidateId,
                    changedPaths: event.outcome.candidate.changedPaths ?? [],
                    evidence:
                      event.outcome.candidate.implementationEvidence
                        ?.artifactPath ??
                      event.outcome.candidate.observationArtifact ??
                      "Overall repair candidate was observed.",
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
      settleLease(state, lease, event.kind, event);
      completeOperationalRetries(state, event.workstream, "implementation");
      return accept();
    }

    case "review_requested":
      return startProcess(state, event.workstream, "review", event.now, reject);

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
            comparisonBase:
              state.candidates[event.outcome.candidateId]!.integrationBaseSha ??
              state.candidates[event.outcome.candidateId]!.baseSha,
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
          const findings = event.outcome.completion.findings.map(
            (finding, index) => ({
              ...finding,
              id: `${reviewKey(event.workstream).replace(":", "-")}-repository-${review.round + 1}-${index + 1}`,
              candidateId: event.outcome.candidateId,
              workstream: event.workstream,
              scope:
                event.workstream.kind === "source"
                  ? { kind: "source" as const, id: event.workstream.id }
                  : {
                      kind: "whole_plan" as const,
                      initialTargetSha: review.comparisonBase,
                      initialTargetTreeSha: review.comparisonBase,
                    },
              origin: "regression" as const,
              introducedRound: review.round + 1,
              status: "open" as const,
            }),
          );
          state.reviews[key] = {
            ...review,
            round: review.round + 1,
            pendingCorrectionIds: findings.map((finding) => finding.id),
            evidence: [...review.evidence, event.outcome.evidence],
          };
          for (const finding of findings) {
            state.findings[finding.id] = finding;
          }
          assessment!.status = findings.length === 0 ? "approved" : "rejected";
        } else {
          const review = workstreamReviewState(state, event.workstream);
          if (
            !review ||
            review.candidateId !== event.outcome.candidateId ||
            review.previousCandidateId !== event.outcome.previousCandidateId ||
            review.comparisonBase !== event.outcome.comparisonBase ||
            review.round !== event.outcome.findingEpoch ||
            !samePaths(
              review.latestCorrection?.changedPaths ?? [],
              event.outcome.changedPaths,
            )
          ) {
            return reject(
              "anchored review is not bound to the current comparison identity",
            );
          }
          const update = applyAnchoredWorkstreamReview({
            state: review,
            workstream: event.workstream,
            completion: event.outcome.completion,
            findings: workstreamReviewFindings(state, event.workstream),
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
      settleLease(state, lease, event.kind, event);
      completeOperationalRetries(state, event.workstream, "review");
      const pendingCorrectionIds = state.reviews[key]!.pendingCorrectionIds;
      if (pendingCorrectionIds.length > 0) {
        return createRevisionAssignment(
          state,
          event.workstream,
          event.outcome.candidateId,
          pendingCorrectionIds,
          event.outcome.evidence,
          reject,
        );
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

    case "revision_requested":
      return startRevision(state, event.workstream, event.now, reject);

    case "revision_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "revision",
      );
      const workstream = getWorkstream(state, event.workstream);
      const assignment = state.revisionAssignments[event.assignmentId];
      if (
        !lease ||
        !workstream ||
        !assignment ||
        lease.revisionAssignmentId !== assignment.id ||
        assignment.status !== "open" ||
        workstream.phase !== "revising" ||
        workstream.candidateId !== assignment.candidateId ||
        !processIsAllowed(state, event.workstream)
      ) {
        return reject("revision result does not own its exact assignment");
      }
      if (event.outcome.kind === "unchanged") {
        const candidate = state.candidates[assignment.candidateId];
        if (!candidate) {
          return reject("revision assignment lost its candidate");
        }
        const signature = noProgressSignature({
          workstream: workstreamId(event.workstream),
          candidateTree: candidate.treeSha,
          findingEpoch: assignment.findingEpoch,
          pendingCorrectionIds: assignment.pendingCorrectionIds,
        });
        assignment.noProgress = {
          signature,
          attempts:
            assignment.noProgress.signature === signature
              ? assignment.noProgress.attempts + 1
              : 1,
        };
        settleLease(state, lease, event.kind, event);
        recordFailure(state, {
          category: "no_progress",
          assignment: "blocked",
          workstream: event.workstream,
          candidateId: candidate.id,
          gate: "revision",
          evidence: event.outcome.evidence,
        });
        assignment.status = "blocked";
        failWorkstream(state, event.workstream);
        return accept();
      }
      const candidate = event.outcome.candidate;
      const review = workstreamReviewState(state, event.workstream);
      if (
        !sameWorkstream(candidate.workstream, event.workstream) ||
        candidate.baseSha !==
          state.candidates[assignment.candidateId]?.baseSha ||
        candidate.integrationBaseSha !==
          state.candidates[assignment.candidateId]?.integrationBaseSha ||
        event.outcome.correction.fromCandidateId !== assignment.candidateId ||
        !review ||
        review.candidateId !== assignment.candidateId ||
        review.round !== assignment.findingEpoch ||
        JSON.stringify(review.pendingCorrectionIds) !==
          JSON.stringify(assignment.pendingCorrectionIds)
      ) {
        return reject("revision completion is stale for its review epoch");
      }
      const existing = state.candidates[candidate.id];
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        return reject("candidate identity is immutable");
      }
      try {
        state.reviews[reviewKey(event.workstream)] = retargetAnchoredReview({
          state: review,
          candidateId: candidate.id,
          comparisonBase: review.comparisonBase,
          correction: event.outcome.correction,
        });
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
      state.candidates[candidate.id] = candidate;
      workstream.candidateId = candidate.id;
      assignment.status = "completed";
      settleLease(state, lease, event.kind, event);
      workstream.phase = "candidate_ready";
      return accept();
    }

    case "revision_failed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "revision",
      );
      const workstream = getWorkstream(state, event.workstream);
      const assignment = state.revisionAssignments[event.assignmentId];
      if (
        !lease ||
        !workstream ||
        !assignment ||
        lease.revisionAssignmentId !== assignment.id ||
        assignment.status !== "open" ||
        workstream.phase !== "revising"
      ) {
        return reject("revision failure does not own an active assignment");
      }
      settleLease(state, lease, event.kind, event);
      recordFailure(state, {
        category: event.category,
        assignment:
          event.category === "workspace_unsafe" &&
          isKnownOwnedDirtyWorkspace(state, event.workstream, event.observation)
            ? "workspace_recreation"
            : "operational_retry",
        workstream: event.workstream,
        candidateId: assignment.candidateId,
        gate: "revision",
        evidence: event.evidence,
        ...(event.observation ? { observation: event.observation } : {}),
      });
      if (event.category === "workspace_unsafe") {
        if (
          isKnownOwnedDirtyWorkspace(state, event.workstream, event.observation)
        ) {
          createWorkspaceRecreation(
            state,
            event.workstream,
            "revising",
            event.evidence,
          );
          workstream.phase = "recreating_workspace";
          return accept();
        }
        assignment.status = "blocked";
        return failRun(
          state,
          "workspace_unsafe",
          event.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      if (event.category === "semantic_blocked") {
        assignment.status = "blocked";
        failWorkstream(state, event.workstream);
        return accept();
      }
      assignment.executionFailures++;
      if (assignment.executionFailures >= 3) {
        assignment.status = "blocked";
        failWorkstream(state, event.workstream);
        return accept();
      }
      return accept();
    }

    case "workspace_recreation_requested":
      return startWorkspaceRecreation(state, event.id, event.now, reject);

    case "workspace_recreation_completed": {
      const recreation = state.workspaceRecreations[event.id];
      const lease = recreation
        ? ownedLease(
            state,
            event.leaseId,
            recreation.workstream,
            "workspace_recreation",
          )
        : undefined;
      const workstream = recreation
        ? getWorkstream(state, recreation.workstream)
        : undefined;
      if (
        !recreation ||
        !lease ||
        lease.workspaceRecreationId !== recreation.id ||
        !workstream ||
        workstream.phase !== "recreating_workspace" ||
        recreation.status !== "running"
      ) {
        return reject(
          "workspace recreation does not own its exact resource operation",
        );
      }
      recreation.before = retainedObservation(event.before);
      recreation.after = retainedObservation(event.after);
      recreation.status = event.outcome;
      settleLease(state, lease, event.kind, event);
      if (event.outcome !== "restored") {
        recordFailure(state, {
          category: "workspace_unsafe",
          assignment: "blocked",
          workstream: recreation.workstream,
          ...(recreation.candidateId
            ? { candidateId: recreation.candidateId }
            : {}),
          gate: "workspace_recreation",
          evidence: `Workspace recreation settled ${event.outcome}.`,
          observation: event.after,
        });
        failWorkstream(state, recreation.workstream);
        return accept();
      }
      workstream.phase = recreation.resumePhase;
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
        operationId: lease.id,
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
      settleLease(state, lease, event.kind, event);
      completeOperationalRetries(state, event.workstream, "reconciliation");
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
            operationId: lease.id,
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
        operationId: lease.id,
        evidence: event.evidence,
        status: "pending",
      };
      settleLease(state, lease, event.kind, event);
      completeOperationalRetries(state, event.workstream, "reconciliation");
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

    case "reconciliation_assignment_requested":
      return startReconciliationWorker(
        state,
        event.workstream,
        event.now,
        reject,
      );

    case "reconciliation_worker_completed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "reconciliation",
      );
      const workstream = getWorkstream(state, event.workstream);
      const assignment = state.reconciliationAssignments[event.assignmentId];
      const previous = assignment
        ? state.candidates[assignment.candidateId]
        : undefined;
      const review = workstreamReviewState(state, event.workstream);
      const candidate = event.outcome.candidate;
      if (
        !lease ||
        !workstream ||
        !assignment ||
        !previous ||
        !review ||
        lease.reconciliationAssignmentId !== assignment.id ||
        assignment.status !== "pending" ||
        workstream.phase !== "reconciling" ||
        workstream.candidateId !== assignment.candidateId ||
        assignment.candidateCommitSha !== previous.commitSha ||
        assignment.candidateTreeSha !== previous.treeSha ||
        event.outcome.correction.fromCandidateId !== previous.id ||
        !sameWorkstream(candidate.workstream, event.workstream) ||
        candidate.baseSha !== previous.baseSha ||
        candidate.integrationBaseSha !== assignment.targetSha ||
        candidate.commitSha === previous.commitSha ||
        candidate.treeSha === previous.treeSha ||
        !samePaths(
          candidate.changedPaths ?? [],
          event.outcome.correction.changedPaths,
        ) ||
        !reviewIsCurrentForReconciliation(review, previous.id)
      ) {
        return reject(
          "reconciliation completion does not own its exact candidate and failed target",
        );
      }
      const existing = state.candidates[candidate.id];
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        return reject("candidate identity is immutable");
      }
      try {
        state.reviews[reviewKey(event.workstream)] = retargetAnchoredReview({
          state: review,
          candidateId: candidate.id,
          comparisonBase: assignment.targetSha,
          correction: event.outcome.correction,
        });
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
      state.candidates[candidate.id] = candidate;
      workstream.candidateId = candidate.id;
      assignment.status = "completed";
      settleLease(state, lease, event.kind, event);
      workstream.phase = "candidate_ready";
      return accept();
    }

    case "reconciliation_worker_failed": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "reconciliation",
      );
      const workstream = getWorkstream(state, event.workstream);
      const assignment = state.reconciliationAssignments[event.assignmentId];
      if (
        !lease ||
        !workstream ||
        !assignment ||
        lease.reconciliationAssignmentId !== assignment.id ||
        assignment.status !== "pending" ||
        workstream.phase !== "reconciling" ||
        workstream.candidateId !== assignment.candidateId
      ) {
        return reject(
          "reconciliation failure does not own its exact assignment",
        );
      }
      settleLease(state, lease, event.kind, event);
      assignment.attemptEvidence.push(boundedFailureOutput(event.evidence));
      recordFailure(state, {
        category: event.category,
        assignment:
          event.category === "semantic_blocked" ||
          event.category === "workspace_unsafe"
            ? "blocked"
            : "operational_retry",
        workstream: event.workstream,
        candidateId: assignment.candidateId,
        gate: "semantic_reconciliation",
        evidence: event.evidence,
        ...(event.observation ? { observation: event.observation } : {}),
      });
      if (event.category === "workspace_unsafe") {
        if (
          isKnownOwnedDirtyWorkspace(state, event.workstream, event.observation)
        ) {
          createWorkspaceRecreation(
            state,
            event.workstream,
            "reconciliation_required",
            event.evidence,
          );
          workstream.phase = "recreating_workspace";
          return accept();
        }
        assignment.status = "blocked";
        return failRun(
          state,
          "workspace_unsafe",
          event.evidence,
          new Date().toISOString(),
          reject,
        );
      }
      if (event.category === "semantic_blocked") {
        assignment.status = "blocked";
        if (assignment.semanticAttempt === "initial") {
          const escalation = createReconciliationEscalation(state, assignment);
          state.reconciliationAssignments[escalation.id] = escalation;
          workstream.phase = "reconciliation_required";
          return accept();
        }
        failWorkstream(state, event.workstream);
        return accept();
      }
      assignment.executionFailures++;
      if (assignment.executionFailures >= 3) {
        assignment.status = "blocked";
        failWorkstream(state, event.workstream);
        return accept();
      }
      workstream.phase = "reconciliation_required";
      return accept();
    }

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
          const candidate = state.candidates[candidateId];
          const intent = Object.values(state.publication.intents).find(
            (entry) =>
              entry.operationId === lease.id &&
              entry.candidateId === candidateId &&
              sameWorkstream(entry.workstream, event.workstream),
          );
          const preparation = intent
            ? state.publication.preparations[intent.preparationId]
            : undefined;
          const staging =
            candidate && preparation
              ? stagingIdentity({
                  runId: state.run.id,
                  operationId: lease.id,
                  candidateId: candidate.id,
                  candidateCommitSha: candidate.commitSha,
                  candidateTreeSha: candidate.treeSha,
                  targetBaseSha: preparation.targetBaseSha,
                  targetRef: preparation.targetRef,
                })
              : undefined;
          if (
            !candidate ||
            !intent ||
            !preparation ||
            preparation.operationId !== lease.id ||
            preparation.candidateId !== candidate.id ||
            preparation.candidateCommitSha !== candidate.commitSha ||
            preparation.candidateTreeSha !== candidate.treeSha ||
            preparation.id !== intent.preparationId ||
            event.outcome.workspace.id !== staging?.id ||
            event.outcome.workspace.checkpoint !==
              preparation.preparedCommitSha ||
            event.outcome.workspace.targetSha !== preparation.targetBaseSha ||
            !event.outcome.workspace.stagingComparison ||
            event.outcome.workspace.stagingComparison.baseSha !==
              preparation.targetBaseSha ||
            event.outcome.workspace.stagingComparison.treeSha !==
              preparation.preparedTreeSha ||
            !samePaths(
              event.outcome.workspace.changedPaths,
              preparation.changedPaths,
            )
          ) {
            return reject(
              "prepared reconciliation requires its exact durable preparation and intent",
            );
          }
          settleLease(state, lease, event.kind, event);
          completeOperationalRetries(state, event.workstream, "reconciliation");
          const publicationLease = createLease(
            state,
            event.workstream,
            "publication",
            new Date().toISOString(),
            0,
          );
          state.processLeases[publicationLease.id] = {
            ...publicationLease,
            candidateId,
            publicationIntentId: intent.id,
          };
          workstream.phase = "publishing";
          return accept([
            {
              kind: "run_publication",
              workstream: event.workstream,
              leaseId: publicationLease.id,
              candidateId,
              intentId: intent.id,
            },
          ]);
        } catch (error) {
          return reject(error instanceof Error ? error.message : String(error));
        }
      }
      settleLease(state, lease, event.kind, event);
      if (event.outcome.kind !== "execution_failed") {
        completeOperationalRetries(state, event.workstream, "reconciliation");
      }
      if (event.outcome.kind === "hook_rejected") {
        recordFailure(state, {
          category: "hook_rejected",
          assignment: "candidate_revision",
          workstream: event.workstream,
          candidateId,
          gate: "reconciliation_hook",
          evidence: event.outcome.evidence,
          ...(event.outcome.command ? { command: event.outcome.command } : {}),
        });
        return createRevisionAssignment(
          state,
          event.workstream,
          candidateId,
          [],
          event.outcome.evidence,
          reject,
        );
      }
      if (event.outcome.kind === "reconciliation_required") {
        const replay = event.outcome.failedReplay;
        if (
          !event.outcome.workspace.targetSha ||
          event.outcome.workspace.targetSha !== replay.targetSha ||
          replay.candidateCommitSha !==
            state.candidates[candidateId]?.commitSha ||
          replay.candidateTreeSha !== state.candidates[candidateId]?.treeSha ||
          replay.staging.id !== event.outcome.workspace.id ||
          replay.staging.operationId !== lease.id ||
          !samePaths(
            event.outcome.workspace.changedPaths,
            replay.paths.replay,
          ) ||
          !canonicalReplayPaths(replay.paths.candidate) ||
          !canonicalReplayPaths(replay.paths.target) ||
          !canonicalReplayPaths(replay.paths.replay)
        ) {
          return reject(
            "failed replay does not retain an exact immutable reconciliation context",
          );
        }
        const paths = {
          candidate: [...replay.paths.candidate],
          target: [...replay.paths.target],
          replay: [...replay.paths.replay],
        };
        const context = reconciliationContext({
          workstream: event.workstream,
          candidateTreeSha: replay.candidateTreeSha,
          targetSha: replay.targetSha,
          disposition: replay.disposition,
          paths,
        });
        if (
          Object.values(state.reconciliationAssignments).some(
            (assignment) => assignment.context.key === context.key,
          )
        ) {
          return reject(
            "the unchanged failed replay context already has retained reconciliation history",
          );
        }
        const id = `reconcile:${workstreamId(event.workstream)}:${candidateId}:${Object.keys(state.reconciliationAssignments).length + 1}`;
        state.reconciliationAssignments[id] = {
          id,
          workstream: event.workstream,
          candidateId,
          candidateCommitSha: replay.candidateCommitSha,
          candidateTreeSha: replay.candidateTreeSha,
          targetSha: replay.targetSha,
          targetTreeSha: replay.targetTreeSha,
          disposition: replay.disposition,
          context,
          paths,
          operationId: lease.id,
          staging: {
            id: replay.staging.id,
            branchName: replay.staging.branchName,
            targetRef: replay.staging.targetRef,
            ...(replay.staging.replayPatchHash
              ? { replayPatchHash: replay.staging.replayPatchHash }
              : {}),
            ...(replay.staging.hookCommand
              ? {
                  hookCommand: {
                    ...replay.staging.hookCommand,
                    output: boundedFailureOutput(
                      replay.staging.hookCommand.output,
                    ),
                  },
                }
              : {}),
          },
          evidence: boundedFailureOutput(replay.evidence),
          ...(replay.hookEvidence
            ? { hookEvidence: boundedFailureOutput(replay.hookEvidence) }
            : {}),
          semanticAttempt: "initial",
          priorAttemptEvidence: [],
          attemptEvidence: [],
          status: "pending",
          executionFailures: 0,
        };
        recordFailure(state, {
          category: "semantic_blocked",
          assignment: "failed_target_reconciliation",
          workstream: event.workstream,
          candidateId,
          gate: "reconciliation",
          evidence: event.outcome.evidence,
          ...(event.outcome.command ? { command: event.outcome.command } : {}),
        });
        workstream.phase = "reconciliation_required";
        return accept();
      }
      recordFailure(state, {
        category: "provider_failure",
        assignment: "operational_retry",
        workstream: event.workstream,
        candidateId,
        gate: "reconciliation",
        evidence: event.outcome.evidence,
      });
      return scheduleOperationalRetry(
        state,
        event.workstream,
        "reconciliation",
        event.outcome.evidence,
        "approved",
        reject,
      );
    }

    case "publication_preparation_recorded": {
      const lease = state.processLeases[event.operationId];
      const candidate = state.candidates[event.preparation.candidateId];
      const existing = state.publication.preparations[event.preparation.id];
      if (
        !lease ||
        lease.kind !== "reconciliation" ||
        lease.id !== event.operationId ||
        lease.id !== event.preparation.operationId ||
        lease.candidateId !== candidate?.id ||
        !sameWorkstream(
          lease.workstream,
          candidate?.workstream ?? lease.workstream,
        ) ||
        !candidate ||
        event.preparation.id !==
          publicationPreparationId({
            runId: state.run.id,
            preparation: event.preparation,
          }) ||
        candidate.commitSha !== event.preparation.candidateCommitSha ||
        candidate.treeSha !== event.preparation.candidateTreeSha ||
        (event.preparation.disposition === "same_base" &&
          (candidate.integrationBaseSha !== undefined ||
            event.preparation.targetBaseSha !== candidate.baseSha)) ||
        (event.preparation.disposition === "reconciled_same_base" &&
          (candidate.integrationBaseSha === undefined ||
            event.preparation.targetBaseSha !==
              candidate.integrationBaseSha)) ||
        (event.preparation.disposition === "clean_non_overlap" &&
          event.preparation.targetBaseSha ===
            (candidate.integrationBaseSha ?? candidate.baseSha)) ||
        event.preparation.targetRef !== state.run.checkout.branchRef ||
        event.preparation.stagingBranch !==
          stagingIdentity({
            runId: state.run.id,
            operationId: event.preparation.operationId,
            candidateId: event.preparation.candidateId,
            candidateCommitSha: event.preparation.candidateCommitSha,
            candidateTreeSha: event.preparation.candidateTreeSha,
            targetBaseSha: event.preparation.targetBaseSha,
            targetRef: event.preparation.targetRef,
          }).branchName ||
        event.preparation.stagingWorktree !==
          join(
            state.run.checkout.root,
            ".pi",
            "pipkin",
            "implement",
            "worktrees",
            state.run.id,
            stagingIdentity({
              runId: state.run.id,
              operationId: event.preparation.operationId,
              candidateId: event.preparation.candidateId,
              candidateCommitSha: event.preparation.candidateCommitSha,
              candidateTreeSha: event.preparation.candidateTreeSha,
              targetBaseSha: event.preparation.targetBaseSha,
              targetRef: event.preparation.targetRef,
            }).id,
          ) ||
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
      const lease = state.processLeases[event.operationId];
      const candidate = state.candidates[event.intent.candidateId];
      const preparation =
        state.publication.preparations[event.intent.preparationId];
      if (
        !lease ||
        lease.kind !== "reconciliation" ||
        lease.id !== event.operationId ||
        lease.id !== event.intent.operationId ||
        lease.candidateId !== candidate?.id ||
        preparation?.operationId !== event.operationId ||
        !candidate ||
        !preparation ||
        !sameWorkstream(candidate.workstream, event.intent.workstream) ||
        getWorkstream(state, event.intent.workstream)?.candidateId !==
          candidate.id ||
        preparation.candidateId !== candidate.id ||
        preparation.targetBaseSha !== event.intent.targetBaseSha ||
        preparation.preparedCommitSha !== event.intent.preparedCommitSha ||
        preparation.preparedTreeSha !== event.intent.preparedTreeSha ||
        preparation.targetRef !== event.intent.targetRef ||
        event.intent.id !==
          publicationIntentId({
            runId: state.run.id,
            operationId: event.operationId,
            preparation,
          })
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
        state.publication.supersessions[intent.id] !== undefined ||
        state.publication.abandonments[intent.id] !== undefined ||
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
      const lease = state.processLeases[event.operationId];
      const intent = state.publication.intents[event.receipt.intentId];
      if (
        !lease ||
        lease.kind !== "publication" ||
        lease.id !== event.receipt.operationId ||
        lease.publicationIntentId !== event.receipt.intentId ||
        !intent ||
        state.publication.supersessions[intent.id] !== undefined ||
        state.publication.abandonments[intent.id] !== undefined ||
        intent.candidateId !== event.receipt.candidateId ||
        intent.targetBaseSha !== event.receipt.targetBaseSha ||
        intent.preparedCommitSha !== event.receipt.publishedCommitSha ||
        intent.preparedTreeSha !== event.receipt.publishedTreeSha ||
        intent.targetRef !== event.receipt.targetRef ||
        JSON.stringify(intent.protectedArtifactHashes) !==
          JSON.stringify(event.receipt.protectedArtifactHashes)
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
        state.publication.supersessions[intent.id] !== undefined ||
        state.publication.abandonments[intent.id] !== undefined ||
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
      settleLease(state, lease, event.kind, event);
      completeOperationalRetries(state, event.workstream, "publication");
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
          ...(state.wholePlanReview.reviewRetry
            ? { reviewRetry: state.wholePlanReview.reviewRetry }
            : {}),
        };
      }
      return accept(
        event.projectionDebt
          ? [{ kind: "run_projection", debtId: event.projectionDebt.id }]
          : [],
      );
    }

    case "publication_target_moved": {
      const lease = ownedLease(
        state,
        event.leaseId,
        event.workstream,
        "publication",
      );
      const workstream = getWorkstream(state, event.workstream);
      const intent = state.publication.intents[event.intentId];
      const preparation = intent
        ? state.publication.preparations[intent.preparationId]
        : undefined;
      const candidate = state.candidates[event.candidateId];
      if (
        !lease ||
        !workstream ||
        !intent ||
        !preparation ||
        !candidate ||
        workstream.phase !== "publishing" ||
        lease.publicationIntentId !== intent.id ||
        lease.candidateId !== candidate.id ||
        intent.candidateId !== event.candidateId ||
        workstream.candidateId !== candidate.id ||
        !sameWorkstream(candidate.workstream, event.workstream) ||
        intent.targetBaseSha !== event.expectedTargetSha ||
        preparation.targetBaseSha !== event.expectedTargetSha ||
        event.actualTargetSha === event.expectedTargetSha ||
        event.actualTargetSha === intent.preparedCommitSha ||
        state.publication.receipts[intent.id] ||
        state.publication.supersessions[intent.id] ||
        state.publication.abandonments[intent.id]
      ) {
        return reject(
          "target movement does not prove this exact stale publication intent",
        );
      }
      settleLease(state, lease, event.kind, event);
      state.publication.supersessions[intent.id] = {
        intentId: intent.id,
        publicationOperationId: lease.id,
        preparationOperationId: intent.operationId,
        workstream: event.workstream,
        candidateId: candidate.id,
        preparationId: intent.preparationId,
        targetRef: intent.targetRef,
        expectedTargetSha: event.expectedTargetSha,
        actualTargetSha: event.actualTargetSha,
        supersededAt: new Date().toISOString(),
      };
      recordFailure(state, {
        category: "target_moved",
        assignment: "failed_target_reconciliation",
        workstream: event.workstream,
        candidateId: candidate.id,
        gate: "publication_compare_and_swap",
        evidence: `Publication intent ${intent.id} was superseded before compare-and-swap from ${event.expectedTargetSha} to ${event.actualTargetSha}.`,
        targetEvidence: event.actualTargetSha,
      });
      workstream.phase = "approved";
      return accept();
    }

    case "whole_plan_review_requested":
      if (
        !["running", "whole_plan_review"].includes(state.phase) ||
        state.wholePlanReview.status !== "pending" ||
        !wholePlanReviewCanProgress(state)
      ) {
        return reject("whole-plan review is not ready to run");
      }
      state.phase = "whole_plan_review";
      state.wholePlanReview = {
        status: "reviewing",
        ...(state.wholePlanReview.epoch
          ? { epoch: state.wholePlanReview.epoch }
          : {}),
        ...(state.wholePlanReview.reviewRetry
          ? { reviewRetry: state.wholePlanReview.reviewRetry }
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
      if (state.wholePlanReview.reviewRetry) {
        state.wholePlanReview.reviewRetry.status = "completed";
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
          ...(state.wholePlanReview.reviewRetry
            ? { reviewRetry: state.wholePlanReview.reviewRetry }
            : {}),
        };
        return accept();
      }
      if (event.outcome.kind === "anchored") {
        const epoch = state.wholePlanReview.epoch;
        const latestCandidate = epoch?.latestRepair
          ? state.candidates[epoch.latestRepair.candidateId]
          : undefined;
        const workstream = latestCandidate?.workstream;
        const review = workstream
          ? workstreamReviewState(state, workstream)
          : undefined;
        if (
          !epoch?.latestRepair ||
          !latestCandidate ||
          !workstream ||
          !review ||
          epoch.latestRepair.publishedCommitSha !==
            event.outcome.reviewedTargetSha ||
          epoch.latestRepair.publishedTreeSha !==
            event.outcome.reviewedTargetTreeSha
        ) {
          return reject(
            "anchored whole-plan review lost its published repair boundary",
          );
        }
        try {
          const update = applyAnchoredWorkstreamReview({
            state: review,
            workstream,
            completion: event.outcome.completion,
            findings: epoch.findingIds.flatMap((id) => {
              const finding = state.findings[id];
              return finding ? [finding] : [];
            }),
            evidence: event.outcome.evidence,
          });
          if (update.findings.length < epoch.findingIds.length) {
            return reject(
              "anchored whole-plan review lost a canonical finding",
            );
          }
          for (const finding of update.findings) {
            state.findings[finding.id] = finding;
          }
          const nextReview = {
            ...update.review,
            pendingCorrectionIds: update.findings
              .filter((finding) => finding.status === "open")
              .map((finding) => finding.id),
          };
          state.reviews[reviewKey(workstream)] = nextReview;
          const nextEpoch = {
            ...epoch,
            findingIds: update.findings.map((finding) => finding.id),
            pendingCorrectionIds: nextReview.pendingCorrectionIds,
          };
          if (nextReview.pendingCorrectionIds.length === 0) {
            state.wholePlanReview = {
              status: "approved",
              evidence: event.outcome.evidence,
              reviewedTargetSha: event.outcome.reviewedTargetSha,
              reviewedTargetTreeSha: event.outcome.reviewedTargetTreeSha,
              epoch: nextEpoch,
              ...(state.wholePlanReview.reviewRetry
                ? { reviewRetry: state.wholePlanReview.reviewRetry }
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
              findingIds: nextReview.pendingCorrectionIds,
              evidence: event.outcome.evidence,
              epoch: nextEpoch,
            },
            reject,
          );
        } catch (error) {
          return reject(error instanceof Error ? error.message : String(error));
        }
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
          findingIds: initialFindings.map((finding) => finding.id),
          initialFindings,
          evidence: event.outcome.evidence,
          epoch: {
            initialTargetSha: event.outcome.reviewedTargetSha,
            initialTargetTreeSha: event.outcome.reviewedTargetTreeSha,
            findingIds: initialFindings.map((finding) => finding.id),
            pendingCorrectionIds: initialFindings.map((finding) => finding.id),
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
      settleLease(state, lease, "abandoned", event);
      workstream.phase = lease.reconciliationAssignmentId
        ? "reconciliation_required"
        : abandonedPhase(lease.kind);
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

    case "run_incomplete":
      if (!runCanSettleIncomplete(state)) {
        return reject("run still has safe work or unresolved settlement debt");
      }
      state.phase = "incomplete";
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
          (intent) =>
            !state.publication.receipts[intent.id] &&
            !state.publication.supersessions[intent.id] &&
            !state.publication.abandonments[intent.id],
        )
      ) {
        return reject("run still has incomplete workstreams or cleanup debt");
      }
      state.phase = "completed";
      return accept();

    case "projection_debt_recorded":
      if (
        event.debt.taskIds.some((taskId) => {
          const task = state.tasks[taskId];
          const workstream = task
            ? state.workstreams.source[task.workstreamId]
            : undefined;
          return (
            !task ||
            workstream?.phase === "failed" ||
            workstream?.phase === "dependency_skipped"
          );
        })
      ) {
        return reject("failed or skipped source tasks cannot be projected");
      }
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
    findingIds: string[];
    initialFindings?: Array<{
      id: string;
      summary: string;
      evidence: string;
      requiredChange: string;
      acceptanceCriteria: string[];
      disposition: "blocking" | "advisory";
    }>;
    evidence: string;
    epoch: WholePlanEpoch;
  },
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  if (
    !safeId(args.repairId) ||
    state.workstreams.overall[args.repairId] ||
    args.findingIds.length === 0
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
  if (
    args.findingIds.length === 0 ||
    new Set(args.findingIds).size !== args.findingIds.length
  ) {
    return reject("whole-plan repair has invalid canonical finding references");
  }
  if (args.initialFindings) {
    if (
      args.initialFindings.length !== args.findingIds.length ||
      args.initialFindings.some(
        (finding, index) => finding.id !== args.findingIds[index],
      )
    ) {
      return reject(
        "whole-plan initial findings do not match their canonical IDs",
      );
    }
    for (const finding of args.initialFindings) {
      if (state.findings[finding.id]) {
        return reject("whole-plan canonical finding ID already exists");
      }
      state.findings[finding.id] = {
        ...finding,
        candidateId: candidate.id,
        workstream,
        scope: {
          kind: "whole_plan",
          initialTargetSha: args.epoch.initialTargetSha,
          initialTargetTreeSha: args.epoch.initialTargetTreeSha,
        },
        origin: "initial",
        introducedRound: 0,
        status: "open",
      };
    }
  }
  if (args.findingIds.some((id) => state.findings[id]?.status !== "open")) {
    return reject(
      "whole-plan repair has missing or settled canonical findings",
    );
  }
  state.reviews[reviewKey(workstream)] = {
    candidateId: candidate.id,
    comparisonBase: candidate.integrationBaseSha ?? candidate.baseSha,
    round: 0,
    pendingCorrectionIds: [...args.findingIds],
    evidence: [args.evidence],
    observations: [],
  };
  state.wholePlanReview = {
    status: "repairing",
    epoch: args.epoch,
    ...(state.wholePlanReview.reviewRetry
      ? { reviewRetry: state.wholePlanReview.reviewRetry }
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

function startRevision(
  state: RunState,
  workstream: RuntimeWorkstream,
  now: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const current = getWorkstream(state, workstream);
  const assignment = Object.values(state.revisionAssignments).find(
    (candidate) =>
      candidate.status === "open" &&
      sameWorkstream(candidate.workstream, workstream),
  );
  if (
    !current ||
    !assignment ||
    current.phase !== "revising" ||
    current.candidateId !== assignment.candidateId ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeWorkerLeaseCount(state) >= state.run.workerConcurrency ||
    hasIntegrationLease(state)
  ) {
    return reject("workstream is not ready for its revision assignment");
  }
  const lease = createLease(state, workstream, "revision", now, 0);
  lease.revisionAssignmentId = assignment.id;
  state.processLeases[lease.id] = lease;
  return {
    state,
    effects: [
      {
        kind: "run_revision",
        workstream,
        leaseId: lease.id,
        candidateId: assignment.candidateId,
        assignmentId: assignment.id,
      },
    ],
    accepted: true,
  };
}

function startWorkspaceRecreation(
  state: RunState,
  id: string,
  now: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const recreation = state.workspaceRecreations[id];
  const current = recreation
    ? getWorkstream(state, recreation.workstream)
    : undefined;
  if (
    !recreation ||
    !current ||
    recreation.status !== "pending" ||
    current.phase !== "recreating_workspace" ||
    activeLeaseFor(state, recreation.workstream)
  ) {
    return reject("workspace recreation is not ready");
  }
  const lease = createLease(
    state,
    recreation.workstream,
    "workspace_recreation",
    now,
    0,
  );
  lease.workspaceRecreationId = recreation.id;
  state.processLeases[lease.id] = lease;
  recreation.status = "running";
  return {
    state,
    effects: [
      {
        kind: "recreate_workspace",
        workstream: recreation.workstream,
        leaseId: lease.id,
        recreationId: recreation.id,
      },
    ],
    accepted: true,
  };
}

function reconciliationContext(args: {
  workstream: RuntimeWorkstream;
  candidateTreeSha: string;
  targetSha: string;
  disposition: "overlap" | "conflict" | "changed_patch";
  paths: { candidate: string[]; target: string[]; replay: string[] };
}): RunState["reconciliationAssignments"][string]["context"] {
  const relevantPaths = [
    ...new Set([
      ...args.paths.candidate,
      ...args.paths.target,
      ...args.paths.replay,
    ]),
  ].sort();
  const workstream =
    args.workstream.kind === "source"
      ? { kind: "source" as const, id: args.workstream.id }
      : { kind: "overall" as const, repairId: args.workstream.repairId };
  return {
    key: `reconciliation-context-${sha256(
      JSON.stringify({
        workstream: workstreamId(args.workstream),
        candidateTreeSha: args.candidateTreeSha,
        targetSha: args.targetSha,
        disposition: args.disposition,
        relevantPaths,
      }),
    )}`,
    workstream,
    candidateTreeSha: args.candidateTreeSha,
    targetSha: args.targetSha,
    disposition: args.disposition,
    relevantPaths,
  };
}

function createReconciliationEscalation(
  state: RunState,
  assignment: RunState["reconciliationAssignments"][string],
): RunState["reconciliationAssignments"][string] {
  const id = `reconcile:${workstreamId(assignment.workstream)}:${assignment.candidateId}:escalated:${Object.keys(state.reconciliationAssignments).length + 1}`;
  return {
    ...assignment,
    id,
    semanticAttempt: "escalated",
    priorAttemptEvidence: [
      ...assignment.priorAttemptEvidence,
      assignment.evidence,
      ...(assignment.hookEvidence ? [assignment.hookEvidence] : []),
      ...assignment.attemptEvidence,
    ],
    attemptEvidence: [],
    status: "pending",
  };
}

function startReconciliationWorker(
  state: RunState,
  workstream: RuntimeWorkstream,
  now: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const current = getWorkstream(state, workstream);
  const assignment = Object.values(state.reconciliationAssignments).find(
    (candidate) =>
      candidate.status === "pending" &&
      sameWorkstream(candidate.workstream, workstream),
  );
  if (
    !current ||
    !assignment ||
    current.phase !== "reconciliation_required" ||
    current.candidateId !== assignment.candidateId ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeWorkerLeaseCount(state) > 0 ||
    hasIntegrationLease(state)
  ) {
    return reject("workstream is not ready for its reconciliation assignment");
  }
  const lease = createLease(state, workstream, "reconciliation", now, 0);
  lease.reconciliationAssignmentId = assignment.id;
  state.processLeases[lease.id] = lease;
  current.phase = "reconciling";
  return {
    state,
    effects: [
      {
        kind: "run_reconciliation_worker",
        workstream,
        leaseId: lease.id,
        candidateId: assignment.candidateId,
        assignmentId: assignment.id,
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
    [
      ...Object.values(state.processLeases),
      ...Object.values(state.operationSettlements),
    ].filter(
      (operation) =>
        sameWorkstream(operation.workstream, workstream) &&
        operation.kind === kind,
    ).length + 1;
  return {
    id: `${kind}:${state.run.id}:${state.revision + 1}:${Object.keys(state.operationSettlements).length + index}`,
    workstream,
    kind,
    ...(getWorkstream(state, workstream)?.candidateId
      ? { candidateId: getWorkstream(state, workstream)!.candidateId }
      : {}),
    attempt,
    acquiredAt,
  };
}

function settleLease(
  state: RunState,
  lease: ProcessLease,
  outcome: string,
  event: SchedulerEvent,
): void {
  const settlement = {
    operationId: lease.id,
    workstream: lease.workstream,
    kind: lease.kind,
    ...(lease.candidateId ? { candidateId: lease.candidateId } : {}),
    ...(lease.publicationIntentId
      ? { publicationIntentId: lease.publicationIntentId }
      : {}),
    ...(lease.revisionAssignmentId
      ? { revisionAssignmentId: lease.revisionAssignmentId }
      : {}),
    ...(lease.reconciliationAssignmentId
      ? { reconciliationAssignmentId: lease.reconciliationAssignmentId }
      : {}),
    ...(lease.workspaceRecreationId
      ? { workspaceRecreationId: lease.workspaceRecreationId }
      : {}),
    attempt: lease.attempt,
    acquiredAt: lease.acquiredAt,
    outcome,
    eventFingerprint: JSON.stringify(event),
    settledAt: new Date().toISOString(),
  };
  const previous = state.operationSettlements[lease.id];
  if (previous && JSON.stringify(previous) !== JSON.stringify(settlement)) {
    throw new Error(
      `operation ${lease.id} already has a conflicting settlement`,
    );
  }
  state.operationSettlements[lease.id] = settlement;
  delete state.processLeases[lease.id];
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

function isKnownOwnedDirtyWorkspace(
  state: RunState,
  workstream: RuntimeWorkstream,
  observation: WorkspaceObservation | undefined,
): boolean {
  const id = workstream.kind === "source" ? workstream.id : workstream.repairId;
  return (
    observation !== undefined &&
    !observation.clean &&
    observation.activeOperation === undefined &&
    observation.branch === `pipkin/implement/${state.run.id}/${id}`
  );
}

function processIsAllowed(
  state: RunState,
  workstream: RuntimeWorkstream,
): boolean {
  return workstream.kind === "source"
    ? state.phase === "running"
    : state.phase === "whole_plan_review";
}

function hasQuiescentApprovedCandidate(state: RunState): boolean {
  return (
    activeWorkerLeaseCount(state) === 0 &&
    !hasIntegrationLease(state) &&
    runtimeWorkstreams(state).some(
      (workstream) => getWorkstream(state, workstream)?.phase === "approved",
    )
  );
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
      lease.kind === "revision" ||
      lease.kind === "reconciliation" ||
      lease.kind === "workspace_recreation",
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

function recordFailure(
  state: RunState,
  args: {
    category: FailureCategory;
    assignment: RunState["failures"][string]["assignment"];
    workstream: RuntimeWorkstream;
    candidateId?: string;
    gate?: string;
    evidence: string;
    command?: FailureCommandEvidence;
    targetEvidence?: string;
    observation?: WorkspaceObservation;
  },
): void {
  const id = `failure:${workstreamId(args.workstream)}:${Object.keys(state.failures).length + 1}`;
  state.failures[id] = {
    id,
    category: args.category,
    assignment: args.assignment,
    workstream: args.workstream,
    ...(args.candidateId ? { candidateId: args.candidateId } : {}),
    ...(args.gate ? { gate: args.gate } : {}),
    evidence: boundedFailureOutput(args.evidence),
    ...(args.command
      ? {
          command: {
            ...args.command,
            output: boundedFailureOutput(args.command.output),
          },
        }
      : {}),
    ...(args.targetEvidence ? { targetEvidence: args.targetEvidence } : {}),
    ...(args.observation
      ? { observation: retainedObservation(args.observation) }
      : {}),
    at: new Date().toISOString(),
  };
}

function retainedObservation(
  observation: WorkspaceObservation,
): NonNullable<RunState["workspaceRecreations"][string]["before"]> {
  return {
    ...observation,
    status: observation.status.map((entry) => ({ ...entry })),
  };
}

function createRevisionAssignment(
  state: RunState,
  workstream: RuntimeWorkstream,
  candidateId: string,
  pendingCorrectionIds: string[],
  evidence: string,
  reject: (error: string) => SchedulerTransition,
): SchedulerTransition {
  const candidate = state.candidates[candidateId];
  const review = workstreamReviewState(state, workstream);
  const runtime = getWorkstream(state, workstream);
  if (
    !candidate ||
    !review ||
    !runtime ||
    review.candidateId !== candidateId ||
    !sameWorkstream(candidate.workstream, workstream)
  ) {
    return reject(
      "revision assignment requires the exact current reviewed candidate",
    );
  }
  if (
    JSON.stringify(review.pendingCorrectionIds) !==
    JSON.stringify(pendingCorrectionIds)
  ) {
    return reject(
      "revision assignment findings do not match the active review epoch",
    );
  }
  const id = `revision:${workstreamId(workstream)}:${candidate.commitSha}:${review.round}:${Object.keys(state.revisionAssignments).length + 1}`;
  const existing = state.revisionAssignments[id];
  if (existing && existing.status === "open") {
    return reject("current candidate already has an open revision assignment");
  }
  state.revisionAssignments[id] = {
    id,
    workstream,
    candidateId,
    comparisonBase: candidate.commitSha,
    findingEpoch: review.round,
    pendingCorrectionIds: [...pendingCorrectionIds],
    evidence: [boundedFailureOutput(evidence)],
    status: "open",
    executionFailures: 0,
    noProgress: {
      signature: noProgressSignature({
        workstream: workstreamId(workstream),
        candidateTree: candidate.treeSha,
        findingEpoch: review.round,
        pendingCorrectionIds,
      }),
      attempts: 0,
    },
  };
  runtime.phase = "revising";
  return { state, effects: [], accepted: true };
}

function createWorkspaceRecreation(
  state: RunState,
  workstream: RuntimeWorkstream,
  resumePhase:
    | "queued"
    | "candidate_ready"
    | "revising"
    | "reconciliation_required"
    | "approved",
  evidence: string,
): void {
  const runtime = getWorkstream(state, workstream)!;
  const candidateId = runtime.candidateId;
  const candidate = candidateId ? state.candidates[candidateId] : undefined;
  const checkpoint =
    candidate?.commitSha ??
    (workstream.kind === "source"
      ? state.workstreams.source[workstream.id]?.baseSha
      : undefined);
  if (!checkpoint) {
    throw new Error(
      "workspace recreation requires an exact admitted candidate or workstream base",
    );
  }
  const id = `workspace:${workstreamId(workstream)}:${checkpoint}:${Object.keys(state.workspaceRecreations).length + 1}`;
  state.workspaceRecreations[id] = {
    id,
    workstream,
    ...(candidateId ? { candidateId } : {}),
    checkpoint,
    resumePhase,
    status: "pending",
    evidence: [boundedFailureOutput(evidence)],
  };
}

function failWorkstream(state: RunState, workstream: RuntimeWorkstream): void {
  const runtime = getWorkstream(state, workstream);
  if (!runtime) {
    throw new Error("lane failure references an unknown workstream");
  }
  runtime.phase = "failed";
  if (
    workstream.kind === "overall" &&
    state.wholePlanReview.status === "repairing"
  ) {
    state.wholePlanReview = {
      status: "pending",
      ...(state.wholePlanReview.epoch
        ? { epoch: state.wholePlanReview.epoch }
        : {}),
      ...(state.wholePlanReview.reviewRetry
        ? { reviewRetry: state.wholePlanReview.reviewRetry }
        : {}),
    };
  }
  for (const assignment of Object.values(state.revisionAssignments)) {
    if (
      assignment.status === "open" &&
      sameWorkstream(assignment.workstream, workstream)
    ) {
      assignment.status = "blocked";
    }
  }
  for (const assignment of Object.values(state.reconciliationAssignments)) {
    if (
      assignment.status === "pending" &&
      sameWorkstream(assignment.workstream, workstream)
    ) {
      assignment.status = "blocked";
    }
  }
  for (const retry of Object.values(state.operationalRetries)) {
    if (
      retry.status === "open" &&
      sameWorkstream(retry.workstream, workstream)
    ) {
      retry.status = "exhausted";
    }
  }
  for (const recreation of Object.values(state.workspaceRecreations)) {
    if (
      recreation.status === "pending" &&
      sameWorkstream(recreation.workstream, workstream)
    ) {
      recreation.status = "unsafe";
    }
  }
  if (workstream.kind === "source") {
    propagateDependencySkips(state);
  }
}

function propagateDependencySkips(state: RunState): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const workstream of Object.values(state.workstreams.source).sort(
      (left, right) => left.id.localeCompare(right.id),
    )) {
      if (workstream.phase !== "queued") {
        continue;
      }
      const unavailable = workstream.dependsOn
        .map((id) => state.workstreams.source[id])
        .filter(
          (dependency): dependency is NonNullable<typeof dependency> =>
            dependency?.phase === "failed" ||
            dependency?.phase === "dependency_skipped",
        );
      if (unavailable.length === 0) {
        continue;
      }
      workstream.phase = "dependency_skipped";
      recordFailure(state, {
        category: "dependency_skipped",
        assignment: "dependency_skip",
        workstream: { kind: "source", id: workstream.id },
        gate: "dependency",
        evidence: `Unavailable direct dependencies: ${unavailable
          .map((dependency) => `${dependency.id} (${dependency.phase})`)
          .join(", ")}.`,
      });
      changed = true;
    }
  }
}

function completeOperationalRetries(
  state: RunState,
  workstream: RuntimeWorkstream,
  lane: RunState["operationalRetries"][string]["lane"],
): void {
  for (const retry of Object.values(state.operationalRetries)) {
    if (
      retry.status === "open" &&
      retry.lane === lane &&
      sameWorkstream(retry.workstream, workstream)
    ) {
      retry.status = "completed";
    }
  }
}

function scheduleOperationalRetry(
  state: RunState,
  workstream: RuntimeWorkstream,
  lane: RunState["operationalRetries"][string]["lane"],
  evidence: string,
  phase: "queued" | "candidate_ready" | "approved",
  reject: (error: string) => SchedulerTransition,
  provenNoWrite = false,
): SchedulerTransition {
  const runtime = getWorkstream(state, workstream);
  if (!runtime) {
    return reject("operational retry has no workstream");
  }
  const candidateId = runtime.candidateId;
  const id = `retry:${lane}:${workstreamId(workstream)}:${candidateId ?? "base"}`;
  const retry = state.operationalRetries[id] ?? {
    id,
    workstream,
    lane,
    ...(candidateId ? { candidateId } : {}),
    attempts: 0,
    evidence: [],
    status: "open" as const,
  };
  retry.attempts++;
  retry.evidence.push(boundedFailureOutput(evidence));
  if (retry.attempts >= 3) {
    retry.status = "exhausted";
    state.operationalRetries[id] = retry;
    if (lane === "publication") {
      const intent = Object.values(state.publication.intents).find(
        (candidate) =>
          sameWorkstream(candidate.workstream, workstream) &&
          candidate.candidateId === candidateId &&
          state.publication.receipts[candidate.id] === undefined &&
          state.publication.supersessions[candidate.id] === undefined &&
          state.publication.abandonments[candidate.id] === undefined,
      );
      if (!intent || !provenNoWrite) {
        return failRun(
          state,
          "publication_uncertain",
          "Publication retry exhaustion could not prove that its exact intent made no ref write.",
          new Date().toISOString(),
          reject,
        );
      }
      const operation = Object.values(state.operationSettlements)
        .filter(
          (settlement) =>
            settlement.kind === "publication" &&
            settlement.publicationIntentId === intent.id,
        )
        .at(-1);
      if (!operation) {
        return reject(
          "publication abandonment has no settled publication operation",
        );
      }
      state.publication.abandonments[intent.id] = {
        intentId: intent.id,
        publicationOperationId: operation.operationId,
        preparationOperationId: intent.operationId,
        workstream,
        candidateId: intent.candidateId,
        preparationId: intent.preparationId,
        targetRef: intent.targetRef,
        targetBaseSha: intent.targetBaseSha,
        evidence: boundedFailureOutput(evidence),
        abandonedAt: new Date().toISOString(),
      };
    }
    failWorkstream(state, workstream);
    return { state, effects: [], accepted: true };
  }
  state.operationalRetries[id] = retry;
  runtime.phase = phase;
  return { state, effects: [], accepted: true };
}

function workstreamId(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function canonicalReplayPaths(paths: readonly string[]): boolean {
  return (
    new Set(paths).size === paths.length &&
    paths.every(
      (path, index) =>
        path === path.trim() &&
        path !== "" &&
        !path.startsWith("/") &&
        !path.split("/").includes("..") &&
        (index === 0 || paths[index - 1]! < path),
    )
  );
}

function reviewIsCurrentForReconciliation(
  review: NonNullable<ReturnType<typeof workstreamReviewState>>,
  candidateId: string,
): boolean {
  return (
    review.candidateId === candidateId &&
    review.pendingCorrectionIds.length === 0
  );
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

export function allSourceWorkstreamsTerminal(state: RunState): boolean {
  return Object.values(state.workstreams.source).every((workstream) =>
    ["completed", "failed", "dependency_skipped"].includes(workstream.phase),
  );
}

function allOverallWorkstreamsTerminal(state: RunState): boolean {
  return Object.values(state.workstreams.overall).every((workstream) =>
    ["completed", "failed"].includes(workstream.phase),
  );
}

export function runCanSettleIncomplete(state: RunState): boolean {
  return (
    ["running", "whole_plan_review"].includes(state.phase) &&
    allSourceWorkstreamsTerminal(state) &&
    allOverallWorkstreamsTerminal(state) &&
    Object.keys(state.processLeases).length === 0 &&
    state.projectionDebt.length === 0 &&
    state.wholePlanReview.status !== "reviewing" &&
    state.wholePlanReview.status !== "repairing" &&
    !Object.values(state.operationalRetries).some(
      (retry) => retry.status === "open",
    ) &&
    !Object.values(state.workspaceRecreations).some(
      (recreation) =>
        recreation.status === "pending" || recreation.status === "running",
    ) &&
    !Object.values(state.revisionAssignments).some(
      (assignment) => assignment.status === "open",
    ) &&
    !Object.values(state.reconciliationAssignments).some(
      (assignment) => assignment.status === "pending",
    ) &&
    !wholePlanReviewCanProgress(state) &&
    Object.values(state.publication.intents).every(
      (intent) =>
        state.publication.receipts[intent.id] ||
        state.publication.supersessions[intent.id] ||
        state.publication.abandonments[intent.id],
    ) &&
    !(
      allSourceWorkstreamsComplete(state) &&
      Object.values(state.workstreams.overall).every(
        (workstream) => workstream.phase === "completed",
      ) &&
      state.wholePlanReview.status === "approved"
    )
  );
}

function wholePlanReviewCanProgress(state: RunState): boolean {
  return (
    allSourceWorkstreamsComplete(state) &&
    Object.values(state.workstreams.overall).every(
      (workstream) => workstream.phase === "completed",
    ) &&
    state.wholePlanReview.status === "pending" &&
    state.wholePlanReview.reviewRetry?.status !== "exhausted"
  );
}

function abandonedPhase(
  kind: ProcessLease["kind"],
):
  | "queued"
  | "candidate_ready"
  | "revising"
  | "recreating_workspace"
  | "approved" {
  if (kind === "implementation") {
    return "queued";
  }
  if (kind === "review") {
    return "candidate_ready";
  }
  if (kind === "revision") {
    return "revising";
  }
  if (kind === "workspace_recreation") {
    return "recreating_workspace";
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
    "revision_completed",
    "revision_failed",
    "reconciliation_worker_completed",
    "reconciliation_worker_failed",
    "publication_target_moved",
    "workspace_recreation_completed",
    "run_failed",
  ].includes(event.kind);
}

function safeId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}
