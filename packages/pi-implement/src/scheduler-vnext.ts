import type { ExecutionPlan } from "./execution-plan-vnext.js";
import {
  advanceNoActionCycle,
  boundedRecoveryOutput,
  providerRetryDelayMs,
  recoveryCycleSignature,
  type RecoveryAction,
  type RecoveryGateResult,
} from "./recovery-vnext.js";
import {
  applyAnchoredWorkstreamReview,
  applyInitialWorkstreamReview,
  retargetAnchoredReview,
  reviewKey,
  workstreamReviewState,
  type VNextReviewOutcome,
} from "./vnext-review.js";
import {
  StaleVNextRevisionError,
  type VNextRunState,
  type VNextRunStore,
} from "./vnext-store.js";

export type RuntimeWorkstream =
  VNextRunState["candidates"][string]["workstream"];
type ProcessLease = VNextRunState["processLeases"][string];

type ImplementationOutcome =
  | {
      kind: "candidate_ready";
      candidate: VNextRunState["candidates"][string];
      checkpoints: Record<string, string>;
      satisfied: Record<string, string>;
    }
  | {
      kind: "satisfaction_claimed";
      candidate: VNextRunState["candidates"][string];
      evidence: Record<string, string>;
    };

export type VNextSchedulerEvent =
  | { kind: "workstreams_selected"; now: string }
  | {
      kind: "implementation_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: ImplementationOutcome;
    }
  | { kind: "review_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "gate_recorded";
      workstream: RuntimeWorkstream;
      result: RecoveryGateResult;
      workspace: {
        id: string;
        checkpoint?: string;
        changedPaths: string[];
        stateEvidence: string;
      };
    }
  | {
      kind: "review_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      outcome: VNextReviewOutcome;
    }
  | { kind: "recovery_requested"; workstream: RuntimeWorkstream; now: string }
  | {
      kind: "recovery_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      action: RecoveryAction;
      candidate?: VNextRunState["candidates"][string];
      correction?: {
        fromCandidateId: string;
        changedPaths: string[];
        evidence: string;
      };
    }
  | {
      kind: "recovery_provider_failed";
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
            };
          }
        | {
            kind: "reconciliation_required";
            evidence: string;
            workspace: {
              id: string;
              checkpoint?: string;
              changedPaths: string[];
              stateEvidence: string;
            };
          };
    }
  | {
      kind: "publication_intent_recorded";
      intent: VNextRunState["publication"]["intents"][string];
    }
  | {
      kind: "publication_requested";
      workstream: RuntimeWorkstream;
      intentId: string;
      now: string;
    }
  | {
      kind: "publication_receipt_recorded";
      receipt: VNextRunState["publication"]["receipts"][string];
    }
  | {
      kind: "publication_completed";
      workstream: RuntimeWorkstream;
      leaseId: string;
      intentId: string;
    }
  | { kind: "whole_plan_review_requested" }
  | { kind: "overall_repair_queued"; repairId: string }
  | { kind: "whole_plan_review_completed" }
  | { kind: "process_abandoned"; leaseId: string }
  | { kind: "stop_requested"; reason?: string }
  | { kind: "run_paused"; reason?: string }
  | { kind: "resume_requested" }
  | { kind: "safety_blocked"; reason: string }
  | { kind: "run_completed" }
  | {
      kind: "projection_debt_recorded";
      debt: VNextRunState["projectionDebt"][number];
    }
  | { kind: "projection_debt_settled"; debtId: string }
  | {
      kind: "cleanup_debt_recorded";
      debt: VNextRunState["cleanupDebt"][number];
    }
  | { kind: "cleanup_debt_settled"; debtId: string };

export type VNextSchedulerEffect =
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
      retryAfterMs?: number;
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
  | { kind: "run_projection"; debtId: string }
  | { kind: "run_cleanup"; debtId: string };

export type VNextSchedulerTransition = {
  state: VNextRunState;
  effects: VNextSchedulerEffect[];
  accepted: boolean;
  error?: string;
};

