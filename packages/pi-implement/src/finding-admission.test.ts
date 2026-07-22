import { describe, expect, it } from "vitest";
import {
  createProposalBatchId,
  evaluateFindingAdmission,
} from "./finding-admission.js";

const proposal = (proposalId: string, requirementIds = ["T001-AC01"]) => ({
  proposalId,
  summary: `summary ${proposalId}`,
  evidence: `evidence ${proposalId}`,
  requiredChange: `change ${proposalId}`,
  acceptanceCriteria: [`criterion ${proposalId}`],
  basis: { kind: "requirement" as const, requirementIds },
});

const batchId = "batch";

describe("finding admission", () => {
  it("keeps only admitted proposals out of convergence while retaining other dispositions", () => {
    const result = evaluateFindingAdmission({
      scope: "task",
      proposalBatchId: batchId,
      proposals: [
        proposal("P1"),
        proposal("P2"),
        proposal("P3"),
        proposal("P4"),
      ],
      knownRequirementIds: ["T001-AC01"],
      adjudication: {
        proposalBatchId: batchId,
        dispositions: [
          {
            proposalId: "P1",
            disposition: "admit",
            certainty: "certain",
            rationale: "blocking",
          },
          {
            proposalId: "P2",
            disposition: "defer",
            certainty: "certain",
            rationale: "whole feature",
          },
          {
            proposalId: "P3",
            disposition: "demote",
            certainty: "certain",
            rationale: "non-blocking",
          },
          {
            proposalId: "P4",
            disposition: "reject",
            certainty: "certain",
            rationale: "unsupported",
          },
        ],
      },
    });
    expect(result.admittedDrafts.map((item) => item.proposalId)).toEqual([
      "P1",
    ]);
    expect(result.deferredConcerns.map((item) => item.proposalId)).toEqual([
      "P2",
    ]);
    expect(result.observations).toEqual([
      { summary: "summary P3", evidence: "evidence P3" },
    ]);
    expect(result.rejected.map((item) => item.proposalId)).toEqual(["P4"]);
  });

  it("fails safe for stale, unknown, partial, uncertain, and unknown-requirement adjudication", () => {
    const proposals = [proposal("P1"), proposal("P2", ["unknown"])];
    for (const adjudication of [
      undefined,
      { proposalBatchId: "stale", dispositions: [] },
      {
        proposalBatchId: batchId,
        dispositions: [
          {
            proposalId: "P3",
            disposition: "reject" as const,
            certainty: "certain" as const,
            rationale: "unknown",
          },
        ],
      },
      {
        proposalBatchId: batchId,
        dispositions: [
          {
            proposalId: "P1",
            disposition: "reject" as const,
            certainty: "uncertain" as const,
            rationale: "uncertain",
          },
          {
            proposalId: "P2",
            disposition: "reject" as const,
            certainty: "certain" as const,
            rationale: "unknown requirement",
          },
        ],
      },
    ]) {
      const result = evaluateFindingAdmission({
        scope: "task",
        proposalBatchId: batchId,
        proposals,
        knownRequirementIds: ["T001-AC01"],
        adjudication,
      });
      expect(result.admittedDrafts.length).toBeGreaterThan(0);
    }
  });

  it("turns overall deferrals into admitted blockers", () => {
    const result = evaluateFindingAdmission({
      scope: "overall",
      proposalBatchId: batchId,
      proposals: [proposal("P1")],
      knownRequirementIds: ["T001-AC01"],
      adjudication: {
        proposalBatchId: batchId,
        dispositions: [
          {
            proposalId: "P1",
            disposition: "defer",
            certainty: "certain",
            rationale: "needs whole feature review",
          },
        ],
      },
    });
    expect(result.admittedDrafts.map((draft) => draft.proposalId)).toEqual([
      "P1",
    ]);
    expect(result.deferredConcerns).toEqual([]);
  });

  it("binds the batch to scope, candidate, context, delta, and normalized proposals", () => {
    const base = {
      scope: "task" as const,
      contextId: "context",
      candidateIdentity: "candidate-a",
      latestDeltaPaths: ["src/a.ts"],
      proposals: [proposal("P1")],
    };
    expect(createProposalBatchId(base)).not.toBe(
      createProposalBatchId({ ...base, candidateIdentity: "candidate-b" }),
    );
  });
});
