import { describe, expect, it } from "vitest";
import {
  parseImplementerResult,
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
