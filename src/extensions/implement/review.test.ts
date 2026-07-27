import { describe, expect, it } from "vitest";
import {
  buildSourceReviewWorkerPacket,
  type ReviewPacket,
  type ReviewState,
} from "./review.js";
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
    sourceMaterial: [{ path: "/checkout/plan.md", content: "# Plan" }],
    checkpoints: {},
    satisfiedEvidence: {},
    outstandingFindings: [
      {
        id: "finding-1",
        candidateId: previousCandidate.id,
        workstream,
        summary: "Missing behavior",
        evidence: "The endpoint returns 404.",
        requiredChange: "Add the endpoint.",
        acceptanceCriteria: ["The endpoint returns 200."],
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
    baseToTipDiff: "diff --git a/src/endpoint.ts b/src/endpoint.ts",
  };
}

describe("source review worker packets", () => {
  it("retains the exact anchored finding set and correction delta", () => {
    const review: ReviewState = {
      candidateId: candidate.id,
      previousCandidateId: previousCandidate.id,
      round: 1,
      outstandingIds: ["finding-1"],
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
      completionKind: "anchored-review",
      mode: "anchored",
      identity: "run-1/work/candidate:work:tip",
      outstandingFindings: [{ id: "finding-1" }],
      latestCorrection: {
        changedPaths: ["src/endpoint.ts"],
        evidence: "Committed the correction.",
      },
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
          previousCandidateId: previousCandidate.id,
          round: 1,
          outstandingIds: [],
          evidence: [],
          observations: [],
        },
      }),
    ).toThrow("Reviewer packet work does not match its anchored review epoch");
  });
});