export function selectReadyWorkstreams(state: VNextRunState): string[] {
  return selectReadyRuntimeWorkstreams(state)
    .filter(
      (workstream): workstream is { kind: "source"; id: string } =>
        workstream.kind === "source",
    )
    .map((workstream) => workstream.id);
}

export function selectReadyRuntimeWorkstreams(
  state: VNextRunState,
): RuntimeWorkstream[] {
  const capacity = state.run.workerConcurrency - activeLeaseCount(state);
  if (capacity <= 0) {
    return [];
  }
  if (state.phase === "running") {
    return Object.values(state.workstreams.source)
      .filter(
        (workstream) =>
          workstream.phase === "queued" &&
          workstream.dependsOn.every(
            (dependency) =>
              state.workstreams.source[dependency]?.phase === "completed",
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

export function reduceVNextRunEvent(
  input: VNextRunState,
  event: VNextSchedulerEvent,
): VNextSchedulerTransition {
  const state = structuredClone(input);
  const reject = (error: string): VNextSchedulerTransition => ({
    state: input,
    effects: [],
    accepted: false,
    error,
  });
  const accept = (
    effects: VNextSchedulerEffect[] = [],
  ): VNextSchedulerTransition => ({ state, effects, accepted: true });

  if (state.phase === "blocked_safety" || state.phase === "completed") {
    return reject("terminal runs do not accept lifecycle events");
  }
  if (state.phase === "paused" && event.kind !== "resume_requested") {
    return reject("paused runs must resume before accepting lifecycle events");
  }
  if (
    state.phase === "stopping" &&
    event.kind !== "process_abandoned" &&
    event.kind !== "run_paused"
  ) {
    return reject("stopping runs only settle owned processes");
  }

  switch (event.kind) {
    case "workstreams_selected": {
      const ready = selectReadyRuntimeWorkstreams(state);
      const effects: VNextSchedulerEffect[] = [];
      for (const [index, workstream] of ready.entries()) {
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
        !processIsAllowed(state, event.workstream)
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
        const cycle = advanceNoActionCycle({
          cycle: episode.cycle,
          signature: recoverySignatureFor(
            state,
            episode,
            "no_safe_action",
            event.action.evidence,
          ),
        });
        episode.cycle = cycle.cycle;
        episode.actions.push(event.action);
        episode.providerFailures = 0;
        delete episode.retryAfterMs;
        delete state.processLeases[lease.id];
        if (cycle.disposition === "pause") {
          episode.status = "paused";
          state.pause = {
            resumePhase:
              state.phase === "whole_plan_review"
                ? "whole_plan_review"
                : "running",
            reason: "Recovery repeated an identical no-safe-action cycle.",
          };
          state.phase = "paused";
        }
        return accept();
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
      episode.providerFailures = 0;
      delete episode.retryAfterMs;
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
      }
      return accept();
    }

    case "recovery_provider_failed": {
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
          "provider failure does not own an active recovery episode",
        );
      }
      const providerFailures = episode.providerFailures + 1;
      episode.providerFailures = providerFailures;
      episode.retryAfterMs = providerRetryDelayMs(providerFailures);
      episode.actions.push({
        kind: "retry",
        outcome: "provider_failure",
        summary: "Recovery provider failed before a successful model turn.",
        evidence: event.error,
        at: event.now,
      });
      delete state.processLeases[lease.id];
      if (providerFailures >= 3) {
        episode.status = "paused";
        state.pause = {
          resumePhase:
            state.phase === "whole_plan_review"
              ? "whole_plan_review"
              : "running",
          reason:
            "Recovery provider failed three times without a successful model turn.",
        };
        state.phase = "paused";
      }
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
      delete state.processLeases[lease.id];
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
          workstream.phase = "approved";
          return accept();
        } catch (error) {
          return reject(error instanceof Error ? error.message : String(error));
        }
      }
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
            outcome: "failed",
            evidence: event.outcome.evidence,
            outstandingFindingIds: [],
          },
          event.outcome.workspace,
        );
        return accept();
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
    }

    case "publication_intent_recorded": {
      const candidate = state.candidates[event.intent.candidateId];
      if (!candidate) {
        return reject("publication intent references an unknown candidate");
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
        activeLeaseCount(state) >= state.run.workerConcurrency ||
        Object.values(state.processLeases).some(
          (lease) => lease.kind === "publication",
        )
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
      if (event.workstream.kind === "overall") {
        state.wholePlanReview.status = "pending";
      }
      return accept();
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
      state.wholePlanReview.status = "reviewing";
      return accept([{ kind: "run_whole_plan_review" }]);

    case "overall_repair_queued":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing" ||
        !allSourceWorkstreamsComplete(state) ||
        !safeId(event.repairId) ||
        state.workstreams.overall[event.repairId]
      ) {
        return reject("overall repair is not valid in the current run phase");
      }
      state.workstreams.overall[event.repairId] = {
        kind: "overall",
        repairId: event.repairId,
        phase: "queued",
      };
      state.wholePlanReview.status = "repairing";
      return accept();

    case "whole_plan_review_completed":
      if (
        state.phase !== "whole_plan_review" ||
        state.wholePlanReview.status !== "reviewing" ||
        Object.values(state.workstreams.overall).some(
          (workstream) => workstream.phase !== "completed",
        )
      ) {
        return reject("whole-plan review cannot complete while repairs exist");
      }
      state.wholePlanReview.status = "approved";
      return accept();

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
              "The actor retained the candidate and will resume recovery.",
            at: lease.acquiredAt,
          });
        }
      }
      return accept();
    }

    case "stop_requested":
      if (
        state.phase !== "planning" &&
        state.phase !== "running" &&
        state.phase !== "whole_plan_review"
      ) {
        return reject("only an active run can stop");
      }
      state.pause = {
        resumePhase: state.phase,
        ...(event.reason ? { reason: event.reason } : {}),
      };
      state.phase = "stopping";
      return accept();

    case "run_paused":
      if (
        state.phase !== "stopping" ||
        Object.keys(state.processLeases).length > 0
      ) {
        return reject("run cannot pause before owned processes settle");
      }
      state.phase = "paused";
      return accept();

    case "resume_requested":
      if (state.phase !== "paused") {
        return reject("only a paused run can resume");
      }
      state.phase = state.pause!.resumePhase;
      for (const episode of Object.values(state.recoveryEpisodes)) {
        if (episode.status === "paused") {
          episode.status = "open";
          episode.providerFailures = 0;
          delete episode.retryAfterMs;
        }
      }
      delete state.pause;
      return accept();

    case "safety_blocked":
      if (Object.keys(state.processLeases).length > 0) {
        return reject("safety block requires owned processes to settle first");
      }
      state.phase = "blocked_safety";
      state.terminalReason = event.reason;
      return accept();

    case "run_completed":
      if (
        state.phase !== "whole_plan_review" ||
        !allSourceWorkstreamsComplete(state) ||
        Object.values(state.workstreams.overall).some(
          (workstream) => workstream.phase !== "completed",
        ) ||
        state.projectionDebt.length > 0 ||
        state.cleanupDebt.length > 0 ||
        Object.keys(state.processLeases).length > 0 ||
        state.wholePlanReview.status !== "approved"
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

    case "cleanup_debt_recorded":
      if (!state.cleanupDebt.some((debt) => debt.id === event.debt.id)) {
        state.cleanupDebt.push(event.debt);
        return accept([{ kind: "run_cleanup", debtId: event.debt.id }]);
      }
      return accept();

    case "cleanup_debt_settled":
      if (!state.cleanupDebt.some((debt) => debt.id === event.debtId)) {
        return reject("cleanup debt does not exist");
      }
      state.cleanupDebt = state.cleanupDebt.filter(
        (debt) => debt.id !== event.debtId,
      );
      return accept();
  }
}

