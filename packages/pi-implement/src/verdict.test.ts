import { describe, expect, it } from "vitest";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseImplementerResult,
  parseIntegrationSelfHealResult,
  parseOverallReviewVerdict,
  parseReviewerVerdict,
} from "./verdict.js";

describe("parseImplementerResult", () => {
  it("extracts structured JSON result (legacy, no outcome)", () => {
    const result = parseImplementerResult(`extra prose

<pi-implement-result>
{
  "summary": "changed files",
  "verification": [
    {
      "command": "npm test",
      "result": "passed",
      "rationale": "covers the changed behavior"
    }
  ],
  "commitMessage": "feat: add thing\\n\\nExplain the body."
}
</pi-implement-result>
`);
    expect(result).toEqual({
      ok: true,
      result: {
        outcome: "changed",
        summary: "changed files",
        verification: [
          {
            command: "npm test",
            result: "passed",
            rationale: "covers the changed behavior",
          },
        ],
        commitMessage: "feat: add thing\n\nExplain the body.",
      },
    });
  });

  it("parses outcome: changed explicitly", () => {
    const result = parseImplementerResult(
      '<pi-implement-result>{"outcome":"changed","summary":"did stuff","verification":[{"command":"npm test","result":"passed","rationale":"covers it"}],"commitMessage":"feat: do stuff"}</pi-implement-result>',
    );
    expect(result).toEqual({
      ok: true,
      result: {
        outcome: "changed",
        summary: "did stuff",
        verification: [
          { command: "npm test", result: "passed", rationale: "covers it" },
        ],
        commitMessage: "feat: do stuff",
      },
    });
  });

  it("parses outcome: already_satisfied with optional commitMessage", () => {
    const result = parseImplementerResult(
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}]}</pi-implement-result>',
    );
    expect(result).toEqual({
      ok: true,
      result: {
        outcome: "already_satisfied",
        summary: "already done",
        verification: [
          {
            command: "npm test",
            result: "passed",
            rationale: "task already satisfied",
          },
        ],
        commitMessage: undefined,
      },
    });
  });

  it("parses outcome: already_satisfied with commitMessage present", () => {
    const result = parseImplementerResult(
      '<pi-implement-result>{"outcome":"already_satisfied","summary":"already done","verification":[{"command":"npm test","result":"passed","rationale":"task already satisfied"}],"commitMessage":"feat: already done"}</pi-implement-result>',
    );
    expect(result).toEqual({
      ok: true,
      result: {
        outcome: "already_satisfied",
        summary: "already done",
        verification: [
          {
            command: "npm test",
            result: "passed",
            rationale: "task already satisfied",
          },
        ],
        commitMessage: "feat: already done",
      },
    });
  });

  it("rejects unknown outcome values", () => {
    expect(
      parseImplementerResult(
        '<pi-implement-result>{"outcome":"unknown","summary":"x","verification":[{"command":"c","result":"r","rationale":"r"}],"commitMessage":"m"}</pi-implement-result>',
      ),
    ).toMatchObject({
      ok: false,
      reason: /invalid outcome/,
    });
  });

  it("rejects changed outcome missing commitMessage", () => {
    expect(
      parseImplementerResult(
        '<pi-implement-result>{"outcome":"changed","summary":"x","verification":[{"command":"c","result":"r","rationale":"r"}]}</pi-implement-result>',
      ),
    ).toMatchObject({
      ok: false,
      reason: /missing commitMessage/,
    });
  });

  it("rejects legacy result missing commitMessage", () => {
    expect(
      parseImplementerResult(
        '<pi-implement-result>{"summary":"only","verification":[{"command":"c","result":"r","rationale":"r"}]}</pi-implement-result>',
      ),
    ).toMatchObject({
      ok: false,
      reason: /missing commitMessage/,
    });
  });

  it("rejects already_satisfied with empty verification", () => {
    expect(
      parseImplementerResult(
        '<pi-implement-result>{"outcome":"already_satisfied","summary":"x","verification":[]}</pi-implement-result>',
      ),
    ).toMatchObject({
      ok: false,
      reason: /non-empty verification array/,
    });
  });

  it("rejects already_satisfied with missing verification", () => {
    expect(
      parseImplementerResult(
        '<pi-implement-result>{"outcome":"already_satisfied","summary":"x"}</pi-implement-result>',
      ),
    ).toMatchObject({
      ok: false,
      reason: /non-empty verification array/,
    });
  });

  it("rejects missing fields", () => {
    expect(
      parseImplementerResult(
        '<pi-implement-result>{"summary":"only"}</pi-implement-result>',
      ),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("parseReviewerVerdict", () => {
  it("accepts approved", () => {
    expect(
      parseReviewerVerdict(
        '<pi-review-result>{"verdict":"approved"}</pi-review-result>',
      ),
    ).toEqual({
      verdict: "approved",
    });
  });

  it("extracts required changes", () => {
    expect(
      parseReviewerVerdict(
        '<pi-review-result>{"verdict":"changes_requested","requiredChanges":["fix it"]}</pi-review-result>',
      ),
    ).toEqual({
      verdict: "changes_requested",
      requiredChanges: ["fix it"],
    });
  });

  it("treats invalid output conservatively", () => {
    expect(parseReviewerVerdict("VERDICT: approved")).toMatchObject({
      verdict: "changes_requested",
    });
  });
});

describe("parseOverallReviewVerdict", () => {
  it("accepts approved", () => {
    expect(
      parseOverallReviewVerdict(
        '<pi-overall-review-result>{"verdict":"approved"}</pi-overall-review-result>',
      ),
    ).toEqual({ verdict: "approved" });
  });

  it("extracts required changes and optional recommendation", () => {
    expect(
      parseOverallReviewVerdict(
        '<pi-overall-review-result>{"verdict":"changes_requested","requiredChanges":["fix it"],"recommendationMarkdown":"## Suggested\\n\\nDo X"}</pi-overall-review-result>',
      ),
    ).toEqual({
      verdict: "changes_requested",
      requiredChanges: ["fix it"],
      recommendationMarkdown: "## Suggested\n\nDo X",
    });
  });

  it("synthesizes a missing recommendation from required changes", () => {
    const result = parseOverallReviewVerdict(
      '<pi-overall-review-result>{"verdict":"changes_requested","requiredChanges":["fix it"]}</pi-overall-review-result>',
    );
    expect(result).toEqual({
      verdict: "changes_requested",
      requiredChanges: ["fix it"],
      recommendationMarkdown: undefined,
    });
  });

  it("treats invalid output conservatively", () => {
    expect(parseOverallReviewVerdict("VERDICT: approved")).toEqual({
      verdict: "changes_requested",
      requiredChanges: [
        "Response did not include <pi-overall-review-result> output.",
      ],
    });
  });

  it("rejects changes_requested without requiredChanges", () => {
    expect(
      parseOverallReviewVerdict(
        '<pi-overall-review-result>{"verdict":"changes_requested"}</pi-overall-review-result>',
      ),
    ).toEqual({
      verdict: "changes_requested",
      requiredChanges: [
        "Overall review requested changes but did not provide requiredChanges.",
      ],
    });
  });

  it("rejects malformed JSON", () => {
    expect(
      parseOverallReviewVerdict(
        "<pi-overall-review-result>not json</pi-overall-review-result>",
      ),
    ).toMatchObject({
      verdict: "changes_requested",
    });
  });
});

describe("parseIntegrationSelfHealResult", () => {
  it("parses a valid repair result", () => {
    const text =
      '<pi-self-heal-result>{"repaired":true,"retryIntegration":true,"retryMode":"retry_validation","summary":"fixed","commands":["npm install"],"filesChanged":["package-lock.json"],"remainingBlocker":null}</pi-self-heal-result>';
    const parsed = parseIntegrationSelfHealResult(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.result.repaired).toBe(true);
    expect(parsed.result.retryIntegration).toBe(true);
    expect(parsed.result.retryMode).toBe("retry_validation");
    expect(parsed.result.summary).toBe("fixed");
    expect(parsed.result.commands).toEqual(["npm install"]);
    expect(parsed.result.filesChanged).toEqual(["package-lock.json"]);
    expect(parsed.result.remainingBlocker).toBeNull();
  });

  it("requires retryMode when retryIntegration is true", () => {
    const text =
      '<pi-self-heal-result>{"repaired":true,"retryIntegration":true}</pi-self-heal-result>';
    const parsed = parseIntegrationSelfHealResult(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      return;
    }
  });

  it("parses a non-repair result", () => {
    const text =
      '<pi-self-heal-result>{"repaired":false,"retryIntegration":false,"remainingBlocker":"cannot fix"}</pi-self-heal-result>';
    const parsed = parseIntegrationSelfHealResult(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.result.repaired).toBe(false);
    expect(parsed.result.retryIntegration).toBe(false);
    expect(parsed.result.remainingBlocker).toBe("cannot fix");
  });

  it("rejects invalid retryMode", () => {
    const text =
      '<pi-self-heal-result>{"repaired":true,"retryIntegration":true,"retryMode":"bad_mode"}</pi-self-heal-result>';
    const parsed = parseIntegrationSelfHealResult(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      return;
    }
  });
});

describe("commit messages", () => {
  it("validates lightweight conventional commits with optional bodies", () => {
    expect(isValidCommitMessage("feat: add parser")).toBe(true);
    expect(isValidCommitMessage("fix: add parser\n\nBody")).toBe(true);
    expect(isValidCommitMessage("feat(parser): add parser")).toBe(false);
  });

  it("derives a fallback without hardcoding feat", () => {
    expect(fallbackCommitMessage("Create the parser")).toBe(
      "chore: create the parser",
    );
    expect(fallbackCommitMessage("Fix parser bug")).toBe("fix: fix parser bug");
  });
});
