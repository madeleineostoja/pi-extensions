import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRevisionPacket } from "../revision.js";
import { reduceRunEvent } from "./scheduler.js";
import { validateRunState } from "../store.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore,
} from "./scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("revision policy", () => {
  it("binds review findings to one exact candidate and returns an observed revision to anchored review", async () => {
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
          "candidate:first",
          "first-sha",
          "first-tree",
          "integration-base",
        ),
        checkpoints: { first: "first-sha" },
        satisfied: {},
      },
    });
    const reviewRequested = reduceRunEvent(admitted.state, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:01:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected review");
    }
    const findings = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "initial",
        candidateId: "candidate:first",
        evidence: "review artifact",
        completion: {
          publicationCommitSubject: "fix: implement first task",
          findings: [
            {
              summary: "missing behavior",
              evidence: "the endpoint is incomplete",
              requiredChange: "complete the endpoint",
              acceptanceCriteria: ["endpoint responds"],
              disposition: "blocking",
            },
            {
              summary: "missing representative coverage",
              evidence: "the endpoint has no integration coverage",
              requiredChange: "add representative coverage",
              acceptanceCriteria: ["coverage exercises the endpoint"],
              disposition: "advisory",
            },
          ],
        },
      },
    });

    const assignment = Object.values(findings.state.revisionAssignments)[0]!;
    expect(findings.state.workstreams.source["first-stream"]?.phase).toBe(
      "revising",
    );
    expect(findings.state.failures).toEqual({});
    expect(assignment).toMatchObject({
      candidateId: "candidate:first",
      comparisonBase: "first-sha",
      findingEpoch: 0,
      pendingCorrectionIds: [
        "source-first-stream-r1",
        "source-first-stream-r2",
      ],
    });

    const revisionRequested = reduceRunEvent(findings.state, {
      kind: "revision_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:02:00.000Z",
    });
    const revision = revisionRequested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected revision");
    }
    const completed = reduceRunEvent(revisionRequested.state, {
      kind: "revision_completed",
      workstream: revision.workstream,
      leaseId: revision.leaseId,
      assignmentId: revision.assignmentId,
      outcome: {
        kind: "candidate_ready",
        candidate: candidate(
          "revision:first",
          "revision-sha",
          "revision-tree",
          "integration-base",
        ),
        correction: {
          fromCandidateId: "candidate:first",
          changedPaths: ["src/endpoint.ts"],
          evidence: "revision artifact",
        },
      },
    });

    expect(
      completed.state.workstreams.source["first-stream"]?.candidateId,
    ).toBe("revision:first");
    expect(completed.state.reviews["source:first-stream"]).toMatchObject({
      candidateId: "revision:first",
      previousCandidateId: "candidate:first",
      publicationCommitSubject: "fix: implement first task",
    });
    expect(
      completed.state.candidates["revision:first"]?.integrationBaseSha,
    ).toBe("integration-base");
    expect(
      reduceRunEvent(completed.state, {
        kind: "revision_completed",
        workstream: revision.workstream,
        leaseId: revision.leaseId,
        assignmentId: revision.assignmentId,
        outcome: {
          kind: "unchanged",
          evidence: "late result",
        },
      }).accepted,
    ).toBe(false);
  });

  it("gives an initial advisory one exact scheduler-owned correction assignment", async () => {
    const state = await stateAtRevision(1, false, [
      {
        summary: "Representative coverage",
        evidence: "The endpoint has no integration coverage.",
        requiredChange: "Add representative coverage.",
        acceptanceCriteria: ["Coverage exercises the endpoint."],
        disposition: "advisory",
      },
    ]);

    expect(state.workstreams.source["first-stream"]?.phase).toBe("revising");
    expect(state.reviews["source:first-stream"]?.pendingCorrectionIds).toEqual([
      "source-first-stream-r1",
    ]);
    expect(Object.values(state.revisionAssignments)[0]).toMatchObject({
      pendingCorrectionIds: ["source-first-stream-r1"],
    });
    expect(state.findings["source-first-stream-r1"]).toMatchObject({
      status: "open",
      disposition: "advisory",
    });
  });

  it("approves an advisory-only reassessment without waiving its finding", async () => {
    const state = await stateAtRevision();
    const revisionRequested = reduceRunEvent(state, {
      kind: "revision_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:02:00.000Z",
    });
    const revision = revisionRequested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected revision");
    }
    const admitted = reduceRunEvent(revisionRequested.state, {
      kind: "revision_completed",
      workstream: revision.workstream,
      leaseId: revision.leaseId,
      assignmentId: revision.assignmentId,
      outcome: {
        kind: "candidate_ready",
        candidate: candidate("revision:first", "revision-sha", "revision-tree"),
        correction: {
          fromCandidateId: "candidate:first",
          changedPaths: ["src/endpoint.ts"],
          evidence: "revision artifact",
        },
      },
    });
    const reviewRequested = reduceRunEvent(admitted.state, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:03:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected review");
    }
    const assessed = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "revision:first",
        previousCandidateId: "candidate:first",
        comparisonBase: "base-sha",
        changedPaths: ["src/endpoint.ts"],
        findingEpoch: 0,
        evidence: "assessment artifact",
        completion: {
          assessments: [
            {
              id: "source-first-stream-r1",
              status: "unresolved",
              evidence: "A representative scenario remains uncovered.",
              disposition: "advisory",
              summary: "Representative coverage",
              requiredChange: "Cover the remaining scenario.",
              acceptanceCriteria: ["The remaining scenario is covered."],
            },
          ],
          regressions: [],
        },
      },
    });

    expect(assessed.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(
      assessed.state.reviews["source:first-stream"]?.pendingCorrectionIds,
    ).toEqual([]);
    expect(assessed.state.findings["source-first-stream-r1"]).toMatchObject({
      status: "open",
      disposition: "advisory",
      summary: "Representative coverage",
    });
    expect(
      Object.values(assessed.state.revisionAssignments).some(
        (assignment) => assignment.status === "open",
      ),
    ).toBe(false);
  });

  it("creates the next assignment from only reassessed open blockers", async () => {
    const state = await stateAtRevision(1, false, [
      {
        summary: "Missing behavior",
        evidence: "The endpoint is incomplete.",
        requiredChange: "Complete the endpoint.",
        acceptanceCriteria: ["The endpoint responds."],
        disposition: "blocking",
      },
      {
        summary: "Coverage gap",
        evidence: "The endpoint has no integration coverage.",
        requiredChange: "Add representative coverage.",
        acceptanceCriteria: ["Coverage exercises the endpoint."],
        disposition: "advisory",
      },
    ]);
    const revisionRequested = reduceRunEvent(state, {
      kind: "revision_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:02:00.000Z",
    });
    const revision = revisionRequested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected revision");
    }
    const admitted = reduceRunEvent(revisionRequested.state, {
      kind: "revision_completed",
      workstream: revision.workstream,
      leaseId: revision.leaseId,
      assignmentId: revision.assignmentId,
      outcome: {
        kind: "candidate_ready",
        candidate: candidate("revision:first", "revision-sha", "revision-tree"),
        correction: {
          fromCandidateId: "candidate:first",
          changedPaths: ["src/endpoint.ts"],
          evidence: "revision artifact",
        },
      },
    });
    const reviewRequested = reduceRunEvent(admitted.state, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:03:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected review");
    }
    const reassessed = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "revision:first",
        previousCandidateId: "candidate:first",
        comparisonBase: "base-sha",
        changedPaths: ["src/endpoint.ts"],
        findingEpoch: 0,
        evidence: "assessment artifact",
        completion: {
          assessments: [
            {
              id: "source-first-stream-r1",
              status: "unresolved",
              evidence: "The endpoint remains incomplete.",
              disposition: "blocking",
              summary: "Missing behavior",
              requiredChange: "Complete the endpoint.",
              acceptanceCriteria: ["The endpoint responds."],
            },
            {
              id: "source-first-stream-r2",
              status: "resolved",
              evidence: "Representative coverage exercises the endpoint.",
            },
          ],
          regressions: [],
        },
      },
    });

    expect(
      reassessed.state.reviews["source:first-stream"]?.pendingCorrectionIds,
    ).toEqual(["source-first-stream-r1"]);
    expect(
      Object.values(reassessed.state.revisionAssignments).find(
        (assignment) => assignment.status === "open",
      ),
    ).toMatchObject({ pendingCorrectionIds: ["source-first-stream-r1"] });
    expect(reassessed.state.findings["source-first-stream-r2"]?.status).toBe(
      "resolved",
    );
  });

  it("rejects a source review that drops an open blocker from correction authority", async () => {
    const state = await stateAtRevision();
    state.reviews["source:first-stream"]!.pendingCorrectionIds = [];

    expect(invariantIssues(state)).toContain(
      "review source:first-stream lost open blocking finding source-first-stream-r1",
    );
  });

  it("rejects removed findings and invalid historical assignment snapshots", async () => {
    const state = await stateAtRevision();
    const finding = state.findings["source-first-stream-r1"]!;
    const withAdvisory = structuredClone(state);
    withAdvisory.findings["source-first-stream-advisory"] = {
      ...finding,
      id: "source-first-stream-advisory",
      disposition: "advisory",
    };
    expect(() => validate(withAdvisory, state)).not.toThrow();

    const withoutAdvisory = structuredClone(withAdvisory);
    delete withoutAdvisory.findings["source-first-stream-advisory"];
    expect(invariantIssues(withoutAdvisory, withAdvisory)).toContain(
      "finding source-first-stream-advisory was removed",
    );

    const invalidSnapshot = structuredClone(state);
    const assignment = Object.values(invalidSnapshot.revisionAssignments)[0]!;
    assignment.status = "completed";
    assignment.pendingCorrectionIds = ["unknown-finding"];
    expect(invariantIssues(invalidSnapshot)).toContain(
      "revision assignment revision:source:first-stream:first-sha:0:1 does not match its review epoch",
    );
  });

  it("requires overall reviews and epochs to retain the same open canonical IDs", async () => {
    const state = await stateAtRevision();
    const workstream = { kind: "overall" as const, repairId: "repair-1" };
    const candidateId = "overall-baseline:repair-1";
    const findingId = "overall-repair-1-r1";
    state.candidates[candidateId] = {
      id: candidateId,
      workstream,
      baseSha: "target-sha",
      commitSha: "target-sha",
      treeSha: "target-tree",
    };
    state.workstreams.overall[workstream.repairId] = {
      ...workstream,
      phase: "candidate_ready",
      candidateId,
    };
    state.findings[findingId] = {
      id: findingId,
      candidateId,
      workstream,
      scope: {
        kind: "whole_plan",
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
      },
      summary: "Missing whole-plan behavior",
      evidence: "The published target misses required behavior.",
      requiredChange: "Restore the required behavior.",
      acceptanceCriteria: ["The target satisfies the whole-plan contract."],
      origin: "initial",
      introducedRound: 0,
      disposition: "advisory",
      status: "open",
    };
    state.reviews["overall:repair-1"] = {
      candidateId,
      comparisonBase: "target-sha",
      round: 0,
      pendingCorrectionIds: [findingId],
      evidence: ["initial whole-plan review"],
      observations: [],
    };
    state.wholePlanReview = {
      status: "repairing",
      epoch: {
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
        findingIds: [findingId],
        pendingCorrectionIds: [findingId],
      },
    };

    expect(() => validate(state)).not.toThrow();

    const lostByReview = structuredClone(state);
    lostByReview.reviews["overall:repair-1"]!.pendingCorrectionIds = [];
    expect(invariantIssues(lostByReview)).toContain(
      "overall review overall:repair-1 does not retain every open epoch finding as pending",
    );

    const staleEpoch = structuredClone(state);
    staleEpoch.findings[findingId]!.status = "resolved";
    expect(invariantIssues(staleEpoch)).toContain(
      "whole-plan review epoch has an invalid pending finding",
    );
  });

  it("synchronizes canonical whole-plan findings and pending IDs after repair assessment", async () => {
    const state = (await createSchedulerStore()).read();
    const workstream = { kind: "overall" as const, repairId: "repair-1" };
    const baselineId = "overall-baseline:repair-1";
    const candidateId = "overall-repair:repair-1";
    const findingIds = ["overall-repair-1-r1", "overall-repair-1-r2"];
    const scope = {
      kind: "whole_plan" as const,
      initialTargetSha: "target-sha",
      initialTargetTreeSha: "target-tree",
    };
    state.phase = "whole_plan_review";
    state.candidates[baselineId] = {
      id: baselineId,
      workstream,
      baseSha: "target-sha",
      commitSha: "target-sha",
      treeSha: "target-tree",
    };
    state.candidates[candidateId] = {
      id: candidateId,
      workstream,
      baseSha: "target-sha",
      commitSha: "repair-sha",
      treeSha: "repair-tree",
    };
    state.workstreams.overall[workstream.repairId] = {
      ...workstream,
      phase: "candidate_ready",
      candidateId,
    };
    for (const [index, id] of findingIds.entries()) {
      state.findings[id] = {
        id,
        candidateId: baselineId,
        workstream,
        scope,
        summary: index === 0 ? "Missing behavior" : "Coverage gap",
        evidence: "The initial target does not satisfy this requirement.",
        requiredChange: "Correct the repair.",
        acceptanceCriteria: ["The requirement is satisfied."],
        origin: "initial",
        introducedRound: 0,
        disposition: index === 0 ? "blocking" : "advisory",
        status: "open",
      };
    }
    state.reviews["overall:repair-1"] = {
      candidateId,
      comparisonBase: "target-sha",
      previousCandidateId: baselineId,
      round: 0,
      pendingCorrectionIds: findingIds,
      latestCorrection: {
        fromCandidateId: baselineId,
        changedPaths: ["src/repair.ts"],
        evidence: "repair evidence",
      },
      evidence: ["initial whole-plan review"],
      observations: [],
    };
    state.wholePlanReview = {
      status: "repairing",
      epoch: {
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
        findingIds,
        pendingCorrectionIds: findingIds,
      },
    };

    const requested = reduceRunEvent(state, {
      kind: "review_requested",
      workstream,
      now: "2026-01-01T00:01:00.000Z",
    });
    const review = requested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected overall review");
    }
    const assessed = reduceRunEvent(requested.state, {
      kind: "review_completed",
      workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId,
        previousCandidateId: baselineId,
        comparisonBase: "target-sha",
        changedPaths: ["src/repair.ts"],
        findingEpoch: 0,
        evidence: "repair assessment",
        completion: {
          publicationCommitSubject: "fix: repair whole plan",
          assessments: [
            {
              id: findingIds[0]!,
              status: "resolved",
              evidence: "The repaired target now has the behavior.",
            },
            {
              id: findingIds[1]!,
              status: "unresolved",
              evidence: "Representative coverage remains absent.",
              disposition: "advisory",
              summary: "Coverage gap",
              requiredChange: "Add representative coverage.",
              acceptanceCriteria: ["Coverage exercises the repair."],
            },
          ],
          regressions: [],
        },
      },
    });

    expect(assessed.accepted).toBe(true);
    expect(assessed.state.findings[findingIds[0]!]?.status).toBe("resolved");
    expect(assessed.state.findings[findingIds[1]!]).toMatchObject({
      status: "open",
      disposition: "advisory",
    });
    expect(assessed.state.wholePlanReview.epoch?.pendingCorrectionIds).toEqual([
      findingIds[1],
    ]);
    expect(
      assessed.state.reviews["overall:repair-1"]?.pendingCorrectionIds,
    ).toEqual([findingIds[1]]);
    expect(Object.values(assessed.state.revisionAssignments)[0]).toMatchObject({
      pendingCorrectionIds: [findingIds[1]],
    });
    expect(() => validate(assessed.state)).not.toThrow();
  });

  it("retains resolved epoch IDs and queues an advisory causal regression under the Task-1 policy", async () => {
    const state = (await createSchedulerStore()).read();
    const workstream = { kind: "overall" as const, repairId: "repair-1" };
    const baselineId = "overall-baseline:repair-1";
    const publishedId = "overall-published:repair-1";
    const findingIds = ["overall-repair-1-r1", "overall-repair-1-r2"];
    const scope = {
      kind: "whole_plan" as const,
      initialTargetSha: "target-sha",
      initialTargetTreeSha: "target-tree",
    };
    state.candidates[baselineId] = {
      id: baselineId,
      workstream,
      baseSha: "target-sha",
      commitSha: "target-sha",
      treeSha: "target-tree",
    };
    state.candidates[publishedId] = {
      id: publishedId,
      workstream,
      baseSha: "target-sha",
      commitSha: "repair-sha",
      treeSha: "repair-tree",
    };
    state.workstreams.overall[workstream.repairId] = {
      ...workstream,
      phase: "completed",
      candidateId: publishedId,
    };
    for (const [index, id] of findingIds.entries()) {
      state.findings[id] = {
        id,
        candidateId: baselineId,
        workstream,
        scope,
        summary: `Resolved finding ${index + 1}`,
        evidence: "The repair verified this requirement.",
        requiredChange: "Keep the repaired behavior.",
        acceptanceCriteria: ["The requirement remains satisfied."],
        origin: "initial",
        introducedRound: 0,
        disposition: "blocking",
        status: "resolved",
      };
    }
    state.reviews["overall:repair-1"] = {
      candidateId: publishedId,
      comparisonBase: "target-sha",
      previousCandidateId: baselineId,
      round: 1,
      pendingCorrectionIds: [],
      latestCorrection: {
        fromCandidateId: baselineId,
        changedPaths: ["src/repair.ts"],
        evidence: "repair evidence",
      },
      evidence: ["repair review"],
      observations: [],
      publicationCommitSubject: "fix: repair whole plan",
    };
    state.phase = "whole_plan_review";
    state.wholePlanReview = {
      status: "reviewing",
      epoch: {
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
        findingIds,
        pendingCorrectionIds: [],
        latestRepair: {
          candidateId: publishedId,
          targetBaseSha: "target-sha",
          publishedCommitSha: "published-sha",
          publishedTreeSha: "published-tree",
          changedPaths: ["src/repair.ts"],
        },
      },
    };

    const queued = reduceRunEvent(state, {
      kind: "whole_plan_review_completed",
      outcome: {
        kind: "anchored",
        reviewedTargetSha: "published-sha",
        reviewedTargetTreeSha: "published-tree",
        evidence: "final whole-plan review",
        completion: {
          assessments: [],
          regressions: [
            {
              summary: "Repair regression",
              evidence: "The repair omits an edge case.",
              requiredChange: "Handle the edge case.",
              acceptanceCriteria: ["The edge case is handled."],
              disposition: "advisory",
              changedPaths: ["src/repair.ts"],
            },
          ],
        },
      },
    });

    expect(queued.accepted).toBe(true);
    expect(queued.state.findings[findingIds[0]!]?.status).toBe("resolved");
    expect(queued.state.findings["overall-repair-1-r3"]).toMatchObject({
      status: "open",
      disposition: "advisory",
    });
    expect(queued.state.wholePlanReview).toMatchObject({
      status: "repairing",
      epoch: {
        findingIds: [...findingIds, "overall-repair-1-r3"],
        pendingCorrectionIds: ["overall-repair-1-r3"],
      },
    });
    expect(
      queued.state.reviews["overall:overall-repair-1"]?.pendingCorrectionIds,
    ).toEqual(["overall-repair-1-r3"]);
    const nextRepairId = "overall-repair-1";
    const nextWorkstream = {
      kind: "overall" as const,
      repairId: nextRepairId,
    };
    const nextBaselineId =
      queued.state.workstreams.overall[nextRepairId]!.candidateId!;
    const candidateId = "overall-repair:overall-repair-1";
    const next = structuredClone(queued.state);
    next.candidates[candidateId] = {
      id: candidateId,
      workstream: nextWorkstream,
      baseSha: "published-sha",
      commitSha: "second-repair-sha",
      treeSha: "second-repair-tree",
      changedPaths: ["src/repair.ts"],
    };
    next.workstreams.overall[nextRepairId] = {
      ...next.workstreams.overall[nextRepairId]!,
      candidateId,
      phase: "candidate_ready",
    };
    next.reviews[`overall:${nextRepairId}`] = {
      ...next.reviews[`overall:${nextRepairId}`]!,
      candidateId,
      comparisonBase: "published-sha",
      previousCandidateId: nextBaselineId,
      latestCorrection: {
        fromCandidateId: nextBaselineId,
        changedPaths: ["src/repair.ts"],
        evidence: "second repair candidate",
      },
    };
    const requested = reduceRunEvent(next, {
      kind: "review_requested",
      workstream: nextWorkstream,
      now: "2026-01-01T00:02:00.000Z",
    });
    const review = requested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected later overall review");
    }
    const assessed = reduceRunEvent(requested.state, {
      kind: "review_completed",
      workstream: nextWorkstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId,
        previousCandidateId: nextBaselineId,
        comparisonBase: "published-sha",
        changedPaths: ["src/repair.ts"],
        findingEpoch: 0,
        evidence: "second repair assessment",
        completion: {
          publicationCommitSubject: "fix: correct repair regression",
          assessments: [
            {
              id: "overall-repair-1-r3",
              status: "unresolved",
              evidence: "The edge case remains unhandled.",
              disposition: "advisory",
              summary: "Repair regression",
              requiredChange: "Handle the edge case.",
              acceptanceCriteria: ["The edge case is handled."],
            },
          ],
          regressions: [],
        },
      },
    });
    const assignment = Object.values(assessed.state.revisionAssignments).find(
      (entry) => entry.workstream.kind === "overall" && entry.status === "open",
    )!;
    const revisionRequested = reduceRunEvent(assessed.state, {
      kind: "revision_requested",
      workstream: nextWorkstream,
      now: "2026-01-01T00:03:00.000Z",
    });
    const revision = revisionRequested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected later overall revision");
    }

    const packet = buildRevisionPacket({
      state: revisionRequested.state,
      effect: revision,
    });

    expect(assignment.pendingCorrectionIds).toEqual(["overall-repair-1-r3"]);
    expect(packet.findings).toEqual([
      expect.objectContaining({
        id: "overall-repair-1-r3",
        workstream: { kind: "overall", repairId: "repair-1" },
        scope,
      }),
    ]);

    const duplicate = structuredClone(revisionRequested.state);
    duplicate.revisionAssignments[
      revision.assignmentId
    ]!.pendingCorrectionIds.push("overall-repair-1-r3");
    duplicate.reviews[`overall:${nextRepairId}`]!.pendingCorrectionIds.push(
      "overall-repair-1-r3",
    );
    expect(() =>
      buildRevisionPacket({ state: duplicate, effect: revision }),
    ).toThrow("no longer current");

    const resolved = structuredClone(revisionRequested.state);
    resolved.findings["overall-repair-1-r3"]!.status = "resolved";
    expect(() =>
      buildRevisionPacket({ state: resolved, effect: revision }),
    ).toThrow("invalid finding overall-repair-1-r3");

    const wrongEpoch = structuredClone(revisionRequested.state);
    wrongEpoch.wholePlanReview.epoch!.findingIds = [];
    expect(() =>
      buildRevisionPacket({ state: wrongEpoch, effect: revision }),
    ).toThrow("invalid finding overall-repair-1-r3");
  });

  it("settles the first unchanged revision as no progress without a duplicate revision", async () => {
    const state = await stateAtRevision();
    const settled = requestAndLeaveUnchanged(state, "first wording");
    const assignment = Object.values(settled.revisionAssignments)[0]!;

    expect(settled.phase).toBe("running");
    expect(settled.workstreams.source).toMatchObject({
      "first-stream": {
        phase: "failed",
        candidateId: "candidate:first",
      },
      "second-stream": { phase: "dependency_skipped" },
    });
    expect(assignment).toMatchObject({
      status: "blocked",
      noProgress: { attempts: 1 },
    });
    expect(settled.reviews["source:first-stream"]).toMatchObject({
      candidateId: "candidate:first",
      pendingCorrectionIds: ["source-first-stream-r1"],
    });
    expect(settled.candidates["candidate:first"]).toBeDefined();
    expect(Object.values(settled.failures)).toContainEqual(
      expect.objectContaining({
        category: "no_progress",
        assignment: "blocked",
        evidence: "first wording",
      }),
    );
    expect(
      reduceRunEvent(settled, {
        kind: "revision_requested",
        workstream: { kind: "source", id: "first-stream" },
        now: "2026-01-01T00:03:00.000Z",
      }),
    ).toMatchObject({ accepted: false, effects: [] });
    expect(reduceRunEvent(settled, { kind: "run_incomplete" })).toMatchObject({
      accepted: true,
      state: { phase: "incomplete" },
    });
  });

  it("leaves independent workstreams active after an unchanged revision settles", async () => {
    const state = await stateAtRevision(2, true);
    const settled = requestAndLeaveUnchanged(state, "no semantic change");

    expect(settled.workstreams.source["first-stream"]?.phase).toBe("failed");
    expect(settled.workstreams.source["second-stream"]?.phase).toBe(
      "implementing",
    );
    expect(Object.values(settled.processLeases)).toContainEqual(
      expect.objectContaining({
        workstream: { kind: "source", id: "second-stream" },
        kind: "implementation",
      }),
    );
    expect(reduceRunEvent(settled, { kind: "run_incomplete" }).accepted).toBe(
      false,
    );
  });

  it("keeps protocol retries separate from semantic no progress", async () => {
    let state = await stateAtRevision();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const requested = reduceRunEvent(state, {
        kind: "revision_requested",
        workstream: { kind: "source", id: "first-stream" },
        now: `2026-01-01T00:0${attempt}:00.000Z`,
      });
      const revision = requested.effects[0]!;
      if (revision.kind !== "run_revision") {
        throw new Error("expected revision");
      }
      state = reduceRunEvent(requested.state, {
        kind: "revision_failed",
        workstream: revision.workstream,
        leaseId: revision.leaseId,
        assignmentId: revision.assignmentId,
        category: "protocol_failure",
        evidence: `malformed response ${attempt}`,
      }).state;
    }
    expect(state.phase).toBe("running");
    expect(state.workstreams.source["first-stream"]?.phase).toBe("failed");
    expect(Object.values(state.failures)).toContainEqual(
      expect.objectContaining({ category: "protocol_failure" }),
    );
    expect(
      Object.values(state.revisionAssignments)[0]?.noProgress.attempts,
    ).toBe(0);
  });

  it("uses an exact scheduler-owned workspace recreation operation", async () => {
    const state = await stateAtRevision();
    const requested = reduceRunEvent(state, {
      kind: "revision_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:02:00.000Z",
    });
    const revision = requested.effects[0]!;
    if (revision.kind !== "run_revision") {
      throw new Error("expected revision");
    }
    const quarantined = reduceRunEvent(requested.state, {
      kind: "revision_failed",
      workstream: revision.workstream,
      leaseId: revision.leaseId,
      assignmentId: revision.assignmentId,
      category: "workspace_unsafe",
      evidence: "worker left an uncommitted file",
      observation: observation(false),
    });
    const recreation = Object.values(
      quarantined.state.workspaceRecreations,
    )[0]!;
    expect(recreation).toMatchObject({
      candidateId: "candidate:first",
      checkpoint: "first-sha",
      resumePhase: "revising",
      status: "pending",
    });
    const started = reduceRunEvent(quarantined.state, {
      kind: "workspace_recreation_requested",
      id: recreation.id,
      now: "2026-01-01T00:03:00.000Z",
    });
    const effect = started.effects[0]!;
    if (effect.kind !== "recreate_workspace") {
      throw new Error("expected workspace recreation");
    }
    const restored = reduceRunEvent(started.state, {
      kind: "workspace_recreation_completed",
      id: recreation.id,
      leaseId: effect.leaseId,
      before: observation(false),
      after: observation(true),
      outcome: "restored",
    });
    expect(restored.state.workstreams.source["first-stream"]?.phase).toBe(
      "revising",
    );
    expect(restored.state.workspaceRecreations[recreation.id]).toMatchObject({
      status: "restored",
      before: observation(false),
      after: observation(true),
    });
  });
});

