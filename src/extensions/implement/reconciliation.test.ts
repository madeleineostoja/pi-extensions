import { afterEach, describe, expect, it } from "vitest";
import { buildReconciliationPacket } from "./reconciliation.js";
import { buildReconciliationPrompt } from "./prompts.js";
import { reduceRunEvent } from "./scheduler/scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler/scheduler-test-support.js";
import type { RunState } from "./store.js";

afterEach(() => cleanupSchedulerStores());

describe("semantic reconciliation assignments", () => {
  it("escalates one unchanged semantic context without replaying it and then exhausts", async () => {
    const replay = await failedReplay();
    const initial = reduceRunEvent(replay.state, {
      kind: "reconciliation_assignment_requested",
      workstream: replay.workstream,
      now: "2026-01-01T00:03:00.000Z",
    });
    const initialEffect = initial.effects[0]!;
    if (initialEffect.kind !== "run_reconciliation_worker") {
      throw new Error("expected initial reconciliation worker");
    }

    const firstFailure = reduceRunEvent(initial.state, {
      kind: "reconciliation_worker_failed",
      workstream: initialEffect.workstream,
      leaseId: initialEffect.leaseId,
      assignmentId: initialEffect.assignmentId,
      category: "semantic_blocked",
      evidence: "The merge still preserves neither behavior.",
    });
    expect(firstFailure.accepted).toBe(true);
    const assignments = Object.values(
      firstFailure.state.reconciliationAssignments,
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({
      semanticAttempt: "initial",
      status: "blocked",
    });
    expect(assignments[1]).toMatchObject({
      semanticAttempt: "escalated",
      status: "pending",
      context: { key: assignments[0]!.context.key },
      priorAttemptEvidence: expect.arrayContaining([
        "same-file semantic overlap",
        "The merge still preserves neither behavior.",
      ]),
    });

    expect(
      reduceRunEvent(firstFailure.state, {
        kind: "reconciliation_worker_failed",
        workstream: initialEffect.workstream,
        leaseId: initialEffect.leaseId,
        assignmentId: initialEffect.assignmentId,
        category: "semantic_blocked",
        evidence: "The wording changed but the candidate did not.",
      }).accepted,
    ).toBe(false);

    const escalated = reduceRunEvent(firstFailure.state, {
      kind: "reconciliation_assignment_requested",
      workstream: replay.workstream,
      now: "2026-01-01T00:04:00.000Z",
    });
    const escalatedEffect = escalated.effects[0]!;
    if (escalatedEffect.kind !== "run_reconciliation_worker") {
      throw new Error("expected escalated reconciliation worker");
    }
    const packet = buildReconciliationPacket({
      state: escalated.state,
      effect: escalatedEffect,
    });
    expect(packet.semanticAttempt).toBe("escalated");
    expect(packet.priorEvidence).toContain(
      "The merge still preserves neither behavior.",
    );

    const exhausted = reduceRunEvent(escalated.state, {
      kind: "reconciliation_worker_failed",
      workstream: escalatedEffect.workstream,
      leaseId: escalatedEffect.leaseId,
      assignmentId: escalatedEffect.assignmentId,
      category: "semantic_blocked",
      evidence: "Still unchanged despite the escalation.",
    });
    expect(exhausted.accepted).toBe(true);
    expect(exhausted.state).toMatchObject({
      phase: "running",
      workstreams: { source: { "first-stream": { phase: "failed" } } },
    });
    expect(Object.values(exhausted.state.failures)).toContainEqual(
      expect.objectContaining({ category: "semantic_blocked" }),
    );
    expect(
      Object.values(exhausted.state.reconciliationAssignments).map(
        (assignment) => assignment.status,
      ),
    ).toEqual(["blocked", "blocked"]);
  });

  it("settles an invalid local review epoch without operational retries", async () => {
    const replay = await failedReplay();
    const state = {
      ...replay.state,
      workstreams: {
        ...replay.state.workstreams,
        source: {
          ...replay.state.workstreams.source,
          "first-stream": {
            ...replay.state.workstreams.source["first-stream"]!,
            phase: "candidate_ready" as const,
          },
        },
      },
      reconciliationAssignments: {},
    };
    const requested = reduceRunEvent(state, {
      kind: "review_requested",
      workstream: replay.workstream,
      now: "2026-01-01T00:03:00.000Z",
    });
    const review = requested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected review");
    }
    const failed = reduceRunEvent(requested.state, {
      kind: "effect_failed",
      effect: "review",
      workstream: review.workstream,
      leaseId: review.leaseId,
      category: "protocol_failure",
      nonRetryable: true,
      evidence: "Reviewer packet does not match its anchored review epoch.",
    });

    expect(failed.accepted).toBe(true);
    expect(failed.state.workstreams.source["first-stream"]?.phase).toBe(
      "failed",
    );
    expect(failed.state.operationalRetries).toEqual({});
    expect(Object.values(failed.state.failures)).toContainEqual(
      expect.objectContaining({ assignment: "blocked" }),
    );
  });

  it("changes semantic context only for observed candidate tree or failed target changes", async () => {
    const original = await failedReplay();
    const changedTree = await failedReplay({ candidateTreeSha: "other-tree" });
    const changedTarget = await failedReplay({ targetSha: "later-target-sha" });
    const context = Object.values(original.state.reconciliationAssignments)[0]!
      .context;

    expect(
      Object.values(changedTree.state.reconciliationAssignments)[0]!.context
        .key,
    ).not.toBe(context.key);
    expect(
      Object.values(changedTarget.state.reconciliationAssignments)[0]!.context
        .key,
    ).not.toBe(context.key);
  });

  it("retains execution failures across an eventual semantic escalation", async () => {
    const replay = await failedReplay();
    const requested = reduceRunEvent(replay.state, {
      kind: "reconciliation_assignment_requested",
      workstream: replay.workstream,
      now: "2026-01-01T00:03:00.000Z",
    });
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_reconciliation_worker") {
      throw new Error("expected reconciliation worker");
    }
    const executionFailure = reduceRunEvent(requested.state, {
      kind: "reconciliation_worker_failed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      assignmentId: effect.assignmentId,
      category: "provider_failure",
      evidence: "provider timed out",
    });
    const retried = reduceRunEvent(executionFailure.state, {
      kind: "reconciliation_assignment_requested",
      workstream: replay.workstream,
      now: "2026-01-01T00:04:00.000Z",
    });
    const retriedEffect = retried.effects[0]!;
    if (retriedEffect.kind !== "run_reconciliation_worker") {
      throw new Error("expected reconciliation retry");
    }
    const semanticFailure = reduceRunEvent(retried.state, {
      kind: "reconciliation_worker_failed",
      workstream: retriedEffect.workstream,
      leaseId: retriedEffect.leaseId,
      assignmentId: retriedEffect.assignmentId,
      category: "semantic_blocked",
      evidence: "unchanged merge",
    });

    expect(
      Object.values(semanticFailure.state.reconciliationAssignments)[1],
    ).toMatchObject({ semanticAttempt: "escalated", executionFailures: 1 });
  });

  it("retains the failed replay inputs and admits only the assigned target-relative candidate", async () => {
    const replay = await failedReplay();
    const assignmentRequested = reduceRunEvent(replay.state, {
      kind: "reconciliation_assignment_requested",
      workstream: replay.workstream,
      now: "2026-01-01T00:03:00.000Z",
    });
    const effect = assignmentRequested.effects[0]!;
    if (effect.kind !== "run_reconciliation_worker") {
      throw new Error("expected reconciliation worker");
    }

    const packet = buildReconciliationPacket({
      state: assignmentRequested.state,
      effect,
    });
    expect(packet).toMatchObject({
      completionKind: "reconciliation",
      candidate: { commitSha: "candidate-sha", treeSha: "candidate-tree" },
      failedTarget: {
        commitSha: "failed-target-sha",
        treeSha: "failed-target-tree",
      },
      replay: {
        disposition: "overlap",
        relevantPaths: ["src/endpoint.ts"],
      },
    });
    const prompt = buildReconciliationPrompt(packet);
    expect(prompt).toContain(
      "merge failed-target-sha into the current candidate branch",
    );
    expect(prompt).toContain("target-relative result");
    expect(prompt).not.toContain("diff --git");

    const completed = reduceRunEvent(assignmentRequested.state, {
      kind: "reconciliation_worker_completed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      assignmentId: effect.assignmentId,
      outcome: {
        candidate: {
          ...candidate("reconciled-sha", "reconciled-tree"),
          id: "reconciliation:first-stream:reconciled-sha",
          integrationBaseSha: "failed-target-sha",
          changedPaths: ["src/integrated.ts"],
        },
        correction: {
          fromCandidateId: "candidate:first",
          changedPaths: ["src/integrated.ts"],
          evidence: "reconciliation observation",
        },
      },
    });

    expect(completed.accepted).toBe(true);
    expect(completed.state.workstreams.source["first-stream"]).toMatchObject({
      phase: "candidate_ready",
      candidateId: "reconciliation:first-stream:reconciled-sha",
    });
    expect(completed.state.reviews["source:first-stream"]).toMatchObject({
      previousCandidateId: "candidate:first",
      candidateId: "reconciliation:first-stream:reconciled-sha",
      comparisonBase: "failed-target-sha",
      candidateCommitSha: "reconciled-sha",
      candidateTreeSha: "reconciled-tree",
      latestCorrection: {
        rangeBaseSha: "failed-target-sha",
        rangeHeadSha: "reconciled-sha",
        changedPaths: ["src/integrated.ts"],
      },
    });

    const reviewRequested = reduceRunEvent(completed.state, {
      kind: "review_requested",
      workstream: effect.workstream,
      now: "2026-01-01T00:04:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected reconciled review");
    }
    const reviewed = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "reconciliation:first-stream:reconciled-sha",
        previousCandidateId: "candidate:first",
        comparisonBase: "failed-target-sha",
        correctionRangeBaseSha: "failed-target-sha",
        correctionRangeHeadSha: "reconciled-sha",
        changedPaths: ["src/integrated.ts"],
        findingEpoch: 0,
        evidence: "reconciled review",
        completion: { assessments: [], regressions: [] },
      },
    });
    expect(reviewed.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(
      reduceRunEvent(reviewed.state, {
        kind: "reconciliation_requested",
        workstream: effect.workstream,
        now: "2026-01-01T00:05:00.000Z",
      }).effects,
    ).toContainEqual(expect.objectContaining({ kind: "run_reconciliation" }));
    expect(
      Object.values(completed.state.reconciliationAssignments)[0],
    ).toMatchObject({ status: "completed", targetSha: "failed-target-sha" });

    expect(
      reduceRunEvent(assignmentRequested.state, {
        kind: "reconciliation_worker_completed",
        workstream: effect.workstream,
        leaseId: effect.leaseId,
        assignmentId: effect.assignmentId,
        outcome: {
          candidate: {
            ...candidate("wrong-target", "wrong-tree"),
            integrationBaseSha: "later-target-sha",
            changedPaths: ["src/endpoint.ts"],
          },
          correction: {
            fromCandidateId: "candidate:first",
            changedPaths: ["src/endpoint.ts"],
            evidence: "wrong target",
          },
        },
      }).accepted,
    ).toBe(false);
  });
});

