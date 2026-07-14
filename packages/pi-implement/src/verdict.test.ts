import { describe, expect, it } from "vitest";
import {
  parseImplementerResult,
  parseAnchoredReviewResult,
  parseInitialReviewResult,
  parseIntegrationSelfHealResult,
  parseOverallReviewVerdict,
  parseReviewerVerdict,
} from "./verdict.js";

describe("typed result validators", () => {
  it("accepts a typed changed implementer result", () => {
    expect(
      parseImplementerResult({
        outcome: "changed",
        summary: "Updated worker transport.",
        verification: [
          {
            command: "npm test",
            result: "passed",
            rationale: "Covers the changed behavior.",
          },
        ],
        commitMessage: "fix: preserve typed results",
      }),
    ).toMatchObject({ ok: true, result: { outcome: "changed" } });
  });

  it("rejects implementer results without verification or a commit message", () => {
    expect(
      parseImplementerResult({
        outcome: "changed",
        summary: "Updated worker transport.",
        verification: [],
      }),
    ).toEqual({
      ok: false,
      reason: "Implementer JSON must include a non-empty verification array.",
    });
  });

  it("rejects invalid commit messages at the semantic boundary", () => {
    expect(
      parseImplementerResult({
        outcome: "changed",
        summary: "Updated worker transport.",
        verification: [
          { command: "npm test", result: "passed", rationale: "covered" },
        ],
        commitMessage: "not conventional",
      }),
    ).toMatchObject({ ok: true });
  });

  it("handles reviewer and overall-review semantic fallbacks", () => {
    expect(parseReviewerVerdict({ verdict: "approved" })).toEqual({
      verdict: "approved",
    });
    expect(
      parseReviewerVerdict({
        verdict: "changes_requested",
        requiredChanges: [],
      }),
    ).toEqual({
      verdict: "error",
      reason: "Reviewer requested changes but did not provide requiredChanges.",
    });
    expect(parseOverallReviewVerdict({ verdict: "changes_requested" })).toEqual(
      {
        verdict: "changes_requested",
        requiredChanges: [
          "Overall review requested changes but did not provide requiredChanges.",
        ],
      },
    );
  });

  it("validates atomic initial findings and anchored coverage semantically", () => {
    const finding = {
      summary: "Missing validation",
      evidence: "src/api.ts accepts invalid input",
      requiredChange: "Validate the input",
      acceptanceCriteria: ["Invalid input is rejected"],
    };
    expect(
      parseInitialReviewResult({
        verdict: "changes_requested",
        findings: [finding],
      }),
    ).toMatchObject({ ok: true, result: { verdict: "changes_requested" } });
    expect(
      parseInitialReviewResult({
        verdict: "changes_requested",
        findings: [{ ...finding, acceptanceCriteria: [] }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseInitialReviewResult({ verdict: "approved", findings: [finding] }),
    ).toMatchObject({ ok: false });
    expect(
      parseInitialReviewResult({
        verdict: "changes_requested",
        findings: [finding],
        recommendationMarkdown: "Advice",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("overall") });
    expect(
      parseInitialReviewResult(
        {
          verdict: "changes_requested",
          findings: [finding],
          recommendationMarkdown: "Advice",
        },
        { allowRecommendationMarkdown: true },
      ),
    ).toMatchObject({ ok: true, result: { recommendationMarkdown: "Advice" } });
    expect(
      parseAnchoredReviewResult(
        {
          assessments: [
            { id: "R1", status: "resolved", evidence: "fixed" },
            { id: "R1", status: "resolved", evidence: "duplicate" },
          ],
          regressions: [],
        },
        ["R1", "R2"],
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("more than once"),
    });
    expect(
      parseAnchoredReviewResult(
        {
          assessments: [{ id: "R3", status: "resolved", evidence: "unknown" }],
          regressions: [],
        },
        ["R1"],
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("unknown") });
  });

  it("rejects unsafe retry decisions without a retry mode", () => {
    expect(
      parseIntegrationSelfHealResult({
        repaired: true,
        retryIntegration: true,
      }),
    ).toEqual({
      ok: false,
      reason:
        "Self-heal result missing retryMode when retryIntegration is true.",
    });
  });
});
