import { afterEach, describe, expect, it } from "vitest";
import { buildRecoveryPacket } from "../recovery/recovery-packet.js";
import { buildReviewPacket } from "../review.js";
import { reduceRunEvent, selectReadyWorkstreams } from "./scheduler.js";
import {
  cleanupSchedulerStores,
  createSchedulerStore as store,
  planFor,
} from "./scheduler-test-support.js";

afterEach(cleanupSchedulerStores);

describe("scheduler planning and candidate selection", () => {
  it("assigns a landed dependency base when a dependent becomes eligible", async () => {
    const run = await store(1);
    const initial = run.read();

    expect(selectReadyWorkstreams(initial)).toEqual(["first-stream"]);
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base-sha" },
    });

    expect(selected.accepted).toBe(true);
    expect(selected.effects).toEqual([
      {
        kind: "run_implementation",
        workstream: { kind: "source", id: "first-stream" },
        leaseId: "implementation:run-1:2:0",
      },
    ]);
    expect(selectReadyWorkstreams(selected.state)).toEqual([]);

    selected.state.processLeases = {};
    selected.state.workstreams.source["first-stream"]!.phase = "completed";
    selected.state.workstreams.source["first-stream"]!.candidateId =
      "candidate:first";
    selected.state.candidates["candidate:first"] = {
      id: "candidate:first",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base-sha",
      commitSha: "commit:first",
      treeSha: "tree:first",
    };
    selected.state.publication.receipts["intent:first"] = {
      operationId: "publication:first",
      intentId: "intent:first",
      candidateId: "candidate:first",
      targetBaseSha: "base-sha",
      publishedCommitSha: "commit:first",
      publishedTreeSha: "tree:first",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: {},
      publishedAt: "now",
    };
    expect(selectReadyWorkstreams(selected.state)).toEqual(["second-stream"]);

    const dependent = reduceRunEvent(selected.state, {
      kind: "workstreams_selected",
      now: "later",
      baseShas: { "second-stream": "landed-dependency-sha" },
    });
    expect(dependent.accepted).toBe(true);
    expect(dependent.state.workstreams.source["second-stream"]?.baseSha).toBe(
      "landed-dependency-sha",
    );
  });

  it("builds an initial cumulative packet with contracts and repository-state evidence", async () => {
    const run = await store();
    const state = run.read();
    const candidate = {
      id: "satisfied:first-stream:base-sha",
      workstream: { kind: "source" as const, id: "first-stream" },
      baseSha: "base-sha",
      commitSha: "base-sha",
      treeSha: "base-tree",
      implementationEvidence: {
        summary: "The behavior already exists.",
        verification: ["Focused tests passed."],
      },
    };
    state.candidates[candidate.id] = candidate;
    state.workstreams.source["first-stream"]!.candidateId = candidate.id;
    state.tasks.first = {
      workstreamId: "first-stream",
      phase: "satisfaction_claimed",
      evidence: "Existing endpoint satisfies the contract.",
    };

    const plan = planFor(state.run.checkout.root);
    const packet = buildReviewPacket({
      state,
      plan,
      workstream: { kind: "source", id: "first-stream" },
    });

    expect(packet.contracts.map((task) => task.id)).toEqual(["first"]);
    expect(packet.satisfiedEvidence).toEqual({
      first: "Existing endpoint satisfies the contract.",
    });
    expect(packet.sourceMaterial).toEqual([
      expect.objectContaining({ path: expect.any(String) }),
    ]);
    expect(packet.verificationEvidence?.verification).toHaveLength(1);
  });

  it("rejects overlapping checkpoint and satisfied mappings", async () => {
    const initial = (await store()).read();
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base" },
    });
    const effect = selected.effects.find(
      (effect) => effect.kind === "run_implementation",
    );
    if (!effect || effect.kind !== "run_implementation") {
      throw new Error("Expected implementation effect.");
    }

    const result = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate: {
          id: "candidate-1",
          workstream: effect.workstream,
          baseSha: "base",
          commitSha: "commit",
          treeSha: "tree",
        },
        checkpoints: { first: "commit" },
        satisfied: { first: "already present" },
      },
    });

    expect(result.accepted).toBe(false);
  });

  it("retains one operation settlement and only recognizes an equivalent duplicate", async () => {
    const initial = (await store()).read();
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base" },
    });
    const effect = selected.effects.find(
      (candidate) => candidate.kind === "run_implementation",
    );
    if (!effect || effect.kind !== "run_implementation") {
      throw new Error("Expected implementation effect.");
    }
    const event = {
      kind: "implementation_completed" as const,
      workstream: effect.workstream,
      leaseId: effect.leaseId,
      outcome: {
        kind: "satisfaction_claimed" as const,
        candidate: {
          id: "satisfied:first-stream:base",
          workstream: effect.workstream,
          baseSha: "base",
          commitSha: "base",
          treeSha: "tree",
        },
        evidence: { first: "The target already satisfies this task." },
      },
    };

    const settled = reduceRunEvent(selected.state, event);
    expect(settled.accepted).toBe(true);
    expect(settled.state.operationSettlements[effect.leaseId]).toMatchObject({
      operationId: effect.leaseId,
      outcome: "implementation_completed",
    });

    const duplicate = reduceRunEvent(settled.state, event);
    expect(duplicate).toEqual({
      state: settled.state,
      effects: [],
      accepted: true,
    });

    const conflict = reduceRunEvent(settled.state, {
      ...event,
      outcome: {
        ...event.outcome,
        evidence: { first: "Contradictory completion evidence." },
      },
    });
    expect(conflict.accepted).toBe(false);
    expect(conflict.error).toContain("already settled");
  });

  it("rejects a stale process result without changing canonical state", async () => {
    const initial = (await store()).read();
    const result = reduceRunEvent(initial, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "missing",
      outcome: {
        kind: "initial",
        candidateId: "candidate-1",
        completion: {
          verdict: "approved",
          publicationCommitSubject: "feat: publish workstream",
        },
        evidence: "review artifact",
      },
    });

    expect(result).toMatchObject({ accepted: false, state: initial });
  });
});

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
          stagingComparison: {
            baseSha: "target-base",
            treeSha: "staged-tree",
          },
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
    expect(
      Object.values(failed.state.recoveryEpisodes).at(-1)?.workspace
        .stagingComparison,
    ).toEqual({ baseSha: "target-base", treeSha: "staged-tree" });
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
    const continued = reduceRunEvent(interrupted.state, {
      kind: "whole_plan_recovery_requested",
    });
    const completed = reduceRunEvent(continued.state, {
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
    expect(continued.effects).toEqual([{ kind: "run_whole_plan_recovery" }]);
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

describe("scheduler recovery lifecycle", () => {
  it("persists direct findings and converges every anchored obligation on a new candidate", async () => {
    const initial = (await store()).read();
    const selected = reduceRunEvent(initial, {
      kind: "workstreams_selected",
      now: "now",
      baseShas: { "first-stream": "base" },
    });
    const implementation = selected.effects[0]!;
    if (implementation.kind !== "run_implementation") {
      throw new Error("Expected implementation effect.");
    }
    const candidate = {
      id: "candidate-1",
      workstream: implementation.workstream,
      baseSha: "base",
      commitSha: "commit-1",
      treeSha: "tree-1",
    };
    const ready = reduceRunEvent(selected.state, {
      kind: "implementation_completed",
      workstream: implementation.workstream,
      leaseId: implementation.leaseId,
      outcome: {
        kind: "candidate_ready",
        candidate,
        checkpoints: { first: "commit-1" },
        satisfied: {},
      },
    });
    const review = reduceRunEvent(ready.state, {
      kind: "review_requested",
      workstream: implementation.workstream,
      now: "now",
    });
    const reviewEffect = review.effects[0]!;
    if (reviewEffect.kind !== "run_review") {
      throw new Error("Expected review effect.");
    }
    const findings = reduceRunEvent(review.state, {
      kind: "review_completed",
      workstream: implementation.workstream,
      leaseId: reviewEffect.leaseId,
      outcome: {
        kind: "initial",
        candidateId: "candidate-1",
        evidence: "initial review artifact",
        completion: {
          verdict: "changes_requested",
          publicationCommitSubject: "feat: publish workstream",
          findings: [
            {
              summary: "Missing observable behavior",
              evidence: "The endpoint is absent.",
              requiredChange: "Add the endpoint.",
              acceptanceCriteria: ["The endpoint responds."],
            },
          ],
        },
      },
    });
    expect(findings.state.workstreams.source["first-stream"]?.phase).toBe(
      "recovering",
    );
    expect(
      findings.state.reviews["source:first-stream"]?.outstandingIds,
    ).toEqual(["source-first-stream-r1"]);
    expect(findings.state.gates).toMatchObject([
      {
        kind: "review",
        outcome: "failed",
        candidateId: "candidate-1",
        outstandingFindingIds: ["source-first-stream-r1"],
      },
    ]);
    expect(Object.values(findings.state.recoveryEpisodes)).toMatchObject([
      {
        status: "open",
        candidateId: "candidate-1",
        workspace: {
          id: "source:first-stream",
          checkpoint: "commit-1",
          changedPaths: [],
          stateEvidence: "Workspace state was retained by the failed gate.",
        },
      },
    ]);

    const recovery = reduceRunEvent(findings.state, {
      kind: "recovery_requested",
      workstream: implementation.workstream,
      now: "later",
    });
    const recoveryEffect = recovery.effects[0]!;
    if (recoveryEffect.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const corrected = reduceRunEvent(recovery.state, {
      kind: "recovery_completed",
      workstream: implementation.workstream,
      leaseId: recoveryEffect.leaseId,
      action: {
        kind: "rework_candidate",
        outcome: "completed",
        summary: "Implemented the required endpoint.",
        evidence: "checkpoint commit-2",
        at: "later",
      },
      candidate: {
        ...candidate,
        id: "candidate-2",
        commitSha: "commit-2",
        treeSha: "tree-2",
      },
      correction: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/endpoint.ts"],
        evidence: "Implementer checkpoint commit-2",
      },
    });
    expect(Object.values(corrected.state.recoveryEpisodes)).toMatchObject([
      {
        status: "completed",
        actions: [{ kind: "rework_candidate", outcome: "completed" }],
      },
    ]);

    const anchored = reduceRunEvent(corrected.state, {
      kind: "review_requested",
      workstream: implementation.workstream,
      now: "later",
    });
    const anchoredEffect = anchored.effects[0]!;
    if (anchoredEffect.kind !== "run_review") {
      throw new Error("Expected anchored review effect.");
    }
    const approved = reduceRunEvent(anchored.state, {
      kind: "review_completed",
      workstream: implementation.workstream,
      leaseId: anchoredEffect.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "anchored review artifact",
        completion: {
          assessments: [
            {
              id: "source-first-stream-r1",
              status: "resolved",
              evidence: "The endpoint now responds.",
            },
          ],
          regressions: [
            {
              summary: "caused regression",
              evidence: "New endpoint breaks another route.",
              requiredChange: "Repair the route.",
              acceptanceCriteria: ["Both routes work."],
              changedPaths: ["src/other.ts"],
            },
          ],
        },
      },
    });
    expect(approved.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(approved.state.findings["source-first-stream-r1"]?.status).toBe(
      "resolved",
    );
    expect(approved.state.reviews["source:first-stream"]?.observations).toEqual(
      [
        {
          summary: "caused regression",
          evidence: "New endpoint breaks another route.",
        },
      ],
    );
  });

  it("advances an active recovery episode to the narrowed anchored review gate", async () => {
    const run = await store();
    let state = run.read();
    const workstream = { kind: "source" as const, id: "first-stream" };
    state.workstreams.source[workstream.id]!.phase = "recovering";
    state.workstreams.source[workstream.id]!.baseSha = "base-sha";
    state.workstreams.source[workstream.id]!.candidateId = "candidate-2";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream,
      baseSha: "base-sha",
      commitSha: "commit-1",
      treeSha: "tree-1",
    };
    state.candidates["candidate-2"] = {
      ...state.candidates["candidate-1"],
      id: "candidate-2",
      commitSha: "commit-2",
      treeSha: "tree-2",
    };
    for (const id of ["finding-1", "finding-2"]) {
      state.findings[id] = {
        id,
        candidateId: "candidate-1",
        workstream,
        summary: `${id} remains`,
        evidence: `${id} evidence`,
        requiredChange: `Fix ${id}`,
        acceptanceCriteria: [`${id} passes`],
        origin: "initial",
        introducedRound: 0,
        status: "open",
      };
    }
    state.reviews["source:first-stream"] = {
      candidateId: "candidate-2",
      previousCandidateId: "candidate-1",
      round: 1,
      outstandingIds: ["finding-1", "finding-2"],
      latestCorrection: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/fix.ts"],
        evidence: "Corrected both findings.",
      },
      evidence: ["first review"],
      observations: [],
    };
    state.gates.push({
      id: "review:source:first-stream:candidate-2:1",
      kind: "review",
      workstream,
      candidateId: "candidate-2",
      attempt: 1,
      outcome: "failed",
      evidence: "Both findings remain open.",
      outstandingFindingIds: ["finding-1", "finding-2"],
    });
    state.recoveryEpisodes.episode = {
      id: "episode",
      gateId: "review:source:first-stream:candidate-2:1",
      gateAttempts: ["review:source:first-stream:candidate-2:1"],
      workstream,
      candidateId: "candidate-2",
      workspace: {
        id: "source:first-stream",
        checkpoint: "commit-2",
        changedPaths: [],
        stateEvidence: "The first review failed.",
      },
      outstandingFindingIds: ["finding-1", "finding-2"],
      status: "open",
      cycle: {
        signature: "first",
        identicalNoActionCycles: 0,
        independentlyEscalated: false,
      },
      executionFailures: 0,
      actions: [],
    };

    await run.update(state.revision, () => state);
    state = run.read();

    const requested = reduceRunEvent(state, {
      kind: "recovery_requested",
      workstream,
      now: "now",
    });
    const recovery = requested.effects[0]!;
    if (recovery.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    await run.update(state.revision, () => requested.state);
    state = run.read();
    const retried = reduceRunEvent(state, {
      kind: "recovery_completed",
      workstream,
      leaseId: recovery.leaseId,
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "The existing candidate can be reviewed again.",
        evidence: "No further changes are needed before review.",
        at: "later",
      },
    });
    await run.update(state.revision, () => retried.state);
    state = run.read();
    const reviewed = reduceRunEvent(state, {
      kind: "review_requested",
      workstream,
      now: "later",
    });
    const review = reviewed.effects[0]!;
    if (review.kind !== "run_review") {
      throw new Error("Expected review effect.");
    }
    await run.update(state.revision, () => reviewed.state);
    state = run.read();
    const narrowed = reduceRunEvent(state, {
      kind: "review_completed",
      workstream,
      leaseId: review.leaseId,
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "The first finding is resolved; the second remains.",
        completion: {
          assessments: [
            {
              id: "finding-1",
              status: "resolved",
              evidence: "The first behavior now works.",
            },
            {
              id: "finding-2",
              status: "unresolved",
              evidence: "The second behavior still fails.",
            },
          ],
          regressions: [],
        },
      },
    });

    expect(narrowed.accepted).toBe(true);
    await run.update(state.revision, () => narrowed.state);
    const persisted = run.read();
    expect(persisted.recoveryEpisodes.episode).toMatchObject({
      gateId: "review:source:first-stream:candidate-2:3",
      gateAttempts: [
        "review:source:first-stream:candidate-2:1",
        "review:source:first-stream:candidate-2:3",
      ],
      outstandingFindingIds: ["finding-2"],
      status: "open",
    });
    expect(persisted.findings["finding-1"]?.status).toBe("resolved");
    expect(
      buildRecoveryPacket({
        state: persisted,
        effect: {
          kind: "run_recovery",
          workstream,
          leaseId: "next-lease",
          episodeId: "episode",
          independentlyEscalated: false,
        },
      }).outstandingFindings.map((finding) => finding.id),
    ).toEqual(["finding-2"]);
  });

  it("keeps a same-candidate environment repair open for a retried gate", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.workstreams.source["first-stream"]!.phase = "candidate_ready";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const failed = reduceRunEvent(state, {
      kind: "gate_recorded",
      workstream: { kind: "source", id: "first-stream" },
      result: {
        id: "environment:first-stream:1",
        kind: "environment",
        owner: "source:first-stream",
        candidateId: "candidate-1",
        attempt: 1,
        outcome: "failed",
        evidence: "node_modules is missing",
        outstandingFindingIds: [],
      },
      workspace: {
        id: "source:first-stream",
        checkpoint: "commit",
        changedPaths: [],
        stateEvidence: "Dependencies are absent from the owned workspace.",
      },
    });
    const requested = reduceRunEvent(failed.state, {
      kind: "recovery_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const repaired = reduceRunEvent(requested.state, {
      kind: "recovery_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: effect.leaseId,
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "Installed the missing dependencies.",
        evidence: "npm install completed in the owned worktree.",
        at: "later",
      },
    });

    expect(repaired.accepted).toBe(true);
    expect(repaired.state.workstreams.source["first-stream"]?.phase).toBe(
      "queued",
    );
    expect(Object.values(repaired.state.recoveryEpisodes)).toMatchObject([
      { status: "open", actions: [{ kind: "retry" }] },
    ]);
  });

  it("retains a hook gate with command evidence and retries reconciliation", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.candidateId = "candidate-1";
    state.workstreams.source["first-stream"]!.phase = "candidate_ready";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "commit",
      treeSha: "tree",
    };
    const failed = reduceRunEvent(state, {
      kind: "gate_recorded",
      workstream: { kind: "source", id: "first-stream" },
      result: {
        id: "hook:first-stream:1",
        kind: "hook",
        owner: "source:first-stream",
        candidateId: "candidate-1",
        attempt: 1,
        outcome: "failed",
        evidence: "pre-commit rejected the staged replay",
        command: {
          command: "git commit -m chore",
          cwd: "/tmp/staging",
          exitCode: 1,
          timedOut: false,
          output: "rejected",
        },
        outstandingFindingIds: [],
      },
      workspace: {
        id: "staging:candidate-1",
        checkpoint: "commit",
        changedPaths: ["candidate.txt"],
        stateEvidence: "Hook rejected the disposable staging commit.",
      },
    });
    const requested = reduceRunEvent(failed.state, {
      kind: "recovery_requested",
      workstream: { kind: "source", id: "first-stream" },
      now: "now",
    });
    const effect = requested.effects[0]!;
    if (effect.kind !== "run_recovery") {
      throw new Error("Expected recovery effect.");
    }
    const retried = reduceRunEvent(requested.state, {
      kind: "recovery_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: effect.leaseId,
      action: {
        kind: "retry",
        outcome: "completed",
        summary: "Repaired the hook runtime.",
        evidence: "Dependency restored in staging.",
        at: "later",
      },
    });

    expect(retried.state.workstreams.source["first-stream"]?.phase).toBe(
      "approved",
    );
    expect(retried.state.gates[0]).toMatchObject({
      kind: "hook",
      command: { output: "rejected" },
    });
  });

  it("rejects incomplete anchored coverage and stale candidate review results", async () => {
    const state = (await store()).read();
    state.workstreams.source["first-stream"]!.phase = "reviewing";
    state.workstreams.source["first-stream"]!.candidateId = "candidate-2";
    state.candidates["candidate-1"] = {
      id: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      baseSha: "base",
      commitSha: "one",
      treeSha: "one",
    };
    state.candidates["candidate-2"] = {
      ...state.candidates["candidate-1"]!,
      id: "candidate-2",
      commitSha: "two",
      treeSha: "two",
    };
    state.findings["source-first-stream-r1"] = {
      id: "source-first-stream-r1",
      candidateId: "candidate-1",
      workstream: { kind: "source", id: "first-stream" },
      summary: "missing behavior",
      evidence: "missing",
      requiredChange: "fix it",
      acceptanceCriteria: ["works"],
      origin: "initial",
      introducedRound: 0,
      status: "open",
    };
    state.reviews["source:first-stream"] = {
      candidateId: "candidate-2",
      previousCandidateId: "candidate-1",
      round: 0,
      outstandingIds: ["source-first-stream-r1"],
      latestCorrection: {
        fromCandidateId: "candidate-1",
        changedPaths: ["src/fix.ts"],
        evidence: "checkpoint",
      },
      evidence: ["initial"],
      observations: [],
    };
    state.processLeases.review = {
      id: "review",
      kind: "review",
      workstream: { kind: "source", id: "first-stream" },
      candidateId: "candidate-2",
      attempt: 1,
      acquiredAt: "now",
    };
    const incomplete = reduceRunEvent(state, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "anchored",
        candidateId: "candidate-2",
        evidence: "artifact",
        completion: { assessments: [], regressions: [] },
      },
    });
    expect(incomplete.accepted).toBe(false);
    const stale = reduceRunEvent(state, {
      kind: "review_completed",
      workstream: { kind: "source", id: "first-stream" },
      leaseId: "review",
      outcome: {
        kind: "anchored",
        candidateId: "candidate-1",
        evidence: "artifact",
        completion: { assessments: [], regressions: [] },
      },
    });
    expect(stale.accepted).toBe(false);
  });
});
