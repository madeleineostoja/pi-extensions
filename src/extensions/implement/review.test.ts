import { describe, expect, it } from "vitest";
import { workstreamWorkspace } from "./workstream-candidate.js";
import type { RunState } from "./store.js";
import { WorkerPacketError } from "./worker-invocation.js";
import {
  applyAnchoredWorkstreamReview,
  applyInitialWorkstreamReview,
  buildSourceReviewWorkerPacket,
  ReviewEpochMismatchError,
  retargetAnchoredReview,
} from "./review.js";

const workstream = { kind: "source" as const, id: "work" };
const previousCandidate = {
  id: "candidate:work:previous",
  workstream,
  baseSha: "base",
  commitSha: "previous",
  treeSha: "previous-tree",
};
const candidate = {
  ...previousCandidate,
  id: "candidate:work:tip",
  commitSha: "tip",
  treeSha: "tip-tree",
};

function initialReview() {
  return applyInitialWorkstreamReview({
    workstream,
    candidateId: previousCandidate.id,
    candidateCommitSha: previousCandidate.commitSha,
    candidateTreeSha: previousCandidate.treeSha,
    comparisonBase: "base",
    completion: {
      publicationCommitSubject: "feat: publish workstream",
      findings: [
        {
          summary: "Missing behavior",
          evidence: "The endpoint returns 404.",
          requiredChange: "Add the endpoint.",
          acceptanceCriteria: ["The endpoint returns 200."],
        },
        {
          summary: "Coverage gap",
          evidence: "The endpoint has no integration test.",
          requiredChange: "Add representative coverage.",
          acceptanceCriteria: ["The endpoint is covered."],
        },
      ],
    },
    evidence: "initial review",
  });
}

function correctionReview() {
  const initial = initialReview();
  return {
    initial,
    review: retargetAnchoredReview({
      state: initial.review,
      candidate,
      comparisonBase: "base",
      correctionRange: {
        baseSha: previousCandidate.commitSha,
        headSha: candidate.commitSha,
      },
      correction: {
        fromCandidateId: previousCandidate.id,
        changedPaths: ["src/incidental.ts"],
        evidence: "correction",
      },
    }),
  };
}