async function failedReplay(
  args: {
    candidateTreeSha?: string;
    targetSha?: string;
  } = {},
) {
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
      candidate: candidate(
        "candidate-sha",
        args.candidateTreeSha ?? "candidate-tree",
      ),
      checkpoints: { first: "candidate-sha" },
      satisfied: {},
    },
  });
  const reviewed = reduceRunEvent(admitted.state, {
    kind: "review_requested",
    workstream: implementation.workstream,
    now: "2026-01-01T00:01:00.000Z",
  });
  const review = reviewed.effects[0]!;
  if (review.kind !== "run_review") {
    throw new Error("expected review");
  }
  const approved = reduceRunEvent(reviewed.state, {
    kind: "review_completed",
    workstream: review.workstream,
    leaseId: review.leaseId,
    outcome: {
      kind: "initial",
      candidateId: "candidate:first",
      evidence: "initial review",
      completion: {
        findings: [],
        publicationCommitSubject: "feat: publish candidate",
      },
    },
  });
  const reconciliation = reduceRunEvent(approved.state, {
    kind: "reconciliation_requested",
    workstream: implementation.workstream,
    now: "2026-01-01T00:02:00.000Z",
  });
  const effect = reconciliation.effects[0]!;
  if (effect.kind !== "run_reconciliation") {
    throw new Error("expected replay");
  }
  const settled = reduceRunEvent(reconciliation.state, {
    kind: "reconciliation_completed",
    workstream: effect.workstream,
    leaseId: effect.leaseId,
    outcome: {
      kind: "reconciliation_required",
      evidence: "same-file semantic overlap",
      failedReplay: {
        candidateCommitSha: "candidate-sha",
        candidateTreeSha: args.candidateTreeSha ?? "candidate-tree",
        targetSha: args.targetSha ?? "failed-target-sha",
        targetTreeSha:
          args.targetSha === undefined
            ? "failed-target-tree"
            : `${args.targetSha}-tree`,
        disposition: "overlap",
        paths: {
          candidate: ["src/endpoint.ts"],
          target: ["src/endpoint.ts"],
          replay: ["src/endpoint.ts"],
        },
        staging: {
          id: "staging-failed",
          operationId: effect.leaseId,
          branchName: "pipkin/implement/run-1/staging-failed",
          targetRef: "refs/heads/main",
        },
        evidence: "same-file semantic overlap",
      },
      workspace: {
        id: "staging-failed",
        changedPaths: ["src/endpoint.ts"],
        targetSha: args.targetSha ?? "failed-target-sha",
        stateEvidence: "same-file semantic overlap",
      },
    },
  });
  if (!settled.accepted) {
    throw new Error(settled.error);
  }
  return { state: settled.state, workstream: effect.workstream };
}

function candidate(
  commitSha: string,
  treeSha: string,
): RunState["candidates"][string] {
  return {
    id: "candidate:first",
    workstream: { kind: "source", id: "first-stream" },
    baseSha: "base-sha",
    commitSha,
    treeSha,
    changedPaths: ["src/endpoint.ts"],
    implementationEvidence: {
      summary: "implemented",
      verification: ["tests pass"],
    },
  };
}
