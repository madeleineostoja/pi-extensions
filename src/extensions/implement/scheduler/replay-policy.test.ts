import { afterEach, describe, expect, it } from "vitest";
import {
  publicationIntentId,
  publicationPreparationId,
  stagingIdentity,
} from "../candidate-replay.js";
import type { RunState } from "../store.js";
import { reduceRunEvent } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("replay preparation policy", () => {
  it("binds preparation and intent identity to the exact reconciliation operation and candidate", async () => {
    const requested = await requestedReconciliation();
    const candidate = requested.state.candidates[requested.candidateId]!;
    const preparation = preparationFor(
      requested.state,
      requested.effect.leaseId,
      candidate,
    );

    const recorded = reduceRunEvent(requested.state, {
      kind: "publication_preparation_recorded",
      operationId: requested.effect.leaseId,
      preparation,
    });
    expect(recorded.accepted).toBe(true);

    const crossCandidate = {
      ...preparation,
      id: publicationPreparationId({
        runId: requested.state.run.id,
        preparation: {
          ...preparation,
          candidateTreeSha: "another-tree",
        },
      }),
      candidateTreeSha: "another-tree",
    };
    expect(
      reduceRunEvent(requested.state, {
        kind: "publication_preparation_recorded",
        operationId: requested.effect.leaseId,
        preparation: crossCandidate,
      }).accepted,
    ).toBe(false);

    const intent = intentFor(
      recorded.state,
      requested.effect.leaseId,
      preparation,
    );
    const intentRecorded = reduceRunEvent(recorded.state, {
      kind: "publication_intent_recorded",
      operationId: requested.effect.leaseId,
      intent,
    });
    expect(intentRecorded.accepted).toBe(true);

    expect(
      reduceRunEvent(intentRecorded.state, {
        kind: "reconciliation_completed",
        workstream: requested.effect.workstream,
        leaseId: requested.effect.leaseId,
        outcome: {
          kind: "prepared",
          evidence: "prepared",
          workspace: {
            id: stagingIdentity({
              runId: requested.state.run.id,
              operationId: requested.effect.leaseId,
              candidateId: candidate.id,
              candidateCommitSha: candidate.commitSha,
              candidateTreeSha: candidate.treeSha,
              targetBaseSha: preparation.targetBaseSha,
              targetRef: preparation.targetRef,
            }).id,
            checkpoint: preparation.preparedCommitSha,
            changedPaths: [...preparation.changedPaths],
            targetSha: preparation.targetBaseSha,
            stateEvidence: "prepared",
            stagingComparison: {
              baseSha: preparation.targetBaseSha,
              treeSha: preparation.preparedTreeSha,
            },
          },
        },
      }).effects,
    ).toMatchObject([
      {
        kind: "run_publication",
        candidateId: candidate.id,
        intentId: intent.id,
      },
    ]);

    expect(
      reduceRunEvent(recorded.state, {
        kind: "publication_intent_recorded",
        operationId: "reconciliation:run-1:stale",
        intent: { ...intent, operationId: "reconciliation:run-1:stale" },
      }).accepted,
    ).toBe(false);
  });

  it("retains the exact failed replay target instead of inferring a later one", async () => {
    const requested = await requestedReconciliation();

    const settled = reduceRunEvent(requested.state, {
      kind: "reconciliation_completed",
      workstream: requested.effect.workstream,
      leaseId: requested.effect.leaseId,
      outcome: {
        kind: "reconciliation_required",
        evidence: "candidate and target overlap",
        failedReplay: {
          candidateCommitSha: "candidate-sha",
          candidateTreeSha: "candidate-tree",
          targetSha: "failed-target-sha",
          targetTreeSha: "failed-target-tree",
          disposition: "overlap",
          paths: {
            candidate: ["src/endpoint.ts"],
            target: ["src/endpoint.ts"],
            replay: ["src/endpoint.ts"],
          },
          staging: {
            id: "staging-failed",
            operationId: requested.effect.leaseId,
            branchName: "pipkin/implement/run-1/staging-failed",
            targetRef: "refs/heads/main",
          },
          evidence: "candidate and target overlap",
        },
        workspace: {
          id: "staging-failed",
          changedPaths: ["src/endpoint.ts"],
          targetSha: "failed-target-sha",
          stateEvidence: "overlap",
        },
      },
    });

    expect(settled.accepted).toBe(true);
    expect(Object.values(settled.state.reconciliationAssignments)).toEqual([
      expect.objectContaining({
        candidateId: requested.candidateId,
        targetSha: "failed-target-sha",
        disposition: "overlap",
        paths: {
          candidate: ["src/endpoint.ts"],
          target: ["src/endpoint.ts"],
          replay: ["src/endpoint.ts"],
        },
        status: "pending",
      }),
    ]);
  });
});