async function stateAtRevision(
  concurrency = 1,
  independent = false,
  findings: Array<{
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
    disposition: "blocking" | "advisory";
  }> = [
    {
      summary: "missing behavior",
      evidence: "the endpoint is incomplete",
      requiredChange: "complete the endpoint",
      acceptanceCriteria: ["endpoint responds"],
      disposition: "blocking",
    },
  ],
) {
  const store = await createSchedulerStore(concurrency, independent);
  const started = reduceRunEvent(store.read(), {
    kind: "workstreams_selected",
    now: "2026-01-01T00:00:00.000Z",
    baseShas: {
      "first-stream": "base-sha",
      ...(independent ? { "second-stream": "base-sha" } : {}),
    },
  });
  const implementation = started.effects[0]!;
  if (implementation.kind !== "run_implementation") {
    throw new Error("implementation");
  }
  const admitted = reduceRunEvent(started.state, {
    kind: "implementation_completed",
    workstream: implementation.workstream,
    leaseId: implementation.leaseId,
    outcome: {
      kind: "candidate_ready",
      candidate: candidate("candidate:first", "first-sha", "first-tree"),
      checkpoints: { first: "first-sha" },
      satisfied: {},
    },
  });
  const requested = reduceRunEvent(admitted.state, {
    kind: "review_requested",
    workstream: { kind: "source", id: "first-stream" },
    now: "2026-01-01T00:01:00.000Z",
  });
  const review = requested.effects[0]!;
  if (review.kind !== "run_review") {
    throw new Error("review");
  }
  return reduceRunEvent(requested.state, {
    kind: "review_completed",
    workstream: review.workstream,
    leaseId: review.leaseId,
    outcome: {
      kind: "initial",
      candidateId: "candidate:first",
      evidence: "review artifact",
      completion: {
        publicationCommitSubject: "fix: implement first task",
        findings,
      },
    },
  }).state;
}

