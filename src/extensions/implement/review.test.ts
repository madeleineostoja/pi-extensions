import { describe, expect, it } from "vitest";
import {
  applyAnchoredWorkstreamReview,
  applyInitialWorkstreamReview,
  buildSourceReviewWorkerPacket,
  retargetAnchoredReview,
  type ReviewPacket,
  type ReviewState,
} from "./review.js";
import {
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
} from "./prompts.js";
import type { RunState } from "./store.js";

const workstream = { kind: "source" as const, id: "work" };
const candidate = {
  id: "candidate:work:tip",
  workstream,
  baseSha: "base",
  commitSha: "tip",
  treeSha: "tree",
};
const previousCandidate = {
  ...candidate,
  id: "candidate:work:previous",
  commitSha: "previous",
  treeSha: "previous-tree",
};
const workspacePath = "/checkout/.pi/pipkin/implement/worktrees/run-1/work";

function state(): RunState {
  return {
    run: { id: "run-1", checkout: { root: "/checkout" } },
    workstreams: {
      source: {
        work: {
          ...workstream,
          baseSha: "base",
          candidateId: candidate.id,
        },
      },
      overall: {},
    },
    findings: {
      "finding-1": packet().outstandingFindings[0],
    },
  } as unknown as RunState;
}

function packet(): ReviewPacket {
  return {
    workstream,
    candidate,
    previousCandidate,
    contracts: [],
    sourceMaterial: [{ path: "plan.md", content: "# Plan" }],
    corpus: [{ path: "plan.md", content: "# Plan" }],
    schedule: { tasks: [], workstreams: [] },
    checkpoints: {},
    satisfiedEvidence: {},
    outstandingFindings: [
      {
        id: "finding-1",
        candidateId: previousCandidate.id,
        workstream,
        scope: { kind: "source", id: "work" },
        summary: "Missing behavior",
        evidence: "The endpoint returns 404.",
        requiredChange: "Add the endpoint.",
        acceptanceCriteria: ["The endpoint returns 200."],
        disposition: "blocking",
        origin: "initial",
        introducedRound: 0,
        status: "open",
      },
    ],
    latestCorrection: {
      fromCandidateId: previousCandidate.id,
      changedPaths: ["src/endpoint.ts"],
      evidence: "Committed the correction.",
    },
    comparisonBase: "base",
    findingEpoch: 1,
    priorReviewEvidence: ["/orchestrator/review.json"],
  };
}