export type VNextEffectExecution = (args: {
  effect: VNextSchedulerEffect;
  signal: AbortSignal;
  dispatch: (event: VNextSchedulerEvent) => Promise<void>;
}) => Promise<void>;

export type VNextPlannerExecution = (args: {
  signal: AbortSignal;
}) => Promise<ExecutionPlan>;

export type VNextSchedulerActorOptions = {
  store: VNextRunStore;
  executeEffect?: VNextEffectExecution;
  executePlanner?: VNextPlannerExecution;
  onTransition?: (
    state: VNextRunState,
    event: VNextSchedulerEvent | { kind: "planner_bound" },
  ) => void;
  awaitOwnedProcesses?: () => Promise<void>;
  now?: () => string;
};

export class VNextSchedulerActor {
  private readonly controller = new AbortController();
  private readonly processes = new Map<string, Promise<void>>();
  private readonly processControllers = new Map<string, AbortController>();
  private readonly now: () => string;
  private queue = Promise.resolve();
  private stopping = false;

  constructor(private readonly options: VNextSchedulerActorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): VNextRunState {
    return this.options.store.read();
  }

  async start(): Promise<void> {
    await this.reconcileAbandonedProcesses();
    if (this.snapshot().phase === "planning") {
      this.startPlanner();
      return;
    }
    if (["running", "whole_plan_review"].includes(this.snapshot().phase)) {
      if (
        this.snapshot().phase === "whole_plan_review" &&
        this.snapshot().wholePlanReview.status === "reviewing"
      ) {
        this.startEffect({ kind: "run_whole_plan_review" });
      }
      for (const debt of this.snapshot().projectionDebt) {
        this.startEffect({ kind: "run_projection", debtId: debt.id });
      }
      for (const debt of this.snapshot().cleanupDebt) {
        this.startEffect({ kind: "run_cleanup", debtId: debt.id });
      }
      await this.resumeOpenRecoveries();
      await this.schedule();
    }
  }

