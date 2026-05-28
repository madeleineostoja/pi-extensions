import { describe, expect, it } from "vitest";
import {
  fallbackCommitMessage,
  isValidCommitMessage,
  parseImplementerResult,
  parseReviewerVerdict,
} from "./verdict.js";

describe("parseImplementerResult", () => {
  it("extracts structured JSON result", () => {
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
