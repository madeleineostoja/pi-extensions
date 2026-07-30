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
          changedPaths: ["src/endpoint.ts"],
        },
        correction: {
          fromCandidateId: "candidate:first",
          changedPaths: ["src/endpoint.ts"],
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
    });
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

async function failedReplay() {
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
      candidate: candidate("candidate-sha", "candidate-tree"),
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
        verdict: "approved",
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
          operationId: effect.leaseId,
          branchName: "pipkin/implement/run-1/staging-failed",
          targetRef: "refs/heads/main",
        },
        evidence: "same-file semantic overlap",
      },
      workspace: {
        id: "staging-failed",
        changedPaths: ["src/endpoint.ts"],
        targetSha: "failed-target-sha",
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
