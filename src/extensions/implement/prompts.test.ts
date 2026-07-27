import { describe, expect, it } from "vitest";
import type { ExecutionPlan } from "./execution-plan.js";
import {
  buildInitialWorkstreamReviewPrompt,
  buildWorkstreamImplementerPrompt,
} from "./prompts.js";
import type { InitialSourceReviewPacket } from "./review.js";
import type { WorkstreamPacket } from "./workstream-candidate.js";

const task: ExecutionPlan["tasks"][number] = {
  id: "contract",
  planIndex: 1,
  title: "Implement the contract",
  dependsOn: [],
  provenance: [{ path: "plan.md", quote: "Implement the contract" }],
  compiledContract: {
    objective: "Implement the contract.",
    inScope: ["The contract"],
    acceptanceCriteria: ["The contract works."],
    outOfScope: ["Unrelated work"],
  },
  taskHash: "task-hash",
  sourceAnchor: {
    path: "plan.md",
    lineNumber: 1,
    lineText: "- [ ] Implement the contract",
    normalizedLineHash: "line-hash",
    blockHash: "block-hash",
  },
};

const implementerPacket: WorkstreamPacket = {
  role: "implementer",
  completionKind: "implementer",
  identity: "run-1/work",
  workspace: {
    path: "/worktree",
    mutationBoundary: "Commit tracked changes only in this worktree.",
  },
  workstreamId: "work",
  baseSha: "base",
  tasks: [task],
  priorCheckpoints: {},
  recoveryObligations: [],
  sourceMaterial: [],
};

const reviewPacket: InitialSourceReviewPacket = {
  role: "reviewer",
  completionKind: "initial-review",
  identity: "run-1/work/candidate",
  workspace: {
    path: "/worktree",
    mutationBoundary: "Do not mutate this worktree.",
  },
  mode: "initial",
  workstream: { kind: "source", id: "work" },
  candidate: {
    id: "candidate:work:tip",
    workstream: { kind: "source", id: "work" },
    baseSha: "base",
    commitSha: "tip",
    treeSha: "tree",
  },
  contracts: [task],
  sourceMaterial: [],
  checkpoints: { contract: "tip" },
  satisfiedEvidence: {},
  outstandingFindings: [],
  baseToTipDiff: "diff --git a/file b/file",
};

describe("source worker prompts", () => {
  it("allows coherent cumulative checkpoints without administrative commits", () => {
    const prompt = buildWorkstreamImplementerPrompt(implementerPacket);

    expect(prompt).toContain("Prefer a checkpoint after a task only when");
    expect(prompt).toContain("tightly coupled tasks may share one checkpoint");
    expect(prompt).toContain("never manufacture administrative commits");
    expect(prompt).toContain("remain coherent and safe to publish");
    expect(prompt).toContain("several tasks may use the same cumulative SHA");
  });

  it("directs initial review through ordered contracts before cumulative assessment", () => {
    const prompt = buildInitialWorkstreamReviewPrompt(reviewPacket);

    expect(prompt).toContain("Review in two passes within this one invocation");
    expect(prompt).toContain(
      "first assess every ordered contract and acceptance criterion",
    );
    expect(prompt).toContain(
      "then assess cumulative interactions, regressions",
    );
    expect(prompt).toContain("do not require a task manifest");
  });
});
