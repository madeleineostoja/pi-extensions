import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  executionManifestSchema,
  implementerResultSchema,
  integrationInitialReviewSchema,
  integrationSelfHealSchema,
  overallReviewSchema,
  overallReworkSchema,
  reviewerVerdictSchema,
  initialTaskReviewSchema,
  initialOverallReviewSchema,
  schedulerSelfHealSchema,
  sourceMaterialRepairSchema,
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

  it("accepts loose papercut arrays for every eligible result role", () => {
    const candidates = [{ malformed: true }];
    expect(
      Value.Check(implementerResultSchema, {
        outcome: "changed",
        summary: "done",
        verification: [{ command: "test", result: "passed", rationale: "ok" }],
        commitMessage: "feat: done",
        papercuts: candidates,
      }),
    ).toBe(true);
    expect(
      Value.Check(reviewerVerdictSchema, {
        verdict: "approved",
        papercuts: candidates,
      }),
    ).toBe(true);
    expect(
      Value.Check(integrationInitialReviewSchema, {
        verdict: "approved",
        papercuts: candidates,
      }),
    ).toBe(true);
    expect(
      Value.Check(integrationSelfHealSchema, {
        repaired: false,
        retryIntegration: false,
        papercuts: candidates,
      }),
    ).toBe(true);
    expect(
      Value.Check(schedulerSelfHealSchema, {
        repaired: false,
        retryScheduler: false,
        papercuts: candidates,
      }),
    ).toBe(true);
    expect(
      Value.Check(overallReviewSchema, {
        verdict: "approved",
        papercuts: candidates,
      }),
    ).toBe(true);
    expect(
      Value.Check(overallReworkSchema, {
        summary: "done",
        verification: [{ command: "test", result: "passed", rationale: "ok" }],
        papercuts: candidates,
      }),
    ).toBe(true);
    const papercuts = implementerResultSchema.anyOf[0].properties
      .papercuts as unknown as { description?: string };
    expect(papercuts.description).toContain("suggestedDestination");
    expect(papercuts.description).toContain(
      "Malformed candidates are discarded",
    );
  });

  it("accepts typed initial reviews and rejects empty atomic finding fields", () => {
    const finding = {
      summary: "Missing validation",
      evidence: "src/api.ts accepts invalid input",
      requiredChange: "Validate the input",
      acceptanceCriteria: ["Invalid input is rejected"],
    };
    expect(
      Value.Check(reviewerVerdictSchema, {
        verdict: "changes_requested",
        findings: [finding],
      }),
    ).toBe(false);
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
