import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  anchoredWorkstreamReviewSchema,
  initialAnchoredWorkstreamReviewSchema,
  initialOverallReviewSchema,
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
  return Boolean(new Ajv().compile(schema)(value));
}

describe("review completion schemas", () => {
  it("accepts direct findings, empty findings, and complete assessments without verdicts", () => {
    expect(
      validates(initialWorkstreamReviewSchema, {
        findings: [finding],
        publicationCommitSubject: "fix: return documented response",
      }),
    ).toBe(true);
    expect(validates(repositoryStateReviewSchema, { findings: [] })).toBe(true);
    expect(validates(initialOverallReviewSchema, { findings: [] })).toBe(true);
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
      }),
    ).toBe(true);
  });

  it("rejects verdicts and incomplete finding authority", () => {
    const invalid: Array<[object, unknown]> = [
      [
        initialWorkstreamReviewSchema,
        {
          findings: [finding],
          publicationCommitSubject: "fix: return documented response",
          verdict: "changes_requested",
        },
      ],
      [
        repositoryStateReviewSchema,
        { findings: [{ ...finding, disposition: undefined }] },
      ],
      [
        anchoredWorkstreamReviewSchema,
        {
          assessments: [
            {
              id: "finding-1",
              status: "unresolved",
              evidence: "Still present.",
            },
          ],
          regressions: [],
        },
      ],
      [
        anchoredWorkstreamReviewSchema,
        {
          assessments: [
            {
              id: "finding-1",
              status: "resolved",
              evidence: "Verified.",
              disposition: "advisory",
            },
          ],
          regressions: [],
        },
      ],
      [
        initialAnchoredWorkstreamReviewSchema,
        { assessments: [], regressions: [] },
      ],
    ];

    for (const [schema, completion] of invalid) {
      expect(validates(schema, completion)).toBe(false);
    }
  });
});