  private async resumeOpenRecoveries(): Promise<void> {
    const episodes = Object.values(this.snapshot().recoveryEpisodes).filter(
      (episode) => episode.status === "open",
    );
    for (const episode of episodes) {
      if (this.snapshot().phase === "paused") {
        return;
      }
      const hasLease = Object.values(this.snapshot().processLeases).some(
        (lease) => lease.recoveryEpisodeId === episode.id,
      );
      if (!hasLease) {
        await this.dispatch({
          kind: "recovery_requested",
          workstream: episode.workstream,
          now: this.now(),
        });
      }
    }
  }

  async schedule(): Promise<boolean> {
    if (
      this.stopping ||
      !["running", "whole_plan_review"].includes(this.snapshot().phase)
    ) {
      return false;
    }
    const effects = await this.dispatch({
      kind: "workstreams_selected",
      now: this.now(),
    });
    return effects.some((effect) => effect.kind === "run_implementation");
  }

  async dispatch(event: VNextSchedulerEvent): Promise<VNextSchedulerEffect[]> {
    const operation = this.queue.then(async () => {
      for (;;) {
        const current = this.options.store.read();
        const transition = reduceVNextRunEvent(current, event);
        if (!transition.accepted) {
          throw new VNextSchedulerActorError(
            transition.error ?? `Reducer rejected ${event.kind}.`,
          );
        }
        try {
          const state = await this.options.store.update(
            current.revision,
            () => transition.state,
          );
          try {
            this.options.onTransition?.(state, event);
          } catch {
            // Projection callbacks are not state authority.
          }
          for (const effect of transition.effects) {
            this.startEffect(effect);
          }
          return transition.effects;
        } catch (error) {
          if (error instanceof StaleVNextRevisionError) {
            continue;
          }
          throw error;
        }
      }
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    const effects = await operation;
    if (
      !this.stopping &&
      [
        "implementation_completed",
        "review_completed",
        "recovery_completed",
        "recovery_provider_failed",
        "publication_completed",
        "process_abandoned",
      ].includes(event.kind)
    ) {
      if (
        [
          "recovery_completed",
          "recovery_provider_failed",
          "process_abandoned",
        ].includes(event.kind)
      ) {
        await this.resumeOpenRecoveries();
      }
      await this.schedule();
    }
    return effects;
  }

  async stop(reason?: string): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (
        ["planning", "running", "whole_plan_review"].includes(
          this.snapshot().phase,
        )
      ) {
        await this.dispatch({ kind: "stop_requested", reason });
      }
      this.controller.abort();
      for (const controller of this.processControllers.values()) {
        controller.abort();
      }
    }
    while (this.processes.size > 0) {
      await Promise.allSettled(this.processes.values());
    }
    await this.options.awaitOwnedProcesses?.();
    if (this.snapshot().phase === "stopping") {
      await this.dispatch({ kind: "run_paused", reason });
    }
  }