async function requestedReconciliation() {
  const store = await createSchedulerStore();
  const started = reduceRunEvent(store.read(), {
    kind: "workstreams_selected",
    now: "2026-01-01T00:00:00.000Z",
    baseShas: { "first-stream": "base-sha" },
  });
  const implementation = started.effects[0]!;
  if (implementation.kind !== "run_implementation") {
    throw new Error("expected implementation");
  }
  const admitted = reduceRunEvent(started.state, {
    kind: "implementation_completed",
    workstream: implementation.workstream,
    leaseId: implementation.leaseId,
    outcome: {
      kind: "candidate_ready",
      candidate: candidate(),
      checkpoints: { first: "candidate-sha" },
      satisfied: {},
    },
  });
  const reviewRequested = reduceRunEvent(admitted.state, {
    kind: "review_requested",
    workstream: implementation.workstream,
    now: "2026-01-01T00:01:00.000Z",
  });
  const review = reviewRequested.effects[0]!;
  if (review.kind !== "run_review") {
    throw new Error("expected review");
  }
  const approved = reduceRunEvent(reviewRequested.state, {
    kind: "review_completed",
    workstream: review.workstream,
    leaseId: review.leaseId,
    outcome: {
      kind: "initial",
      candidateId: "candidate:first",
      evidence: "review artifact",
      completion: {
        verdict: "approved",
        publicationCommitSubject: "feat: publish candidate",
      },
    },
  });
  const requested = reduceRunEvent(approved.state, {
    kind: "reconciliation_requested",
    workstream: implementation.workstream,
    now: "2026-01-01T00:02:00.000Z",
  });
  const effect = requested.effects[0]!;
  if (effect.kind !== "run_reconciliation") {
    throw new Error("expected reconciliation");
  }
  return { state: requested.state, effect, candidateId: "candidate:first" };
}

function candidate(): RunState["candidates"][string] {
  return {
    id: "candidate:first",
    workstream: { kind: "source", id: "first-stream" },
    baseSha: "base-sha",
    commitSha: "candidate-sha",
    treeSha: "candidate-tree",
    evidenceStatus: "reported",
    changedPaths: ["src/endpoint.ts"],
    implementationEvidence: {
      summary: "implemented",
      verification: ["tests pass"],
    },
  };
}

function preparationFor(
  state: RunState,
  operationId: string,
  candidate: RunState["candidates"][string],
): RunState["publication"]["preparations"][string] {
  const targetBaseSha = candidate.baseSha;
  const targetRef = state.run.checkout.branchRef;
  const staging = stagingIdentity({
    runId: state.run.id,
    operationId,
    candidateId: candidate.id,
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    targetBaseSha,
    targetRef,
  });
  const preparation = {
    operationId,
    candidateId: candidate.id,
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    targetBaseSha,
    targetRef,
    preparedCommitSha: "prepared-sha",
    preparedTreeSha: "prepared-tree",
    stagingWorktree: `${state.run.checkout.root}/.pi/pipkin/implement/worktrees/${state.run.id}/${staging.id}`,
    stagingBranch: staging.branchName,
    replayPatchHash: "a".repeat(64),
    changedPaths: ["src/endpoint.ts"],
    disposition: "same_base" as const,
    hookEvidence: "git commit completed",
    hookCommand: {
      command: "git commit",
      cwd: "staging",
      exitCode: 0,
      timedOut: false,
      output: "",
    },
  };
  return {
    id: publicationPreparationId({ runId: state.run.id, preparation }),
    ...preparation,
  };
}

function intentFor(
  state: RunState,
  operationId: string,
  preparation: RunState["publication"]["preparations"][string],
): RunState["publication"]["intents"][string] {
  return {
    id: publicationIntentId({
      runId: state.run.id,
      operationId,
      preparation,
    }),
    operationId,
    workstream: { kind: "source", id: "first-stream" },
    candidateId: preparation.candidateId,
    preparationId: preparation.id,
    targetBaseSha: preparation.targetBaseSha,
    preparedCommitSha: preparation.preparedCommitSha,
    preparedTreeSha: preparation.preparedTreeSha,
    targetRef: preparation.targetRef,
    protectedArtifactSnapshots: {},
    protectedArtifactHashes: {},
  };
}