describe("canonical review findings", () => {
  it("classifies anchored epoch mismatches as packet failures", () => {
    expect(new ReviewEpochMismatchError("mismatch")).toBeInstanceOf(
      WorkerPacketError,
    );
  });

  it("assigns every initial finding once and retains narrowed residuals without pending work", () => {
    const { initial, review } = correctionReview();

    expect(initial.review.pendingCorrectionIds).toEqual(
      initial.findings.map((finding) => finding.id),
    );

    const assessed = applyAnchoredWorkstreamReview({
      state: review,
      workstream,
      findings: initial.findings,
      completion: {
        assessments: [
          {
            id: initial.findings[0]!.id,
            status: "resolved",
            evidence: "The endpoint returns 200.",
          },
          {
            id: initial.findings[1]!.id,
            status: "unresolved",
            evidence: "One scenario remains uncovered.",
            summary: "One integration scenario remains",
            requiredChange: "Cover the remaining scenario.",
            acceptanceCriteria: ["The remaining scenario is covered."],
          },
        ],
        regressions: [],
      },
      evidence: "assessment",
      correctionPaths: ["src/endpoint.ts"],
    });

    expect(assessed.review.pendingCorrectionIds).toEqual([]);
    expect(assessed.review.publicationCommitSubject).toBe(
      "feat: publish workstream",
    );
    expect(assessed.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: initial.findings[0]!.id,
          status: "resolved",
        }),
        expect.objectContaining({
          id: initial.findings[1]!.id,
          status: "open",
          summary: "One integration scenario remains",
        }),
      ]),
    );
  });

  it("materializes a reconciled review packet against its integration-base range", () => {
    const reconciliationCandidate = {
      ...candidate,
      id: "reconciliation:work:tip",
      commitSha: "reconciled",
      treeSha: "reconciled-tree",
      integrationBaseSha: "integrated",
      changedPaths: ["src/integrated.ts"],
    };
    const review = retargetAnchoredReview({
      state: {
        ...initialReview().review,
        pendingCorrectionIds: [],
        correctionConsumed: false,
      },
      candidate: reconciliationCandidate,
      comparisonBase: "integrated",
      correctionRange: { baseSha: "integrated", headSha: "reconciled" },
      correction: {
        fromCandidateId: previousCandidate.id,
        changedPaths: ["src/integrated.ts"],
        evidence: "reconciliation",
      },
    });
    const state = {
      run: { id: "run", checkout: { root: "/checkout" } },
      workstreams: {
        source: {
          work: {
            kind: "source",
            id: "work",
            baseSha: "base",
            candidateId: reconciliationCandidate.id,
          },
        },
        overall: {},
      },
      candidates: {
        [previousCandidate.id]: previousCandidate,
        [reconciliationCandidate.id]: reconciliationCandidate,
      },
      findings: {},
    } as unknown as RunState;
    const packet = buildSourceReviewWorkerPacket({
      state,
      workstream,
      workspacePath: workstreamWorkspace(state, workstream.id).worktreePath,
      review,
      actualChangedPaths: ["src/integrated.ts"],
      packet: {
        workstream,
        candidate: reconciliationCandidate,
        previousCandidate,
        contracts: [],
        sourceMaterial: [],
        corpus: [],
        schedule: { tasks: [], workstreams: [] },
        checkpoints: {},
        satisfiedEvidence: {},
        outstandingFindings: [],
        latestCorrection: review.latestCorrection,
        comparisonBase: review.comparisonBase,
        findingEpoch: review.round,
      },
    });

    expect(packet.latestCorrection).toMatchObject({
      rangeBaseSha: "integrated",
      rangeHeadSha: "reconciled",
      changedPaths: ["src/integrated.ts"],
    });
    expect(() =>
      buildSourceReviewWorkerPacket({
        state,
        workstream,
        workspacePath: workstreamWorkspace(state, workstream.id).worktreePath,
        review: {
          ...review,
          latestCorrection: {
            ...review.latestCorrection!,
            rangeHeadSha: previousCandidate.commitSha,
          },
        },
        actualChangedPaths: ["src/integrated.ts"],
        packet: {
          ...packet,
          latestCorrection: {
            ...packet.latestCorrection!,
            rangeHeadSha: previousCandidate.commitSha,
          },
        },
      }),
    ).toThrow(ReviewEpochMismatchError);
  });

  it("uses the exact reviewed correction boundary for causal regressions", () => {
    const { initial, review } = correctionReview();
    const assessed = applyAnchoredWorkstreamReview({
      state: review,
      workstream,
      findings: initial.findings,
      completion: {
        assessments: initial.findings.map((finding) => ({
          id: finding.id,
          status: "resolved" as const,
          evidence: "Verified.",
        })),
        regressions: [
          {
            summary: "Correction regression",
            evidence: "The correction breaks the response.",
            requiredChange: "Restore the response.",
            acceptanceCriteria: ["The response works."],
            changedPaths: ["src/endpoint.ts"],
          },
        ],
      },
      evidence: "assessment",
      correctionPaths: ["src/endpoint.ts"],
    });

    expect(assessed.findings).toContainEqual(
      expect.objectContaining({
        summary: "Correction regression",
        origin: "regression",
        status: "open",
      }),
    );
    expect(assessed.review.pendingCorrectionIds).toEqual([]);
  });

  it("anchors unchanged corrections to the same candidate and rejects regressions", () => {
    const initial = initialReview();
    const review = retargetAnchoredReview({
      state: initial.review,
      candidate: previousCandidate,
      comparisonBase: "base",
      correctionRange: {
        baseSha: previousCandidate.commitSha,
        headSha: previousCandidate.commitSha,
      },
      correction: {
        fromCandidateId: previousCandidate.id,
        changedPaths: [],
        evidence: "tests could not start",
        summary: "No safe source change",
        verification: ["test command was blocked"],
        uncertainty: "dependency installation unavailable",
        artifactPath: "/artifacts/unchanged.json",
      },
    });

    expect(review.latestCorrection).toMatchObject({
      mode: "unchanged",
      evidence: "tests could not start",
      verification: ["test command was blocked"],
    });
    expect(() =>
      applyAnchoredWorkstreamReview({
        state: review,
        workstream,
        findings: initial.findings,
        completion: {
          assessments: initial.findings.map((finding) => ({
            id: finding.id,
            status: "resolved" as const,
            evidence: "Reviewed.",
          })),
          regressions: [
            {
              summary: "Impossible regression",
              evidence: "No change exists.",
              requiredChange: "None.",
              acceptanceCriteria: ["None."],
              changedPaths: ["src/endpoint.ts"],
            },
          ],
        },
        evidence: "assessment",
        correctionPaths: [],
      }),
    ).toThrow("An unchanged correction cannot introduce regressions.");
  });

  it("rejects duplicate, missing, and foreign assessments", () => {
    const { initial, review } = correctionReview();
    const resolved = {
      id: initial.findings[0]!.id,
      status: "resolved" as const,
      evidence: "Verified.",
    };

    for (const assessments of [
      [resolved],
      [resolved, resolved, { ...resolved, id: initial.findings[1]!.id }],
      [resolved, { ...resolved, id: "foreign" }],
    ]) {
      expect(() =>
        applyAnchoredWorkstreamReview({
          state: review,
          workstream,
          findings: initial.findings,
          completion: { assessments, regressions: [] },
          evidence: "assessment",
          correctionPaths: ["src/endpoint.ts"],
        }),
      ).toThrow(
        "Anchored review must assess each outstanding finding exactly once.",
      );
    }
  });

  it("requires an observed target tree for whole-plan findings", () => {
    expect(() =>
      applyInitialWorkstreamReview({
        workstream: { kind: "overall", repairId: "repair" },
        candidateId: "candidate:repair",
        candidateCommitSha: "target-sha",
        candidateTreeSha: "target-tree",
        comparisonBase: "target-sha",
        completion: { findings: [] },
        evidence: "review",
      }),
    ).toThrow("Whole-plan findings require an observed target tree.");
  });
});
