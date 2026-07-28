import { afterEach, describe, expect, it } from "vitest";
import { reduceRunEvent } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
} from "./scheduler-test-support.js";

afterEach(cleanupSchedulerStores);

describe("scheduler publication and whole-plan lifecycle", () => {
  it("records an approved repository-state satisfaction receipt without publishing", async () => {
    const state = (await store()).read();
    const candidateId = "satisfied:first-stream:base";
    const assessmentId = `assessment:${candidateId}:current-target`;
    state.workstreams.source["first-stream"] = {
      ...state.workstreams.source["first-stream"]!,
      baseSha: "base",
      candidateId,
      phase: "reviewing",
    };
    state.candidates[candidateId] = {
      id: candidateId,
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "base",
      treeSha: "base-tree",
    };
    state.reviews["source:first-stream"] = {
      candidateId,
      round: 0,
      outstandingIds: [],
      evidence: ["initial approval"],
      observations: [],
    };
    state.satisfaction.assessments[assessmentId] = {
      id: assessmentId,
      candidateId,
      workstream: { kind: "source", id: "first-stream" },
      historicalBaseSha: "base",
      targetSha: "current-target",
      interveningDiff: "diff --git a/x b/x",
      evidence: "Target advanced after the original review.",
      status: "pending",
    };
    state.processLeases.review = {
      id: "review",
      kind: "review",
      workstream: { kind: "source", id: "first-stream" },
      candidateId,
      attempt: 1,
      acquiredAt: "now",
    };

    const completed = reduceRunEvent(state, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "repository_state",
        candidateId,
        assessedTargetSha: "current-target",
        completion: { verdict: "approved" },
        evidence:
          "Repository state satisfies the original workstream contract.",
      },
    });

    expect(completed.accepted).toBe(true);
    expect(completed.state.workstreams.source["first-stream"]?.phase).toBe(
      "completed",
    );
    expect(completed.state.satisfaction.receipts).toMatchObject({
      [`satisfaction:${candidateId}:current-target`]: {
        assessedTargetSha: "current-target",
      },
    });
    expect(completed.state.publication.receipts).toEqual({});

    const rejected = reduceRunEvent(structuredClone(state), {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "repository_state",
        candidateId,
        assessedTargetSha: "current-target",
        completion: {
          verdict: "changes_requested",
          findings: [
            {
              summary: "Target change invalidates the claimed behavior.",
              evidence: "The intervening target diff removes the behavior.",
              requiredChange: "Restore the behavior on the current target.",
              acceptanceCriteria: ["The behavior works on the current target."],
            },
          ],
        },
        evidence: "Repository-state review rejected the stale claim.",
      },
    });
    expect(rejected.state.workstreams.source["first-stream"]?.phase).toBe(
      "recovering",
    );
    expect(
      rejected.state.reviews["source:first-stream"]?.outstandingIds,
    ).toEqual(["source-first-stream-repository-1-1"]);
  });

  it("routes replay preparation and reconciliation failures through owned lifecycle gates", async () => {
    const run = await store();
    const state = run.read();
    state.workstreams.source["first-stream"]!.phase = "approved";
    state.workstreams.source["first-stream"]!.baseSha = "base";
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const requested = reduceRunEvent(state, {
      kind: "reconciliation_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    await run.update(state.revision, () => requested.state);
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_reconciliation") {
      throw new Error("Expected reconciliation effect.");
    }
    const failed = reduceRunEvent(requested.state, {
      kind: "reconciliation_completed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      outcome: {
        kind: "reconciliation_required",
        evidence: "The replay conflicted with the target.",
        workspace: {
          id: "staging:first-stream",
          checkpoint: "commit",
          changedPaths: ["src/conflict.ts"],
          stateEvidence: "Conflict markers remain in owned staging.",
        },
      },
    });

    expect(failed.state.workstreams.source["first-stream"]?.phase).toBe(
      "recovering",
    );
    expect(failed.state.gates.at(-1)).toMatchObject({
      kind: "reconciliation",
      outcome: "failed",
    });
  });

  it("routes a failed whole-plan assessment through the recovery role before retrying", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.phase = "completed";
    state.workstreams.source["second-stream"]!.phase = "completed";
    state.phase = "whole_plan_review";
    state.wholePlanReview = { status: "reviewing" };

    const failed = reduceRunEvent(state, {
      kind: "whole_plan_review_failed",
      evidence: "Reviewer provider disconnected.",
    });
    const requested = reduceRunEvent(failed.state, {
      kind: "whole_plan_recovery_requested",
    });
    const interrupted = reduceRunEvent(requested.state, {
      kind: "whole_plan_recovery_abandoned",
    });
    const resumed = reduceRunEvent(interrupted.state, {
      kind: "whole_plan_recovery_requested",
    });
    const completed = reduceRunEvent(resumed.state, {
      kind: "whole_plan_recovery_completed",
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "The next reviewer invocation can safely retry.",
        evidence: "The target and corpus identities remain unchanged.",
        at: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(requested.effects).toEqual([{ kind: "run_whole_plan_recovery" }]);
    expect(resumed.effects).toEqual([{ kind: "run_whole_plan_recovery" }]);
    expect(completed.state.wholePlanReview).toMatchObject({
      status: "pending",
      recovery: {
        status: "completed",
        evidence: ["Reviewer provider disconnected."],
        actions: [
          {
            kind: "retry",
            evidence: "The target and corpus identities remain unchanged.",
          },
        ],
      },
    });
    expect(completed.state.phase).toBe("whole_plan_review");
  });

  it("records whole-plan findings as a runtime repair without changing immutable source coverage", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const reviewing = reduceRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const completed = reduceRunEvent(reviewing.state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "changes_requested",
        repairId: "overall-repair-1",
        candidate: {
          id: "overall-baseline",
          workstream: { kind: "overall", repairId: "overall-repair-1" },
          baseSha: "target",
          commitSha: "target",
          treeSha: "tree",
        },
        findings: [
          {
            summary: "The combined changes miss an integration boundary.",
            evidence: "The run diff demonstrates the missing handoff.",
            requiredChange: "Preserve the handoff across both workstreams.",
            acceptanceCriteria: ["The complete behavior crosses the boundary."],
          },
        ],
        evidence: "whole-plan-review.json",
        reviewedTargetSha: "target",
        reviewedTargetTreeSha: "tree",
      },
    });

    expect(completed.accepted).toBe(true);
    expect(completed.state.wholePlanReview).toMatchObject({
      status: "repairing",
      epoch: {
        originalFindingIds: ["overall-overall-repair-1-r1"],
        outstandingFindingIds: ["overall-overall-repair-1-r1"],
      },
    });
    expect(
      completed.state.workstreams.overall["overall-repair-1"],
    ).toMatchObject({
      phase: "queued",
      candidateId: "overall-baseline",
    });
    expect(
      completed.state.reviews["overall:overall-repair-1"]?.outstandingIds,
    ).toEqual(["overall-overall-repair-1-r1"]);
    expect(completed.state.workstreams.source["first-stream"]?.taskIds).toEqual(
      ["first"],
    );
  });

  it("queues a new canonical repair after an anchored post-publication assessment", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const reviewing = reduceRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const repair = reduceRunEvent(reviewing.state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "changes_requested",
        repairId: "overall-repair-1",
        candidate: {
          id: "overall-baseline",
          workstream: { kind: "overall", repairId: "overall-repair-1" },
          baseSha: "target",
          commitSha: "target",
          treeSha: "tree",
        },
        findings: [
          {
            summary: "The combined changes miss an integration boundary.",
            evidence: "The run diff demonstrates the missing handoff.",
            requiredChange: "Preserve the handoff across both workstreams.",
            acceptanceCriteria: ["The complete behavior crosses the boundary."],
          },
        ],
        evidence: "whole-plan-review.json",
        reviewedTargetSha: "target",
        reviewedTargetTreeSha: "tree",
      },
    });
    const state = repair.state;
    state.workstreams.overall["overall-repair-1"]!.phase = "completed";
    state.wholePlanReview = {
      status: "pending",
      epoch: {
        ...state.wholePlanReview.epoch!,
        latestRepair: {
          candidateId: "overall-baseline",
          targetBaseSha: "target",
          publishedCommitSha: "published",
          publishedTreeSha: "published-tree",
          changedPaths: ["src/integration.ts"],
        },
      },
    };
    const requested = reduceRunEvent(state, {
      kind: "whole_plan_review_requested",
    });

    const reassessed = reduceRunEvent(requested.state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "anchored",
        completion: {
          assessments: [
            {
              id: "overall-overall-repair-1-r1",
              status: "unresolved",
              evidence: "The published repair still misses the handoff.",
            },
          ],
          regressions: [],
        },
        evidence: "anchored-whole-plan-review.json",
        reviewedTargetSha: "published",
        reviewedTargetTreeSha: "published-tree",
      },
    });

    expect(requested.state.wholePlanReview.epoch).toEqual(
      state.wholePlanReview.epoch,
    );
    expect(reassessed.accepted).toBe(true);
    expect(
      reassessed.state.workstreams.overall["overall-repair-2"],
    ).toMatchObject({
      phase: "queued",
      candidateId: "overall-baseline:run-1:overall-repair-2:published",
    });
    expect(reassessed.state.wholePlanReview).toMatchObject({
      status: "repairing",
      epoch: {
        originalFindingIds: ["overall-overall-repair-1-r1"],
        outstandingFindingIds: ["overall-overall-repair-1-r1"],
      },
    });
  });

  it("closes an anchored whole-plan epoch only at its published target", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.phase = "completed";
    state.workstreams.source["second-stream"]!.phase = "completed";
    state.phase = "whole_plan_review";
    state.workstreams.overall["overall-repair-1"] = {
      kind: "overall",
      repairId: "overall-repair-1",
      phase: "completed",
      candidateId: "overall-baseline",
    };
    state.candidates["overall-baseline"] = {
      id: "overall-baseline",
      workstream: { kind: "overall", repairId: "overall-repair-1" },
      baseSha: "target",
      commitSha: "target",
      treeSha: "tree",
    };
    state.wholePlanReview = {
      status: "reviewing",
      epoch: {
        initialTargetSha: "target",
        initialTargetTreeSha: "tree",
        originalFindingIds: ["whole-plan-finding-1"],
        outstandingFindingIds: ["whole-plan-finding-1"],
        findings: [
          {
            id: "whole-plan-finding-1",
            summary: "Missing handoff",
            evidence: "The initial audit found it.",
            requiredChange: "Restore the handoff.",
            acceptanceCriteria: ["The handoff is present."],
          },
        ],
        latestRepair: {
          candidateId: "overall-baseline",
          targetBaseSha: "target",
          publishedCommitSha: "published",
          publishedTreeSha: "published-tree",
          changedPaths: ["src/integration.ts"],
        },
      },
    };

    const approved = reduceRunEvent(state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "anchored",
        completion: {
          assessments: [
            {
              id: "whole-plan-finding-1",
              status: "resolved",
              evidence: "The published repair restores the handoff.",
            },
          ],
          regressions: [],
        },
        evidence: "anchored-whole-plan-review.json",
        reviewedTargetSha: "published",
        reviewedTargetTreeSha: "published-tree",
      },
    });

    expect(approved.state.wholePlanReview).toMatchObject({
      status: "approved",
      reviewedTargetSha: "published",
      reviewedTargetTreeSha: "published-tree",
    });
  });

  it("rejects an overall repair that lacks the whole-plan review baseline and findings", async () => {
    const initial = (await store()).read();
    initial.workstreams.source["first-stream"]!.phase = "completed";
    initial.workstreams.source["second-stream"]!.phase = "completed";
    const review = reduceRunEvent(initial, {
      kind: "whole_plan_review_requested",
    });
    const repair = reduceRunEvent(review.state, {
      kind: "overall_repair_queued",
      repairId: "overall-repair-1",
    });

    expect(repair.accepted).toBe(false);
    expect(repair.state.workstreams.overall).toEqual({});
  });
});
