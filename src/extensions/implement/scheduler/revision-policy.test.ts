import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
            },
            {
              summary: "missing representative coverage",
              evidence: "the endpoint has no integration coverage",
              requiredChange: "add representative coverage",
              acceptanceCriteria: ["coverage exercises the endpoint"],
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

  it("gives every initial finding one exact scheduler-owned correction assignment", async () => {
    const state = await stateAtRevision(1, false, [
      {
        summary: "Representative coverage",
        evidence: "The endpoint has no integration coverage.",
        requiredChange: "Add representative coverage.",
        acceptanceCriteria: ["Coverage exercises the endpoint."],
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
    });
  });

  it("binds repository-state findings to their assessment and gives one correction", async () => {
    const store = await createSchedulerStore();
    const sourceWorkstream = { kind: "source" as const, id: "first-stream" };
    const selected = reduceRunEvent(store.read(), {
      kind: "workstreams_selected",
      now: "2026-01-01T00:00:00.000Z",
      baseShas: { "first-stream": "base-sha" },
    });
    const implementation = selected.effects[0]!;
    if (implementation.kind !== "run_implementation") {
      throw new Error("expected implementation");
    }
    expect(implementation.workstream).toEqual(sourceWorkstream);
    const satisfiedCandidate = {
      id: "satisfied:first",
      workstream: sourceWorkstream,
      baseSha: "base-sha",
      commitSha: "base-sha",
      treeSha: "base-tree",
    };
    const claimed = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: sourceWorkstream,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "satisfaction_claimed",
        candidate: satisfiedCandidate,
        evidence: { first: "The existing target satisfies the task." },
      },
    });
    const initialRequested = reduceRunEvent(claimed.state, {
      kind: "review_requested",
      workstream: sourceWorkstream,
      now: "2026-01-01T00:01:00.000Z",
    });
    const initialReview = initialRequested.effects[0]!;
    if (initialReview.kind !== "run_review") {
      throw new Error("expected initial review");
    }
    const initiallyApproved = reduceRunEvent(initialRequested.state, {
      kind: "review_completed",
      workstream: initialReview.workstream,
      leaseId: initialReview.leaseId,
      outcome: {
        kind: "initial",
        candidateId: satisfiedCandidate.id,
        evidence: "initial repository-state review",
        completion: { findings: [] },
      },
    });
    const reconciliationRequested = reduceRunEvent(initiallyApproved.state, {
      kind: "reconciliation_requested",
      workstream: sourceWorkstream,
      now: "2026-01-01T00:02:00.000Z",
    });
    const reconciliation = reconciliationRequested.effects[0]!;
    if (reconciliation.kind !== "run_reconciliation") {
      throw new Error("expected reconciliation");
    }
    const assessmentReady = reduceRunEvent(reconciliationRequested.state, {
      kind: "repository_assessment_required",
      workstream: sourceWorkstream,
      leaseId: reconciliation.leaseId,
      targetSha: "target-sha",
      evidence: "the target needs a fresh assessment",
    });
    const reviewRequested = reduceRunEvent(assessmentReady.state, {
      kind: "review_requested",
      workstream: sourceWorkstream,
      now: "2026-01-01T00:03:00.000Z",
    });
    const review = reviewRequested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected repository-state review");
    }
    const stale = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "repository_state",
        candidateId: satisfiedCandidate.id,
        assessedTargetSha: "wrong-target",
        evidence: "stale assessment",
        completion: { findings: [] },
      },
    });
    expect(stale.accepted).toBe(false);

    const reassessed = reduceRunEvent(reviewRequested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "repository_state",
        candidateId: satisfiedCandidate.id,
        assessedTargetSha: "target-sha",
        evidence: "repository-state assessment",
        completion: {
          findings: [
            {
              summary: "Representative coverage",
              evidence: "The target lacks an integration scenario.",
              requiredChange: "Add representative coverage.",
              acceptanceCriteria: ["Coverage exercises the task."],
            },
          ],
        },
      },
    });

    const pendingId = "source-first-stream-repository-1-1";
    expect(reassessed.accepted).toBe(true);
    expect(reassessed.state.workstreams.source["first-stream"]?.phase).toBe(
      "revising",
    );
    expect(reassessed.state.reviews["source:first-stream"]).toMatchObject({
      pendingCorrectionIds: [pendingId],
    });
    expect(reassessed.state.findings[pendingId]).toMatchObject({
      status: "open",
      scope: { kind: "source", id: "first-stream" },
    });
    expect(Object.values(reassessed.state.revisionAssignments)).toContainEqual(
      expect.objectContaining({ pendingCorrectionIds: [pendingId] }),
    );

    const correctionRequested = reduceRunEvent(reassessed.state, {
      kind: "revision_requested",
      workstream: sourceWorkstream,
      now: "2026-01-01T00:04:00.000Z",
    });
    const correction = correctionRequested.effects[0]!;
    if (correction.kind !== "run_revision") {
      throw new Error("expected correction");
    }
    const unchanged = reduceRunEvent(correctionRequested.state, {
      kind: "revision_completed",
      workstream: correction.workstream,
      leaseId: correction.leaseId,
      assignmentId: correction.assignmentId,
      outcome: {
        kind: "unchanged",
        evidence: "test command could not start",
        summary: "No safe change",
        verification: ["inspected the target"],
        uncertainty: "dependency installation unavailable",
        artifactPath: "/artifacts/revision.json",
      },
    });
    const finalRequested = reduceRunEvent(unchanged.state, {
      kind: "review_requested",
      workstream: sourceWorkstream,
      now: "2026-01-01T00:05:00.000Z",
    });
    const finalReview = finalRequested.effects[0]!;
    if (finalReview.kind !== "run_review") {
      throw new Error("expected final review");
    }
    const settled = reduceRunEvent(finalRequested.state, {
      kind: "review_completed",
      workstream: finalReview.workstream,
      leaseId: finalReview.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: satisfiedCandidate.id,
        previousCandidateId: satisfiedCandidate.id,
        comparisonBase: "base-sha",
        changedPaths: [],
        findingEpoch: 1,
        assessedTargetSha: "target-sha",
        evidence: "final assessment",
        completion: {
          assessments: [
            {
              id: pendingId,
              status: "unresolved",
              evidence: "Coverage remains unavailable.",
              summary: "Representative coverage",
              requiredChange: "Add representative coverage.",
              acceptanceCriteria: ["Coverage exercises the task."],
            },
          ],
          regressions: [],
        },
      },
    });

    expect(settled.state.workstreams.source["first-stream"]?.phase).toBe(
      "completed",
    );
    expect(Object.values(settled.state.satisfaction.receipts)).toContainEqual(
      expect.objectContaining({
        candidateId: satisfiedCandidate.id,
        assessedTargetSha: "target-sha",
      }),
    );
    expect(settled.state.reviews["source:first-stream"]).toMatchObject({
      pendingCorrectionIds: [],
      latestCorrection: {
        mode: "unchanged",
        artifactPath: "/artifacts/revision.json",
      },
    });
  });

  it("creates one canonical whole-plan finding ledger shared with its repair", async () => {
    const completed = await wholePlanRepairResult();
    const ids = ["overall-repair-1-r1", "overall-repair-1-r2"];

    expect(completed.accepted).toBe(true);
    expect(completed.state.wholePlanReview).toMatchObject({
      status: "repairing",
      epoch: { findingIds: ids, pendingCorrectionIds: ids },
    });
    expect(completed.state.reviews["overall:repair-1"]).toMatchObject({
      candidateId: "overall-baseline:run-1:repair-1:target-sha",
      pendingCorrectionIds: ids,
    });
    expect(completed.state.findings[ids[0]!]).toMatchObject({
      workstream: { kind: "overall", repairId: "repair-1" },
      scope: {
        kind: "whole_plan",
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
      },
      status: "open",
    });
    expect(() => validate(completed.state)).not.toThrow();
  });

  it("retains unchanged overall repair evidence for final review", async () => {
    const queued = await wholePlanRepairResult();
    for (const source of Object.values(queued.state.workstreams.source)) {
      source.phase = "completed";
    }
    const selected = reduceRunEvent(queued.state, {
      kind: "workstreams_selected",
      now: "2026-01-01T00:01:00.000Z",
      baseShas: {},
    });
    const implementation = selected.effects[0]!;
    if (implementation.kind !== "run_implementation") {
      throw new Error("expected overall repair implementation");
    }
    const completed = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: implementation.workstream,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "overall:run-1:repair-1:target-sha",
          workstream: implementation.workstream,
          baseSha: "target-sha",
          commitSha: "target-sha",
          treeSha: "target-tree",
          changedPaths: [],
          evidenceStatus: "reported",
          observationArtifact: "/artifacts/repair.json",
          implementationEvidence: {
            summary: "The target already satisfies the requested behavior.",
            verification: ["Inspected the existing behavior."],
            uncertainty: "Runtime verification could not start.",
            artifactPath: "/artifacts/repair.json",
            changedPaths: [],
          },
        },
        checkpoints: {},
        satisfied: {},
      },
    });

    expect(
      completed.state.reviews["overall:repair-1"]?.latestCorrection,
    ).toEqual({
      fromCandidateId: "overall-baseline:run-1:repair-1:target-sha",
      changedPaths: [],
      evidence: "/artifacts/repair.json",
      mode: "unchanged",
      summary: "The target already satisfies the requested behavior.",
      verification: ["Inspected the existing behavior."],
      uncertainty: "Runtime verification could not start.",
      artifactPath: "/artifacts/repair.json",
    });
  });

  it("approves a final reassessment without waiving its residual finding", async () => {
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
      summary: "Representative coverage",
    });
    expect(
      Object.values(assessed.state.revisionAssignments).some(
        (assignment) => assignment.status === "open",
      ),
    ).toBe(false);
  });

  it("settles final source review with residual findings and no next assignment", async () => {
    const state = await stateAtRevision(1, false, [
      {
        summary: "Missing behavior",
        evidence: "The endpoint is incomplete.",
        requiredChange: "Complete the endpoint.",
        acceptanceCriteria: ["The endpoint responds."],
      },
      {
        summary: "Coverage gap",
        evidence: "The endpoint has no integration coverage.",
        requiredChange: "Add representative coverage.",
        acceptanceCriteria: ["Coverage exercises the endpoint."],
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
    ).toEqual([]);
    expect(
      Object.values(reassessed.state.revisionAssignments).some(
        (assignment) => assignment.status === "open",
      ),
    ).toBe(false);
    expect(reassessed.state.findings["source-first-stream-r2"]?.status).toBe(
      "resolved",
    );
  });

  it("rejects removed findings and invalid historical assignment snapshots", async () => {
    const state = await stateAtRevision();
    const finding = state.findings["source-first-stream-r1"]!;
    const withAdditionalFinding = structuredClone(state);
    withAdditionalFinding.findings["source-first-stream-additional"] = {
      ...finding,
      id: "source-first-stream-additional",
    };
    expect(() => validate(withAdditionalFinding, state)).not.toThrow();

    const withoutAdditionalFinding = structuredClone(withAdditionalFinding);
    delete withoutAdditionalFinding.findings["source-first-stream-additional"];
    expect(
      invariantIssues(withoutAdditionalFinding, withAdditionalFinding),
    ).toContain("finding source-first-stream-additional was removed");

    const invalidSnapshot = structuredClone(state);
    const assignment = Object.values(invalidSnapshot.revisionAssignments)[0]!;
    assignment.status = "completed";
    assignment.pendingCorrectionIds = ["unknown-finding"];
    expect(invariantIssues(invalidSnapshot)).toContain(
      "revision assignment revision:source:first-stream:first-sha:0:1 does not match its review epoch",
    );
  });

  it("rejects divergent overall review and epoch pending authorities", async () => {
    const state = (await wholePlanRepairResult()).state;
    state.reviews["overall:repair-1"]!.pendingCorrectionIds = [];

    expect(invariantIssues(state)).toContain(
      "overall review overall:repair-1 does not match its epoch pending findings",
    );
  });

  it("synchronizes canonical whole-plan findings after repair assessment", async () => {
    const state = (await wholePlanRepairResult()).state;
    const workstream = { kind: "overall" as const, repairId: "repair-1" };
    const baselineId = "overall-baseline:run-1:repair-1:target-sha";
    const candidateId = "overall-repair:repair-1";
    const findingIds = ["overall-repair-1-r1", "overall-repair-1-r2"];
    state.candidates[candidateId] = {
      id: candidateId,
      workstream,
      baseSha: "target-sha",
      commitSha: "repair-sha",
      treeSha: "repair-tree",
    };
    state.workstreams.overall[workstream.repairId] = {
      ...state.workstreams.overall[workstream.repairId]!,
      phase: "candidate_ready",
      candidateId,
    };
    ((state.reviews["overall:repair-1"] = {
      ...state.reviews["overall:repair-1"]!,
      candidateId,
      previousCandidateId: baselineId,
      latestCorrection: {
        fromCandidateId: baselineId,
        changedPaths: ["src/repair.ts"],
        evidence: "repair evidence",
        mode: "changed",
      },
    }),
      {});

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
              summary: "Coverage gap",
              requiredChange: "Add representative coverage.",
              acceptanceCriteria: ["Coverage exercises the repair."],
            },
          ],
          regressions: [],
        },
      },
    });

    expect(assessed.state.findings[findingIds[0]!]?.status).toBe("resolved");
    expect(assessed.state.findings[findingIds[1]!]).toMatchObject({
      status: "open",
    });
    expect(assessed.state.wholePlanReview.epoch?.pendingCorrectionIds).toEqual(
      [],
    );
    expect(() => validate(assessed.state)).not.toThrow();
  });

  it("sends an unchanged correction through one final review without failing the lane", async () => {
    const settled = requestAndLeaveUnchanged(
      await stateAtRevision(),
      "verification could not start",
    );
    const requested = reduceRunEvent(settled, {
      kind: "review_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "2026-01-01T00:03:00.000Z",
    });
    const review = requested.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("expected final review");
    }
    const assessed = reduceRunEvent(requested.state, {
      kind: "review_completed",
      workstream: review.workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "candidate:first",
        previousCandidateId: "candidate:first",
        comparisonBase: "base-sha",
        changedPaths: [],
        findingEpoch: 0,
        evidence: "final review artifact",
        completion: {
          assessments: [
            {
              id: "source-first-stream-r1",
              status: "unresolved",
              evidence: "The missing behavior remains.",
              summary: "missing behavior",
              requiredChange: "complete the endpoint",
              acceptanceCriteria: ["endpoint responds"],
            },
          ],
          regressions: [],
        },
      },
    });

    expect(assessed.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(assessed.state.reviews["source:first-stream"]).toMatchObject({
      pendingCorrectionIds: [],
      latestCorrection: {
        mode: "unchanged",
        evidence: "verification could not start",
      },
    });
    expect(assessed.state.findings["source-first-stream-r1"]?.status).toBe(
      "open",
    );
    expect(
      Object.values(assessed.state.revisionAssignments).some(
        (assignment) => assignment.status === "open",
      ),
    ).toBe(false);
    expect(Object.values(assessed.state.failures)).toEqual([]);
  });

  it("leaves independent workstreams active after an unchanged revision settles", async () => {
    const state = await stateAtRevision(2, true);
    const settled = requestAndLeaveUnchanged(state, "no semantic change");

    expect(settled.workstreams.source["first-stream"]?.phase).toBe(
      "candidate_ready",
    );
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

  it("keeps protocol retries separate from semantic correction settlement", async () => {
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
    expect(Object.values(state.revisionAssignments)[0]?.executionFailures).toBe(
      3,
    );
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

async function wholePlanRepairResult() {
  const state = (await createSchedulerStore()).read();
  state.phase = "whole_plan_review";
  state.wholePlanReview = { status: "reviewing" };
  const repairId = "repair-1";
  const workstream = { kind: "overall" as const, repairId };
  return reduceRunEvent(state, {
    kind: "whole_plan_review_completed",
    outcome: {
      kind: "changes_requested",
      repairId,
      candidate: {
        id: "overall-baseline:run-1:repair-1:target-sha",
        workstream,
        baseSha: "target-sha",
        commitSha: "target-sha",
        treeSha: "target-tree",
      },
      findings: [
        {
          summary: "Missing whole-plan behavior",
          evidence: "The reviewed target misses the contract.",
          requiredChange: "Restore the required behavior.",
          acceptanceCriteria: ["The whole plan is satisfied."],
        },
        {
          summary: "Representative verification",
          evidence: "The target has no representative verification.",
          requiredChange: "Add representative verification.",
          acceptanceCriteria: ["Verification covers the target."],
        },
      ],
      evidence: "whole-plan review artifact",
      reviewedTargetSha: "target-sha",
      reviewedTargetTreeSha: "target-tree",
    },
  });
}

async function stateAtRevision(
  concurrency = 1,
  independent = false,
  findings: Array<{
    summary: string;
    evidence: string;
    requiredChange: string;
    acceptanceCriteria: string[];
  }> = [
    {
      summary: "missing behavior",
      evidence: "the endpoint is incomplete",
      requiredChange: "complete the endpoint",
      acceptanceCriteria: ["endpoint responds"],
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
