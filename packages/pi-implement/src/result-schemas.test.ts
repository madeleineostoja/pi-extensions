import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  executionManifestSchema,
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
});