describe("source review worker packets", () => {
  it("gives mixed initial findings one correction pass and retains narrowed advisories", () => {
    const initial = applyInitialWorkstreamReview({
      workstream,
      candidateId: previousCandidate.id,
      comparisonBase: previousCandidate.baseSha,
      completion: {
        publicationCommitSubject: "feat: publish workstream",
        findings: [
          {
            summary: "Blocking behavior",
            evidence: "The endpoint fails.",
            requiredChange: "Make the endpoint work.",
            acceptanceCriteria: ["The endpoint responds."],
            disposition: "blocking",
          },
          {
            summary: "Coverage gap",
            evidence: "The endpoint has no integration test.",
            requiredChange: "Add representative coverage.",
            acceptanceCriteria: ["The endpoint is covered."],
            disposition: "advisory",
          },
        ],
      },
      evidence: "initial review",
    });
    expect(initial.review.pendingCorrectionIds).toEqual(
      initial.findings.map((finding) => finding.id),
    );

    const assessed = applyAnchoredWorkstreamReview({
      state: retargetAnchoredReview({
        state: initial.review,
        candidateId: candidate.id,
        comparisonBase: "base",
        correction: {
          fromCandidateId: previousCandidate.id,
          changedPaths: ["src/endpoint.ts"],
          evidence: "correction",
        },
      }),
      workstream,
      findings: initial.findings,
      completion: {
        assessments: [
          {
            id: initial.findings[0]!.id,
            status: "resolved",
            evidence: "The endpoint responds.",
          },
          {
            id: initial.findings[1]!.id,
            status: "unresolved",
            evidence: "A narrower integration scenario remains uncovered.",
            disposition: "advisory",
            summary: "One integration scenario remains",
            requiredChange: "Cover the remaining scenario.",
            acceptanceCriteria: ["The remaining scenario is covered."],
          },
        ],
        regressions: [],
      },
      evidence: "assessment",
    });

    expect(assessed.review.pendingCorrectionIds).toEqual([]);
    expect(assessed.findings).toContainEqual(
      expect.objectContaining({
        id: initial.findings[1]!.id,
        status: "open",
        disposition: "advisory",
        summary: "One integration scenario remains",
      }),
    );
  });
  it("retains causal advisory regressions without an advisory-only correction", () => {
    const initial = applyInitialWorkstreamReview({
      workstream,
      candidateId: previousCandidate.id,
      comparisonBase: "base",
      completion: {
        publicationCommitSubject: "fix: publish workstream",
        findings: [
          {
            summary: "Original blocker",
            evidence: "Original failure.",
            requiredChange: "Fix the original failure.",
            acceptanceCriteria: ["Original behavior works."],
            disposition: "blocking",
          },
        ],
      },
      evidence: "initial review",
    });
    const reviewed = applyAnchoredWorkstreamReview({
      state: retargetAnchoredReview({
        state: initial.review,
        candidateId: candidate.id,
        comparisonBase: "base",
        correction: {
          fromCandidateId: previousCandidate.id,
          changedPaths: ["src/endpoint.ts"],
          evidence: "correction",
        },
      }),
      workstream,
      findings: initial.findings,
      completion: {
        assessments: [
          {
            id: initial.findings[0]!.id,
            status: "resolved",
            evidence: "Original behavior works.",
          },
        ],
        regressions: [
          {
            summary: "Advisory regression",
            evidence: "Representative coverage is absent.",
            requiredChange: "Add representative coverage.",
            acceptanceCriteria: ["Coverage exercises the change."],
            disposition: "advisory",
            changedPaths: ["src/endpoint.ts"],
          },
          {
            summary: "Blocking regression",
            evidence: "The response is malformed.",
            requiredChange: "Return a valid response.",
            acceptanceCriteria: ["The response is valid."],
            disposition: "blocking",
            changedPaths: ["src/endpoint.ts"],
          },
        ],
      },
      evidence: "assessment",
    });

    expect(reviewed.review.pendingCorrectionIds).toEqual([
      reviewed.findings.find(
        (finding) => finding.summary === "Blocking regression",
      )!.id,
    ]);
    expect(reviewed.findings).toContainEqual(
      expect.objectContaining({
        summary: "Advisory regression",
        status: "open",
        disposition: "advisory",
      }),
    );
  });

  it("retains the exact anchored finding set and correction delta", () => {
    const review: ReviewState = {
      candidateId: candidate.id,
      comparisonBase: "base",
      previousCandidateId: previousCandidate.id,
      round: 1,
      pendingCorrectionIds: ["finding-1"],
      latestCorrection: packet().latestCorrection,
      evidence: ["/orchestrator/review.json"],
      observations: [],
    };

    const result = buildSourceReviewWorkerPacket({
      state: state(),
      workstream,
      workspacePath,
      packet: packet(),
      review,
      actualChangedPaths: ["src/endpoint.ts"],
    });

    expect(result).toMatchObject({
      role: "reviewer",
      completionKind: "initial-anchored-review",
      mode: "anchored",
      identity: "run-1/work/candidate:work:tip",
      outstandingFindings: [{ id: "finding-1" }],
      latestCorrection: {
        changedPaths: ["src/endpoint.ts"],
        evidence: "Committed the correction.",
      },
    });
  });

  it("uses the no-subject completion contract for initial satisfaction review", () => {
    const satisfied = {
      ...candidate,
      id: "satisfied:work:base",
      commitSha: "base",
      treeSha: "base-tree",
    };
    const result = buildSourceReviewWorkerPacket({
      state: state(),
      workstream,
      workspacePath,
      packet: {
        ...packet(),
        candidate: satisfied,
        outstandingFindings: [],
      },
    });

    expect(result).toMatchObject({
      completionKind: "repository-state-review",
      mode: "initial",
    });
  });

  it("renders comparison identities without embedded diff content", () => {
    const initial = buildInitialWorkstreamReviewPrompt({
      ...packet(),
      role: "reviewer",
      completionKind: "initial-review",
      identity: "run-1/work/candidate:work:tip",
      workspace: { path: workspacePath, mutationBoundary: "read-only" },
      mode: "repository_state",
      repositoryState: {
        historicalBaseSha: "historical-base",
        assessedTargetSha: "assessed-current",
        priorReviewEvidence: [],
      },
    });
    const anchored = buildAnchoredWorkstreamReviewPrompt({
      ...packet(),
      role: "reviewer",
      completionKind: "anchored-review",
      identity: "run-1/work/candidate:work:tip",
      workspace: { path: workspacePath, mutationBoundary: "read-only" },
      mode: "anchored",
      previousCandidate,
      latestCorrection: packet().latestCorrection!,
    });

    expect(initial).toContain(
      "git diff --stat historical-base..assessed-current",
    );
    expect(initial).not.toContain("diff --git");
    expect(anchored).toContain("Comparison base: base");
    expect(anchored).toContain("base..tip");
    expect(anchored).not.toContain("diff --git");
  });

  it("keeps open whole-plan advisories pending during the Task-1 repair policy", () => {
    const baseline = applyInitialWorkstreamReview({
      workstream: { kind: "overall", repairId: "repair" },
      candidateId: previousCandidate.id,
      comparisonBase: previousCandidate.baseSha,
      completion: {
        findings: [
          {
            summary: "Blocking behavior",
            evidence: "The endpoint returns 404.",
            requiredChange: "Add the endpoint.",
            acceptanceCriteria: ["The endpoint returns 200."],
            disposition: "blocking",
          },
          {
            summary: "Representative coverage",
            evidence: "No integration coverage exists.",
            requiredChange: "Add representative coverage.",
            acceptanceCriteria: ["Coverage exercises the endpoint."],
            disposition: "advisory",
          },
        ],
      },
      evidence: "initial whole-plan review",
    });
    const reviewed = applyAnchoredWorkstreamReview({
      state: retargetAnchoredReview({
        state: baseline.review,
        candidateId: candidate.id,
        comparisonBase: "base",
        correction: {
          fromCandidateId: previousCandidate.id,
          changedPaths: ["src/endpoint.ts"],
          evidence: "repair",
        },
      }),
      workstream: { kind: "overall", repairId: "repair" },
      findings: baseline.findings,
      completion: {
        publicationCommitSubject: "fix: repair whole plan",
        assessments: [
          {
            id: baseline.findings[0]!.id,
            status: "resolved",
            evidence: "The endpoint returns 200.",
          },
          {
            id: baseline.findings[1]!.id,
            status: "unresolved",
            evidence: "Coverage remains absent.",
            disposition: "advisory",
            summary: "Representative coverage",
            requiredChange: "Add representative coverage.",
            acceptanceCriteria: ["Coverage exercises the endpoint."],
          },
        ],
        regressions: [],
      },
      evidence: "repair assessment",
      pendingPolicy: "all_open",
    });

    expect(reviewed.review.pendingCorrectionIds).toEqual([
      baseline.findings[1]!.id,
    ]);
  });

  it("records a subject on the first overall repair review", () => {
    const baseline = applyInitialWorkstreamReview({
      workstream: { kind: "overall", repairId: "repair" },
      candidateId: previousCandidate.id,
      comparisonBase: previousCandidate.baseSha,
      completion: {
        findings: [
          {
            summary: "Missing behavior",
            evidence: "The endpoint returns 404.",
            requiredChange: "Add the endpoint.",
            acceptanceCriteria: ["The endpoint returns 200."],
            disposition: "blocking",
          },
        ],
      },
      evidence: "initial whole-plan review",
    });
    const repair = retargetAnchoredReview({
      state: baseline.review,
      candidateId: candidate.id,
      comparisonBase: baseline.review.comparisonBase,
      correction: {
        fromCandidateId: previousCandidate.id,
        changedPaths: ["src/endpoint.ts"],
        evidence: "Committed the repair.",
      },
    });
    const reviewed = applyAnchoredWorkstreamReview({
      state: repair,
      workstream: { kind: "overall", repairId: "repair" },
      completion: {
        publicationCommitSubject: "fix: repair whole plan",
        assessments: [
          {
            id: baseline.findings[0]!.id,
            status: "unresolved",
            evidence: "The endpoint remains unavailable.",
            disposition: "blocking",
            summary: "Missing behavior",
            requiredChange: "Add the endpoint.",
            acceptanceCriteria: ["The endpoint returns 200."],
          },
        ],
        regressions: [],
      },
      findings: baseline.findings,
      evidence: "initial repair review",
    });

    expect(reviewed.review.publicationCommitSubject).toBe(
      "fix: repair whole plan",
    );
  });

  it("authors a publication subject on the first changed repository-state reassessment", () => {
    const initial = applyInitialWorkstreamReview({
      workstream,
      candidateId: previousCandidate.id,
      comparisonBase: previousCandidate.baseSha,
      completion: {
        findings: [
          {
            summary: "Missing behavior",
            evidence: "The endpoint returns 404.",
            requiredChange: "Add the endpoint.",
            acceptanceCriteria: ["The endpoint returns 200."],
            disposition: "blocking",
          },
        ],
      },
      evidence: "repository-state review",
    });
    const reviewed = applyAnchoredWorkstreamReview({
      state: retargetAnchoredReview({
        state: initial.review,
        candidateId: candidate.id,
        comparisonBase: "base",
        correction: {
          fromCandidateId: previousCandidate.id,
          changedPaths: ["src/endpoint.ts"],
          evidence: "correction",
        },
      }),
      workstream,
      findings: initial.findings,
      completion: {
        publicationCommitSubject: "fix: publish changed repository state",
        assessments: [
          {
            id: initial.findings[0]!.id,
            status: "resolved",
            evidence: "The endpoint returns 200.",
          },
        ],
        regressions: [],
      },
      evidence: "anchored review",
    });

    expect(reviewed.review).toMatchObject({
      pendingCorrectionIds: [],
      publicationCommitSubject: "fix: publish changed repository state",
    });
  });

  it("preserves the initial publication subject through a correction review", () => {
    const initial = applyInitialWorkstreamReview({
      workstream,
      candidateId: previousCandidate.id,
      comparisonBase: previousCandidate.baseSha,
      completion: {
        publicationCommitSubject: "feat: publish workstream",
        findings: [
          {
            summary: "Missing behavior",
            evidence: "The endpoint returns 404.",
            requiredChange: "Add the endpoint.",
            acceptanceCriteria: ["The endpoint returns 200."],
            disposition: "blocking",
          },
        ],
      },
      evidence: "initial review",
    });
    const retargeted = retargetAnchoredReview({
      state: initial.review,
      candidateId: candidate.id,
      comparisonBase: initial.review.comparisonBase,
      correction: {
        fromCandidateId: previousCandidate.id,
        changedPaths: ["src/endpoint.ts"],
        evidence: "Committed the correction.",
      },
    });
    const updated = applyAnchoredWorkstreamReview({
      state: retargeted,
      workstream,
      completion: {
        assessments: [
          {
            id: initial.findings[0]!.id,
            status: "resolved",
            evidence: "The endpoint returns 200.",
          },
        ],
        regressions: [],
      },
      findings: initial.findings,
      evidence: "anchored review",
    });

    expect(updated.review).toMatchObject({
      candidateId: candidate.id,
      pendingCorrectionIds: [],
      publicationCommitSubject: "feat: publish workstream",
    });
  });

  it("rejects an incomplete anchored review epoch before spawning", () => {
    expect(() =>
      buildSourceReviewWorkerPacket({
        state: state(),
        workstream,
        workspacePath,
        packet: packet(),
        review: {
          candidateId: candidate.id,
          comparisonBase: "base",
          previousCandidateId: previousCandidate.id,
          round: 1,
          pendingCorrectionIds: [],
          evidence: [],
          observations: [],
        },
      }),
    ).toThrow("Reviewer packet work does not match its anchored review epoch");
  });
});
