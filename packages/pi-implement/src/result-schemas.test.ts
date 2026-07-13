import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  executionManifestSchema,
  implementerResultSchema,
  integrationReviewSchema,
  integrationSelfHealSchema,
  overallReviewSchema,
  overallReworkSchema,
  reviewerVerdictSchema,
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
      Value.Check(integrationReviewSchema, {
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
  });

  it("keeps planner and material-selection schemas free of papercut fields", () => {
    expect("papercuts" in executionManifestSchema.properties).toBe(false);
    expect("papercuts" in sourceMaterialRepairSchema.anyOf[0].properties).toBe(
      false,
    );
  });
});