  async settle(): Promise<void> {
    for (;;) {
      if (this.processes.size > 0) {
        await Promise.allSettled(this.processes.values());
      }
      if (this.processes.size === 0 && !(await this.schedule())) {
        return;
      }
    }
  }

  async blockSafety(reason: string): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    for (const controller of this.processControllers.values()) {
      controller.abort();
    }
    while (this.processes.size > 0) {
      await Promise.allSettled(this.processes.values());
    }
    await this.options.awaitOwnedProcesses?.();
    await this.dispatch({ kind: "safety_blocked", reason });
  }

  private startPlanner(): void {
    if (!this.options.executePlanner || this.processes.has("planner")) {
      return;
    }
    const controller = linkedAbortController(this.controller.signal);
    this.processControllers.set("planner", controller);
    const process = this.options
      .executePlanner({ signal: controller.signal })
      .then(async (plan) => {
        if (controller.signal.aborted) {
          return;
        }
        const state = await this.options.store.bindExecutionPlan(plan);
        try {
          this.options.onTransition?.(state, { kind: "planner_bound" });
        } catch {
          // Projection callbacks are not state authority.
        }
        await this.schedule();
      })
      .finally(() => {
        this.processes.delete("planner");
        this.processControllers.delete("planner");
      });
    this.processes.set("planner", process);
  }

  private startEffect(effect: VNextSchedulerEffect): void {
    if (!this.options.executeEffect) {
      return;
    }
    const key = effectKey(effect);
    if (this.processes.has(key)) {
      return;
    }
    const controller = linkedAbortController(this.controller.signal);
    this.processControllers.set(key, controller);
    const process = Promise.resolve()
      .then(async () => {
        if (effect.kind === "run_recovery" && effect.retryAfterMs) {
          await abortableDelay(effect.retryAfterMs, controller.signal);
        }
        await this.options.executeEffect!({
          effect,
          signal: controller.signal,
          dispatch: async (event) => {
            await this.dispatch(event);
          },
        });
      })
      .catch(async (error) => {
        if (
          effect.kind === "run_recovery" &&
          this.snapshot().processLeases[effect.leaseId]
        ) {
          await this.dispatch({
            kind: "recovery_provider_failed",
            workstream: effect.workstream,
            leaseId: effect.leaseId,
            error: error instanceof Error ? error.message : String(error),
            now: this.now(),
          });
        }
      })
      .finally(async () => {
        this.processes.delete(key);
        this.processControllers.delete(key);
        const leaseId = "leaseId" in effect ? effect.leaseId : undefined;
        if (leaseId && this.snapshot().processLeases[leaseId]) {
          await this.dispatch({ kind: "process_abandoned", leaseId });
        }
      });
    this.processes.set(key, process);
  }

  private async reconcileAbandonedProcesses(): Promise<void> {
    for (const lease of Object.values(this.snapshot().processLeases)) {
      await this.dispatch({ kind: "process_abandoned", leaseId: lease.id });
    }
  }
}

export class VNextSchedulerActorError extends Error {}

