import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  executionManifestSchema,
  initialTaskReviewSchema,
  initialOverallReviewSchema,
  findingAdmissionBatchSchema,
  sourceMaterialRepairSchema,
  implementerResultSchema,
  overallReworkSchema,
} from "./result-schemas.js";

describe("managed completion schemas", () => {
  it("rejects incomplete execution-manifest tasks before normalization", () => {
    expect(
      Value.Check(executionManifestSchema, { version: 1, tasks: [{}] }),
    ).toBe(false);
  });

  it("rejects incomplete source-material repair references before mapping", () => {
    expect(
      Value.Check(sourceMaterialRepairSchema, {
        taskId: "task-1",
        sourceMaterialRefs: [{}],
        reason: "repair",
      }),
    ).toBe(false);
  });

  it("accepts typed initial reviews and rejects empty atomic finding fields", () => {
    const finding = {
      summary: "Missing validation",
      evidence: "src/api.ts accepts invalid input",
      requiredChange: "Validate the input",
      acceptanceCriteria: ["Invalid input is rejected"],
      basis: { kind: "requirement", requirementIds: ["T001-AC01"] },
    };
    expect(
      Value.Check(initialTaskReviewSchema, {
        verdict: "changes_requested",
        findings: [finding],
      }),
    ).toBe(true);
    expect(
      Value.Check(initialTaskReviewSchema, {
        verdict: "changes_requested",
        findings: [{ ...finding, acceptanceCriteria: [] }],
      }),
    ).toBe(false);
  });

  it("keeps initial task and overall review result boundaries exclusive", () => {
    const finding = {
      summary: "Missing validation",
      evidence: "src/api.ts accepts invalid input",
      requiredChange: "Validate the input",
      acceptanceCriteria: ["Invalid input is rejected"],
      basis: { kind: "requirement", requirementIds: ["T001-AC01"] },
    };
    expect(
      Value.Check(initialTaskReviewSchema, {
        verdict: "approved",
        findings: [finding],
      }),
    ).toBe(false);
    expect(
      Value.Check(initialTaskReviewSchema, {
        verdict: "changes_requested",
        findings: [finding],
        recommendationMarkdown: "Advice",
      }),
    ).toBe(false);
    expect(
      Value.Check(initialOverallReviewSchema, {
        verdict: "changes_requested",
        findings: [finding],
        recommendationMarkdown: "Advice",
      }),
    ).toBe(true);
  });

  it("requires proposal bases for initial overall and integration review findings", () => {
    const finding = {
      summary: "Missing validation",
      evidence: "src/api.ts accepts invalid input",
      requiredChange: "Validate the input",
      acceptanceCriteria: ["Invalid input is rejected"],
      basis: { kind: "requirement", requirementIds: ["T001-AC01"] },
    };
    expect(
      Value.Check(initialOverallReviewSchema, {
        verdict: "changes_requested",
        findings: [finding],
      }),
    ).toBe(true);
  });

  it("requires complete, certain-or-uncertain admission dispositions", () => {
    expect(
      Value.Check(findingAdmissionBatchSchema, {
        proposalBatchId: "batch",
        dispositions: [
          {
            proposalId: "P1",
            disposition: "admit",
            certainty: "certain",
            rationale: "The requirement is unmet.",
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(findingAdmissionBatchSchema, {
        proposalBatchId: "batch",
        dispositions: [{ proposalId: "P1", disposition: "admit" }],
      }),
    ).toBe(false);
  });

  it("requires structured per-finding rework completions when supplied", () => {
    const completion = {
      id: "R1",
      status: "addressed",
      evidence: "The input validator now rejects empty values.",
      changedPaths: ["src/input.ts"],
      verification: [
        {
          command: "npm test",
          result: "passed",
          rationale: "Covers invalid input.",
        },
      ],
    };
    expect(
      Value.Check(implementerResultSchema, {
        outcome: "changed",
        summary: "Added validation.",
        verification: completion.verification,
        findingCompletions: [completion],
        commitMessage: "fix: validate input",
      }),
    ).toBe(true);
    expect(
      Value.Check(overallReworkSchema, {
        summary: "Added validation.",
        verification: completion.verification,
        findingCompletions: [{ ...completion, status: "unknown" }],
      }),
    ).toBe(false);
  });

  it("keeps planner and material-selection schemas free of papercut fields", () => {
    expect("papercuts" in executionManifestSchema.properties).toBe(false);
    expect("papercuts" in sourceMaterialRepairSchema.anyOf[0].properties).toBe(
      false,
    );
    expect("papercuts" in sourceMaterialRepairSchema.anyOf[1].properties).toBe(
      false,
    );
  });
});
