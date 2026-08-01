import { describe, expect, it } from "vitest";
import {
  buildAnchoredOverallReviewPrompt,
  buildAnchoredWorkstreamReviewPrompt,
  buildInitialWorkstreamReviewPrompt,
  buildInitialOverallReviewPrompt,
  buildOverallReworkPrompt,
  buildRevisionPrompt,
} from "./prompts.js";
import type { OverallRepairPacket } from "./overall-repair.js";
import type { RevisionPacket } from "./revision.js";

describe("whole-plan and repair prompts", () => {
  it("uses immutable comparison identities instead of embedded diffs", () => {
    const initial = buildInitialOverallReviewPrompt({
      planContext: "plan material",
      candidateContext: "candidate material",
      baseSha: "run-base",
      currentSha: "published-current",
    });
    const anchored = buildAnchoredOverallReviewPrompt({
      planContext: "plan material",
      candidateContext: "candidate material",
      baseSha: "run-base",
      previousCandidate: "previous-repair",
      currentCandidate: "current-repair",
      outstandingFindings: [],
    });
    const repair = buildOverallReworkPrompt({
      role: "implementer",
      completionKind: "overall-rework",
      identity: "run-1/repair/baseline",
      workspace: { path: "/worktree", mutationBoundary: "owned" },
      runId: "run-1",
      runBaseSha: "run-base",
      baseline: {
        id: "baseline",
        workstream: { kind: "overall", repairId: "repair" },
        baseSha: "published-baseline",
        commitSha: "current-repair",
        treeSha: "current-tree",
      },
      requirements: {
        contracts: [],
        corpus: [],
        schedule: { tasks: [], workstreams: [] },
      },
      findings: [],
    } as unknown as OverallRepairPacket);

    for (const prompt of [initial, anchored, repair]) {
      expect(prompt).not.toContain("diff --git");
      expect(prompt).toContain("git diff --stat");
      expect(prompt).toContain("git diff --name-status");
    }
    expect(initial).toContain("run-base..published-current");
    expect(anchored).toContain("Comparison base SHA: run-base");
    expect(anchored).toContain("run-base..current-repair");
    expect(repair).toContain("run-base..current-repair");
  });

  it("requires reviewer-owned publication disposition and first changed-candidate metadata", () => {
    const prompt = buildAnchoredWorkstreamReviewPrompt({
      role: "reviewer",
      completionKind: "initial-anchored-review",
      mode: "anchored",
      identity: "run-1/work/candidate",
      workspace: { path: "/worktree", mutationBoundary: "read-only" },
      workstream: { kind: "source", id: "work" },
      candidate: {
        id: "candidate",
        workstream: { kind: "source", id: "work" },
        baseSha: "base",
        commitSha: "candidate-sha",
        treeSha: "candidate-tree",
      },
      previousCandidate: {
        id: "previous",
        workstream: { kind: "source", id: "work" },
        baseSha: "base",
        commitSha: "previous-sha",
        treeSha: "previous-tree",
      },
      comparisonBase: "base",
      findingEpoch: 1,
      latestCorrection: {
        fromCandidateId: "previous",
        changedPaths: ["src/endpoint.ts"],
        evidence: "correction",
      },
      contracts: [],
      sourceMaterial: [],
      corpus: [],
      schedule: { tasks: [], workstreams: [] },
      checkpoints: {},
      satisfiedEvidence: {},
      outstandingFindings: [],
    });

    expect(prompt).toContain("Author one concise Conventional Commit subject");
    expect(prompt).toContain("whether assessments leave blockers, advisories");
    expect(prompt).toContain("Only this reviewer completion may resolve");
    expect(prompt).toContain("publication counterfactual");
    expect(prompt).toContain("material shippable improvements as advisory");
  });

  it("requires initial reviewers to classify only material findings for one correction opportunity", () => {
    const source = buildInitialWorkstreamReviewPrompt({
      role: "reviewer",
      completionKind: "initial-review",
      mode: "initial",
      identity: "run-1/source/work",
      workspace: { path: "/worktree", mutationBoundary: "read-only" },
      workstream: { kind: "source", id: "work" },
      candidate: {
        id: "candidate",
        workstream: { kind: "source", id: "work" },
        baseSha: "base",
        commitSha: "tip",
        treeSha: "tree",
      },
      contracts: [],
      sourceMaterial: [],
      corpus: [],
      schedule: { tasks: [], workstreams: [] },
      checkpoints: {},
      satisfiedEvidence: {},
      outstandingFindings: [],
    });
    const overall = buildInitialOverallReviewPrompt({
      planContext: "plan",
      candidateContext: "candidate",
      baseSha: "base",
      currentSha: "tip",
    });

    for (const prompt of [source, overall]) {
      expect(prompt).toContain("Classify each finding");
      expect(prompt).toContain("blocking");
      expect(prompt).toContain("advisory");
      expect(prompt).toContain("minimum observable correction");
      expect(prompt).toContain("acceptance criteria");
      expect(prompt).toContain("Exclude style nits, speculative improvements");
    }
    expect(source).toContain("publication metadata, not approval");
    expect(source).toContain(
      "provide it whether you approve or request changes",
    );
  });

  it("limits revision completion to observed changed or unchanged evidence", () => {
    const prompt = buildRevisionPrompt({
      workspace: { path: "/worktree", mutationBoundary: "owned" },
      candidate: { id: "candidate", commitSha: "candidate-sha" },
      comparisonBase: "candidate-sha",
      findingEpoch: 1,
      pendingCorrectionIds: ["finding-1"],
      findings: [
        {
          id: "finding-1",
          summary: "missing behavior",
          evidence: "current output",
          requiredChange: "add behavior",
          acceptanceCriteria: ["behavior is present"],
        },
      ],
      evidence: [],
      requirements: {
        contracts: [],
        corpus: [],
        schedule: { tasks: [], workstreams: [] },
      },
    } as unknown as RevisionPacket);

    expect(prompt).toContain("outcome `changed`");
    expect(prompt).toContain("outcome `unchanged`");
    expect(prompt).not.toContain("outcome `blocked`");
    expect(prompt).not.toContain("semantic blockage");
  });
});
