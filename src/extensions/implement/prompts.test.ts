import { describe, expect, it } from "vitest";
import {
  buildAnchoredOverallReviewPrompt,
  buildInitialOverallReviewPrompt,
  buildOverallReworkPrompt,
} from "./prompts.js";
import type { OverallRepairPacket } from "./overall-repair.js";

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
      plan: { version: 1 },
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
});
