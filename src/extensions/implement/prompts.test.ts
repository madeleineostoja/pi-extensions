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
import { REPOSITORY_PRESERVING_ROLE_CONTRACT } from "./worker-invocation.js";
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
      latestHandoffDraft: "Prior handoff.",
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
    expect(anchored).toContain("Latest handoff draft");
    expect(anchored).toContain("Preserve unaffected facts");
    for (const prompt of [initial, anchored]) {
      expect(prompt).toContain("handoff transfers the entire Implement run");
      expect(prompt).toContain("cumulative verification evidence");
      expect(prompt).toContain(
        "do not add a gap solely because this read-only reviewer did not rerun an already evidenced check",
      );
      expect(prompt).toContain("orchestrator-enforced preconditions");
      expect(prompt).toContain(
        "report such a finding only when the candidate context explicitly reports an integrity failure",
      );
    }
    expect(repair).toContain("run-base..current-repair");
    for (const prompt of [initial, anchored]) {
      expect(prompt).not.toContain("Do not edit files, change Git state");
    }
    expect(REPOSITORY_PRESERVING_ROLE_CONTRACT).toContain(
      "inspect and verify only",
    );
  });

  it("requires reviewer-owned reassessment and first changed-candidate metadata", () => {
    const packet: Parameters<typeof buildAnchoredWorkstreamReviewPrompt>[0] = {
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
        rangeBaseSha: "previous-sha",
        rangeHeadSha: "candidate-sha",
        changedPaths: ["src/endpoint.ts"],
        evidence: "correction",
        mode: "changed",
      },
      contracts: [],
      sourceMaterial: [],
      corpus: [],
      schedule: { tasks: [], workstreams: [] },
      checkpoints: {},
      satisfiedEvidence: {},
      outstandingFindings: [],
    };
    const prompt = buildAnchoredWorkstreamReviewPrompt(packet);
    const unchangedPrompt = buildAnchoredWorkstreamReviewPrompt({
      ...packet,
      candidate: {
        ...packet.previousCandidate,
        id: "unchanged",
      },
      latestCorrection: {
        ...packet.latestCorrection,
        rangeHeadSha: "previous-sha",
        changedPaths: [],
        mode: "unchanged",
      },
    });

    expect(prompt).toContain("Author one concise Conventional Commit subject");
    expect(prompt).toContain("Correction mode: changed");
    expect(prompt).toContain("Correction range: previous-sha..candidate-sha");
    expect(prompt).toContain("git diff --stat base..candidate-sha");
    expect(prompt).not.toContain("git diff --stat previous-sha..candidate-sha");
    expect(unchangedPrompt).toContain(
      "Correction range: previous-sha..previous-sha",
    );
    expect(unchangedPrompt).toContain("git diff --stat base..previous-sha");
    expect(prompt).toContain(
      "final source review: no further source correction follows",
    );
    expect(prompt).toContain("Only this reviewer completion may resolve");
    expect(prompt).toContain("Assess every outstanding ID exactly once");
    expect(prompt).toContain("direct causal regressions only");
    expect(prompt).not.toMatch(/blocking|advisory|disposition/);
  });

  it("requires initial reviewers to report only material findings for one correction opportunity", () => {
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
      expect(prompt).toContain("direct material findings");
      expect(prompt).toContain("one initial");
      expect(prompt).toContain("do not return an approval verdict");
      expect(prompt).toContain("Exclude style nits, speculative improvements");
      expect(prompt).not.toMatch(/blocking|advisory|disposition/);
    }
    expect(source).toContain("publication metadata, not approval");
    expect(overall).toContain("Finalize the complete findings array");
    expect(overall).toContain(
      "concise, proportionate replacement Markdown handoff draft",
    );
    expect(overall).not.toMatch(/\b\d+[–-]\d+ words/);
    expect(overall).toContain(
      "Summary; Material changes; Verification; Residual findings",
    );
    expect(overall).toContain("do not impose an item count");
    expect(overall).toContain(
      "A verification gap is not itself a residual finding",
    );
    expect(overall).not.toContain("Continuation context");
  });

  it("limits revision completion to observed changed or unchanged evidence", () => {
    const prompt = buildRevisionPrompt({
      workspace: { path: "/worktree", mutationBoundary: "owned" },
      candidate: { id: "candidate", commitSha: "candidate-sha" },
      comparisonBase: "candidate-sha",
      findingEpoch: 1,
      pendingCorrectionIds: ["finding-1"],
      authority: { kind: "review_findings" },
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