function validate(
  state: Parameters<typeof validateRunState>[0],
  previous?: Parameters<typeof validateRunState>[2],
) {
  const run = state as Awaited<ReturnType<typeof stateAtRevision>>;
  return validateRunState(
    state,
    join(dirname(run.executionPlan!.path), "run-state.json"),
    previous,
  );
}

function invariantIssues(
  state: Parameters<typeof validateRunState>[0],
  previous?: Parameters<typeof validateRunState>[2],
): string[] {
  try {
    validate(state, previous);
    return [];
  } catch (error) {
    return (error as { issues: string[] }).issues;
  }
}

function requestAndLeaveUnchanged(
  state: Awaited<ReturnType<typeof stateAtRevision>>,
  evidence: string,
) {
  const requested = reduceRunEvent(state, {
    kind: "revision_requested",
    workstream: { kind: "source", id: "first-stream" },
    now: "2026-01-01T00:02:00.000Z",
  });
  const revision = requested.effects[0]!;
  if (revision.kind !== "run_revision") {
    throw new Error("revision");
  }
  return reduceRunEvent(requested.state, {
    kind: "revision_completed",
    workstream: revision.workstream,
    leaseId: revision.leaseId,
    assignmentId: revision.assignmentId,
    outcome: { kind: "unchanged", evidence },
  }).state;
}

function observation(clean: boolean) {
  return {
    branch: "pipkin/implement/run-1/first-stream",
    head: "first-sha",
    tree: "first-tree",
    clean,
    status: clean ? [] : [{ status: " M", path: "src/endpoint.ts" }],
  };
}

function candidate(
  id: string,
  commitSha: string,
  treeSha: string,
  integrationBaseSha?: string,
) {
  return {
    id,
    workstream: { kind: "source" as const, id: "first-stream" },
    baseSha: "base-sha",
    ...(integrationBaseSha ? { integrationBaseSha } : {}),
    commitSha,
    treeSha,
    evidenceStatus: "reported" as const,
    changedPaths: ["src/endpoint.ts"],
    implementationEvidence: {
      summary: "implemented",
      verification: ["tests pass"],
    },
  };
}
