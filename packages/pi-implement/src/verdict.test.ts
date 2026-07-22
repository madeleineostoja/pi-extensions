import { describe, expect, it } from "vitest";
import {
  parseImplementerResult,
  parseAnchoredReviewResult,
  parseInitialReviewResult,
  parseAdmissionResult,
  parseIntegrationSelfHealResult,
  parseOverallReworkResult,
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

  it("validates atomic initial findings and anchored coverage semantically", () => {
    const finding = {
      summary: "Missing validation",
      evidence: "src/api.ts accepts invalid input",
      requiredChange: "Validate the input",
      acceptanceCriteria: ["Invalid input is rejected"],
      basis: { kind: "requirement", requirementIds: ["T001-AC01"] },
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

  it("requires exact finding coverage for task and overall rework", () => {
    const completion = {
      id: "R1",
      status: "addressed",
      evidence: "validator rejects empty input",
      changedPaths: ["src/input.ts"],
      verification: [
        { command: "npm test", result: "passed", rationale: "covers input" },
      ],
    };
    expect(
      parseImplementerResult(
        {
          outcome: "changed",
          summary: "Added validation.",
          verification: completion.verification,
          findingCompletions: [completion],
          commitMessage: "fix: validate input",
        },
        { expectedFindingIds: ["R1"] },
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseImplementerResult(
        {
          outcome: "changed",
          summary: "Added validation.",
          verification: completion.verification,
          findingCompletions: [completion, completion],
          commitMessage: "fix: validate input",
        },
        { expectedFindingIds: ["R1"] },
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("more than once"),
    });
    expect(
      parseOverallReworkResult(
        { summary: "Fixed it.", verification: completion.verification },
        { expectedFindingIds: ["O1"] },
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("findingCompletions"),
    });
    expect(
      parseImplementerResult(
        {
          outcome: "changed",
          summary: "Verified existing behavior.",
          verification: completion.verification,
          findingCompletions: [
            { ...completion, changedPaths: [], evidence: "It is fixed." },
          ],
          commitMessage: "fix: validate input",
        },
        { expectedFindingIds: ["R1"] },
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no source change"),
    });
  });

  it("normalizes proposal IDs and parses explicit admission certainty", () => {
    const result = parseInitialReviewResult(
      {
        verdict: "changes_requested",
        findings: [
          {
            summary: "Missing validation",
            evidence: "input is accepted",
            requiredChange: "validate input",
            acceptanceCriteria: ["input is rejected"],
            basis: {
              kind: "correctness_invariant",
              invariant: "untrusted input must be validated",
            },
          },
          {
            proposalId: "P1",
            summary: "Missing error response",
            evidence: "errors escape",
            requiredChange: "handle errors",
            acceptanceCriteria: ["errors are handled"],
            basis: { kind: "requirement", requirementIds: ["T001-AC01"] },
          },
        ],
      },
      { requireProposalBasis: true },
    );
    expect(result).toMatchObject({
      ok: true,
      result: { findings: [{ proposalId: "P1" }, { proposalId: "P2" }] },
    });
    expect(
      parseInitialReviewResult(
        {
          verdict: "changes_requested",
          findings: [
            {
              proposalId: "P2",
              summary: "first",
              evidence: "evidence",
              requiredChange: "change",
              acceptanceCriteria: ["criterion"],
              basis: { kind: "correctness_invariant", invariant: "safe" },
            },
            {
              proposalId: "P2",
              summary: "second",
              evidence: "evidence",
              requiredChange: "change",
              acceptanceCriteria: ["criterion"],
              basis: { kind: "correctness_invariant", invariant: "safe" },
            },
          ],
        },
        { requireProposalBasis: true },
      ),
    ).toMatchObject({
      ok: true,
      result: { findings: [{ proposalId: "P2" }, { proposalId: "P3" }] },
    });
    expect(
      parseAdmissionResult({
        proposalBatchId: "batch",
        dispositions: [
          {
            proposalId: "P1",
            disposition: "admit",
            certainty: "uncertain",
            rationale: "Need more evidence",
          },
        ],
      }),
    ).toMatchObject({ ok: true, result: { proposalBatchId: "batch" } });
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
