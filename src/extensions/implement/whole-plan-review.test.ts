import { afterEach, describe, expect, it } from "vitest";
import { buildAnchoredOverallReviewPrompt } from "./prompts.js";
import {
  buildWholePlanReviewPacket,
  completeWholePlanRun,
} from "./whole-plan-review.js";
import {
  cleanupSchedulerStores,
  createUnboundSchedulerRun,
} from "./scheduler/scheduler-test-support.js";

afterEach(() => cleanupSchedulerStores());

describe("whole-plan review packet", () => {
  it("rejects closure when an approved review omits or blanks its draft", async () => {
    for (const handoffDraft of [undefined, "   "]) {
      const { run } = createUnboundSchedulerRun();
      const state = run.read();
      state.wholePlanReview = {
        status: "approved",
        evidence: "whole-plan evidence",
        ...(handoffDraft === undefined ? {} : { handoffDraft }),
        reviewedTargetSha: "target-sha",
        reviewedTargetTreeSha: "target-tree",
      };

      await expect(
        completeWholePlanRun({
          state,
          git: {} as never,
          dispatch: async () => undefined,
        }),
      ).rejects.toThrow(
        "Whole-plan closure cannot prove the reviewed target boundary.",
      );
    }
  });

  it("includes the latest published overall repair evidence in an anchored review", async () => {
    const { run: store, plan } = createUnboundSchedulerRun();
    await store.bindExecutionPlan(plan);
    const state = store.read();
    const repairId = "repair-1";
    const candidateId = "overall-repair:repair-1";
    state.candidates[candidateId] = {
      id: candidateId,
      workstream: { kind: "overall", repairId },
      baseSha: "target-sha",
      commitSha: "repair-sha",
      treeSha: "repair-tree",
      changedPaths: ["src/extensions/implement/whole-plan-review.ts"],
      evidenceStatus: "reported",
      implementationEvidence: {
        summary: "Preserved the reviewer-authored handoff draft.",
        verification: ["npm run check"],
        uncertainty: "No end-to-end session was available.",
        changedPaths: ["src/extensions/implement/whole-plan-review.ts"],
      },
    };
    state.publication.receipts["publication:repair-1"] = {
      operationId: "publication:repair-1",
      intentId: "publication:repair-1",
      candidateId,
      targetBaseSha: "target-sha",
      publishedCommitSha: "repair-sha",
      publishedTreeSha: "repair-tree",
      targetRef: "refs/heads/main",
      protectedArtifactHashes: state.protectedArtifactHashes,
      publishedAt: "2026-01-01T00:00:00.000Z",
    };
    state.wholePlanReview = {
      status: "pending",
      handoffDraft: "Prior accepted reviewer handoff.",
      epoch: {
        initialTargetSha: "target-sha",
        initialTargetTreeSha: "target-tree",
        findingIds: [],
        pendingCorrectionIds: [],
        latestRepair: {
          candidateId,
          targetBaseSha: "target-sha",
          publishedCommitSha: "repair-sha",
          publishedTreeSha: "repair-tree",
          changedPaths: ["src/extensions/implement/whole-plan-review.ts"],
        },
      },
    };
    const packet = buildWholePlanReviewPacket({
      state,
      plan,
      currentTargetSha: "repair-sha",
      currentTargetTreeSha: "repair-tree",
      previousSha: "target-sha",
      completionKind: "anchored-overall-review",
      outstandingFindings: [],
    });
    const prompt = buildAnchoredOverallReviewPrompt({
      planContext: packet.planContext,
      candidateContext: packet.candidateContext,
      baseSha: packet.baseSha,
      outstandingFindings: [],
      completeFindings: [],
      previousCandidate: packet.previousSha!,
      currentCandidate: packet.target.commitSha,
      latestHandoffDraft: packet.priorHandoffDraft!,
    });

    expect(packet.candidateContext).toContain(
      "Latest published whole-plan repair candidate",
    );
    expect(packet.candidateContext).toContain(candidateId);
    expect(packet.candidateContext).toContain("repair-tree");
    expect(packet.candidateContext).toContain("npm run check");
    expect(packet.candidateContext).toContain(
      "No end-to-end session was available.",
    );
    expect(packet.candidateContext).toContain("publication:repair-1");
    expect(prompt).toContain("Latest published whole-plan repair candidate");
    expect(prompt).toContain("Prior accepted reviewer handoff.");
  });
});
