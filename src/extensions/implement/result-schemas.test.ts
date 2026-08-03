import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  anchoredOverallReviewSchema,
  anchoredWorkstreamReviewSchema,
  initialAnchoredOverallReviewSchema,
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
};

function validates(schema: object, value: unknown): boolean {
  return Boolean(new Ajv().compile(schema)(value));
}

describe("review completion schemas", () => {
  it("accepts verdict-free findings and complete final assessments", () => {
    expect(
      validates(initialWorkstreamReviewSchema, {
        findings: [finding],
        publicationCommitSubject: "fix: return documented response",
      }),
    ).toBe(true);
    expect(validates(repositoryStateReviewSchema, { findings: [] })).toBe(true);
    expect(
      validates(initialOverallReviewSchema, {
        findings: [],
        handoffDraft: "## Delivered behavior\n\nReviewed delivery handoff.",
      }),
    ).toBe(true);
    expect(
      validates(initialAnchoredOverallReviewSchema, {
        assessments: [],
        regressions: [],
        publicationCommitSubject: "fix: repair complete plan",
        handoffDraft: "## Delivered behavior\n\nRepaired delivery handoff.",
      }),
    ).toBe(true);
    expect(
      validates(anchoredOverallReviewSchema, {
        assessments: [],
        regressions: [],
        handoffDraft: "## Delivered behavior\n\nReassessed delivery handoff.",
      }),
    ).toBe(true);
    expect(
      validates(anchoredWorkstreamReviewSchema, {
        assessments: [
          { id: "finding-1", status: "resolved", evidence: "Verified." },
          {
            id: "finding-2",
            status: "unresolved",
            evidence: "Coverage remains incomplete.",
            summary: "Coverage gap",
            requiredChange: "Add representative coverage.",
            acceptanceCriteria: ["Coverage exercises the endpoint."],
          },
        ],
        regressions: [{ ...finding, changedPaths: ["src/endpoint.ts"] }],
      }),
    ).toBe(true);
  });

  it("rejects verdicts, dispositions, and incomplete finding authority", () => {
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
        { findings: [{ ...finding, disposition: "blocking" }] },
      ],
      [
        initialWorkstreamReviewSchema,
        {
          findings: [],
          publicationCommitSubject: "fix: return documented response",
          handoffDraft: "Source review must not carry a handoff.",
        },
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
      [initialOverallReviewSchema, { findings: [], handoffDraft: "   " }],
      [
        initialAnchoredOverallReviewSchema,
        {
          assessments: [],
          regressions: [],
          publicationCommitSubject: "fix: repair complete plan",
          handoffDraft: "   ",
        },
      ],
      [
        anchoredOverallReviewSchema,
        { assessments: [], regressions: [], handoffDraft: "x".repeat(12_001) },
      ],
      [
        anchoredOverallReviewSchema,
        {
          assessments: [],
          regressions: [],
          handoffDraft: "Complete replacement.",
          disposition: "advisory",
        },
      ],
    ];

    for (const [schema, completion] of invalid) {
      expect(validates(schema, completion)).toBe(false);
    }
  });
});