function startProcess(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  kind: "review",
  now: string,
  reject: (error: string) => VNextSchedulerTransition,
): VNextSchedulerTransition {
  const current = getWorkstream(state, workstream);
  const allowed = kind === "review" && current?.phase === "candidate_ready";
  if (
    !allowed ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeLeaseCount(state) >= state.run.workerConcurrency
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
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  now: string,
  reject: (error: string) => VNextSchedulerTransition,
): VNextSchedulerTransition {
  const current = getWorkstream(state, workstream);
  const episode = openRecoveryEpisodeForWorkstream(state, workstream);
  if (
    !current ||
    !episode ||
    episode.status !== "open" ||
    current.phase !== "recovering" ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeLeaseCount(state) >= state.run.workerConcurrency
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
        ...(episode.retryAfterMs ? { retryAfterMs: episode.retryAfterMs } : {}),
      },
    ],
    accepted: true,
  };
}

function startReconciliation(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  now: string,
  reject: (error: string) => VNextSchedulerTransition,
): VNextSchedulerTransition {
  const current = getWorkstream(state, workstream);
  const candidateId = current?.candidateId;
  if (
    !current ||
    !candidateId ||
    current.phase !== "approved" ||
    !processIsAllowed(state, workstream) ||
    activeLeaseFor(state, workstream) ||
    activeLeaseCount(state) >= state.run.workerConcurrency
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
  state: VNextRunState,
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
  state: VNextRunState,
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
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): boolean {
  return workstream.kind === "source"
    ? state.phase === "running"
    : state.phase === "whole_plan_review";
}

function activeLeaseFor(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): boolean {
  return Object.values(state.processLeases).some((lease) =>
    sameWorkstream(lease.workstream, workstream),
  );
}

function activeLeaseCount(state: VNextRunState): number {
  return Object.keys(state.processLeases).length;
}

function getWorkstream(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
):
  | VNextRunState["workstreams"]["source"][string]
  | VNextRunState["workstreams"]["overall"][string]
  | undefined {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]
    : state.workstreams.overall[workstream.repairId];
}

function recordGateResult(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  result: RecoveryGateResult,
  workspace: VNextRunState["recoveryEpisodes"][string]["workspace"],
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
    cycle: {
      signature: recoveryCycleSignature({
        gateId: result.id,
        candidateTree: candidate?.treeSha,
        failureEvidence: result.evidence,
        workspaceEvidence: workspace.stateEvidence,
        outstandingFindings: result.outstandingFindingIds.map((id) => ({
          id,
          evidence: state.findings[id]?.evidence ?? "",
        })),
        workspaceId: workspace.id,
        nextAction: "retry",
      }),
      identicalNoActionCycles: 0,
      independentlyEscalated: false,
    },
    providerFailures: 0,
    actions: [],
  };
}

function recoveryWorkspace(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  candidateId?: string,
): VNextRunState["recoveryEpisodes"][string]["workspace"] {
  const candidate = candidateId ? state.candidates[candidateId] : undefined;
  return {
    id: workstreamId(workstream),
    ...(candidate ? { checkpoint: candidate.commitSha } : {}),
    changedPaths: [],
    stateEvidence: "Workspace state was retained by the failed gate.",
  };
}

function openRecoveryEpisodeForWorkstream(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
): VNextRunState["recoveryEpisodes"][string] | undefined {
  return Object.values(state.recoveryEpisodes)
    .filter(
      (episode) =>
        episode.status === "open" &&
        sameWorkstream(episode.workstream, workstream),
    )
    .at(-1);
}

function recoverySignatureFor(
  state: VNextRunState,
  episode: VNextRunState["recoveryEpisodes"][string],
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

function workstreamId(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function sourceTaskOutcomeIsComplete(
  state: VNextRunState,
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
  state: VNextRunState,
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

function taskIdOwner(state: VNextRunState, taskId: string): string {
  return state.tasks[taskId]!.workstreamId;
}

function allSourceWorkstreamsComplete(state: VNextRunState): boolean {
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

function sameWorkstream(
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

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || milliseconds === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function effectKey(effect: VNextSchedulerEffect): string {
  if ("leaseId" in effect) {
    return effect.leaseId;
  }
  if ("debtId" in effect) {
    return `${effect.kind}:${effect.debtId}`;
  }
  return effect.kind;
}

function safeId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function linkedAbortController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}
