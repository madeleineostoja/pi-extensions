import { afterEach, describe, expect, it } from "vitest";
import {
  publicationIntentId,
  publicationPreparationId,
  stagingIdentity,
} from "../candidate-replay.js";
import type { GitClient } from "../git.js";
import type { RunState } from "../store.js";
import { settlePublicationTransactions } from "../transaction-settlement.js";
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

  it("supersedes only the exact pre-CAS intent and returns it to reconciliation", async () => {
    const ready = await publicationReady();
    const moved = reduceRunEvent(ready.state, {
      kind: "publication_target_moved",
      workstream: ready.effect.workstream,
      leaseId: ready.effect.leaseId,
      intentId: ready.effect.intentId,
      candidateId: ready.effect.candidateId,
      expectedTargetSha: ready.intent.targetBaseSha,
      actualTargetSha: "external-descendant-sha",
    });

    expect(moved.accepted).toBe(true);
    expect(moved.state.workstreams.source["first-stream"]).toMatchObject({
      phase: "approved",
      candidateId: ready.effect.candidateId,
    });
    expect(moved.state.publication.supersessions[ready.intent.id]).toEqual(
      expect.objectContaining({
        intentId: ready.intent.id,
        publicationOperationId: ready.effect.leaseId,
        preparationOperationId: ready.intent.operationId,
        expectedTargetSha: ready.intent.targetBaseSha,
        actualTargetSha: "external-descendant-sha",
      }),
    );
    expect(moved.state.processLeases[ready.effect.leaseId]).toBeUndefined();
    expect(moved.state.operationSettlements[ready.effect.leaseId]).toEqual(
      expect.objectContaining({ outcome: "publication_target_moved" }),
    );
    expect(
      reduceRunEvent(moved.state, {
        kind: "publication_requested",
        workstream: ready.effect.workstream,
        intentId: ready.intent.id,
        now: "2026-01-01T00:04:00.000Z",
      }).accepted,
    ).toBe(false);
    await ready.store.update(ready.store.read().revision, () => moved.state);
    expect(
      ready.store.read().publication.supersessions[ready.intent.id],
    ).toEqual(
      expect.objectContaining({ actualTargetSha: "external-descendant-sha" }),
    );
    await expect(
      settlePublicationTransactions({
        store: ready.store,
        git: {} as GitClient,
      }),
    ).resolves.toBeUndefined();
  });

  it("abandons an exhausted publication only after a proven no-write recovery", async () => {
    const ready = await publicationReady();
    let state = ready.state;
    let effect = ready.effect;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = reduceRunEvent(state, {
        kind: "effect_failed",
        effect: "publication",
        workstream: effect.workstream,
        leaseId: effect.leaseId,
        category: "provider_failure",
        evidence: `publication retry ${attempt}`,
        ...(attempt === 3 ? { provenNoWrite: true } : {}),
      });
      expect(failed.accepted).toBe(true);
      state = failed.state;
      if (attempt < 3) {
        const requested = reduceRunEvent(state, {
          kind: "publication_requested",
          workstream: effect.workstream,
          intentId: ready.intent.id,
          now: `2026-01-01T00:0${attempt + 3}:00.000Z`,
        });
        effect = requested.effects[0]! as typeof effect;
        state = requested.state;
      }
    }

    expect(state.workstreams.source["first-stream"]?.phase).toBe("failed");
    expect(state.publication.abandonments[ready.intent.id]).toMatchObject({
      intentId: ready.intent.id,
      publicationOperationId: effect.leaseId,
      targetBaseSha: ready.intent.targetBaseSha,
    });
    await ready.store.update(ready.store.read().revision, () => state);
    expect(
      ready.store.read().publication.abandonments[ready.intent.id],
    ).toBeDefined();
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
  return {
    store,
    state: requested.state,
    effect,
    candidateId: "candidate:first",
  };
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

async function publicationReady() {
  const requested = await requestedReconciliation();
  const candidate = requested.state.candidates[requested.candidateId]!;
  const preparation = preparationFor(
    requested.state,
    requested.effect.leaseId,
    candidate,
  );
  const prepared = reduceRunEvent(requested.state, {
    kind: "publication_preparation_recorded",
    operationId: requested.effect.leaseId,
    preparation,
  });
  const intent = intentFor(
    prepared.state,
    requested.effect.leaseId,
    preparation,
  );
  const intentRecorded = reduceRunEvent(prepared.state, {
    kind: "publication_intent_recorded",
    operationId: requested.effect.leaseId,
    intent,
  });
  const publication = reduceRunEvent(intentRecorded.state, {
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
  });
  const effect = publication.effects[0]!;
  if (effect.kind !== "run_publication") {
    throw new Error("expected publication");
  }
  return { store: requested.store, state: publication.state, effect, intent };
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
