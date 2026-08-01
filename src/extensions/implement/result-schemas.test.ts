import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  anchoredWorkstreamReviewSchema,
  initialWorkstreamReviewSchema,
  repositoryStateReviewSchema,
} from "./result-schemas.js";

const finding = {
  summary: "Missing response",
  evidence: "The endpoint returns 404.",
  requiredChange: "Return the documented response.",
  acceptanceCriteria: ["The endpoint returns 200."],
  disposition: "blocking",
};

function validates(schema: object, value: unknown): boolean {
  return Boolean(new Ajv({ allErrors: true }).compile(schema)(value));
}

describe("review completion schemas", () => {
  it("accepts structured direct findings and empty findings without a verdict", () => {
    expect(
      validates(initialWorkstreamReviewSchema, {
        findings: [finding],
        publicationCommitSubject: "fix: return documented response",
      }),
    ).toBe(true);
    expect(validates(repositoryStateReviewSchema, { findings: [] })).toBe(true);
  });

  it("rejects verdicts, unknown fields, and missing direct dispositions", () => {
    expect(
      validates(initialWorkstreamReviewSchema, {
        findings: [finding],
        publicationCommitSubject: "fix: return documented response",
        verdict: "changes_requested",
      }),
    ).toBe(false);
    expect(
      validates(repositoryStateReviewSchema, {
        findings: [{ ...finding, disposition: undefined }],
      }),
    ).toBe(false);
  });

  it("requires complete resolved and unresolved assessment shapes", () => {
    expect(
      validates(anchoredWorkstreamReviewSchema, {
        assessments: [
          { id: "finding-1", status: "resolved", evidence: "Verified." },
          {
            id: "finding-2",
            status: "unresolved",
            evidence: "Coverage remains incomplete.",
            disposition: "advisory",
            summary: "Coverage gap",
            requiredChange: "Add representative coverage.",
            acceptanceCriteria: ["Coverage exercises the endpoint."],
          },
        ],
        regressions: [
          {
            ...finding,
            disposition: "advisory",
            changedPaths: ["src/endpoint.ts"],
          },
        ],
        observations: [{ summary: "Unrelated concern", evidence: "No delta." }],
      }),
    ).toBe(true);
    expect(
      validates(anchoredWorkstreamReviewSchema, {
        assessments: [
          { id: "finding-1", status: "unresolved", evidence: "Still present." },
        ],
        regressions: [],
      }),
    ).toBe(false);
  });
});
