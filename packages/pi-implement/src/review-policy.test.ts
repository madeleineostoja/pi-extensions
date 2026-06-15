import { describe, expect, it } from "vitest";
import { classifyPath, decideTaskReview } from "./review-policy.js";
import type { DecideTaskReviewArgs } from "./review-policy.js";

function makeArgs(
  overrides: Partial<DecideTaskReviewArgs> = {},
): DecideTaskReviewArgs {
  return {
    effectiveConfig: {
      mode: "auto",
      maxSkipDiffChars: 2000,
      maxSkipFiles: 3,
    },
    isRetry: false,
    implementerOutcome: "changed",
    stagedSummary: {
      fileCount: 1,
      diffChars: 100,
      nameStatusLines: ["A\tREADME.md"],
    },
    validation: { status: "not_required" },
    ...overrides,
  };
}

describe("classifyPath", () => {
  it("classifies markdown files as docs", () => {
    expect(classifyPath("README.md")).toBe("docs");
    expect(classifyPath("docs/guide.md")).toBe("docs");
    expect(classifyPath("CHANGELOG.txt")).toBe("docs");
  });

  it("classifies code and config under docs as risky", () => {
    expect(classifyPath("docs/example.ts")).toBe("risky");
    expect(classifyPath("docs/vite.config.ts")).toBe("risky");
  });

  it("classifies fixture directories as fixture", () => {
    expect(classifyPath("tests/fixtures/data.json")).toBe("fixture");
    expect(classifyPath("__snapshots__/abc.ts.snap")).toBe("fixture");
    expect(classifyPath("testdata/input.csv")).toBe("fixture");
  });

  it("classifies source code as risky", () => {
    expect(classifyPath("src/index.ts")).toBe("risky");
    expect(classifyPath("lib/utils.ts")).toBe("risky");
    expect(classifyPath("app/main.tsx")).toBe("risky");
  });

  it("classifies package files as risky", () => {
    expect(classifyPath("package.json")).toBe("risky");
    expect(classifyPath("pnpm-lock.yaml")).toBe("risky");
  });

  it("classifies CI/config files as risky", () => {
    expect(classifyPath(".github/workflows/ci.yml")).toBe("risky");
    expect(classifyPath("tsconfig.json")).toBe("risky");
  });

  it("classifies migrations as risky", () => {
    expect(classifyPath("db/migrations/001_init.sql")).toBe("risky");
    expect(classifyPath("schema/prisma/schema.prisma")).toBe("risky");
  });

  it("classifies auth paths as risky", () => {
    expect(classifyPath("src/auth/login.ts")).toBe("risky");
    expect(classifyPath("security/headers.ts")).toBe("risky");
  });

  it("classifies executable scripts as risky", () => {
    expect(classifyPath("scripts/deploy.sh")).toBe("risky");
    expect(classifyPath("bin/start.bat")).toBe("risky");
  });

  it("classifies unknown paths as unknown", () => {
    expect(classifyPath("assets/logo.png")).toBe("unknown");
    expect(classifyPath("fonts/arial.ttf")).toBe("unknown");
  });
});

describe("decideTaskReview", () => {
  it("reviews when config mode is always", () => {
    const result = decideTaskReview(
      makeArgs({
        effectiveConfig: {
          mode: "always",
          maxSkipDiffChars: 2000,
          maxSkipFiles: 3,
        },
        plannerDirective: { mode: "skip" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("always");
  });

  it("reviews for already_satisfied outcome", () => {
    const result = decideTaskReview(
      makeArgs({
        implementerOutcome: "already_satisfied",
        plannerDirective: { mode: "skip" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("already_satisfied");
  });

  it("reviews on retry/rework attempts", () => {
    const result = decideTaskReview(
      makeArgs({
        isRetry: true,
        plannerDirective: { mode: "skip" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("retry");
  });

  it("reviews when no planner directive exists", () => {
    const result = decideTaskReview(makeArgs({ plannerDirective: undefined }));
    expect(result.action).toBe("review");
    expect(result.reason).toContain("no planner directive");
  });

  it("reviews when planner directive is require", () => {
    const result = decideTaskReview(
      makeArgs({ plannerDirective: { mode: "require" } }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("require");
  });

  it("reviews when diff exceeds maxSkipDiffChars", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 5000,
          nameStatusLines: ["A\tREADME.md"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("size");
  });

  it("reviews when too many files changed", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 5,
          diffChars: 100,
          nameStatusLines: [
            "A\tREADME.md",
            "A\tCONTRIBUTING.md",
            "A\tCHANGELOG.md",
            "A\tLICENSE",
            "A\tCODE_OF_CONDUCT.md",
          ],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("too many");
  });

  it("reviews when diff includes deletions", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["D\tREADME.md"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("deletions");
  });

  it("reviews when diff includes renames", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["R100\tOLD.md\tNEW.md"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("renames");
  });

  it("reviews when diff touches risky paths", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\tsrc/index.ts"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("risky");
  });

  it("skips docs-only changes with suggest directive", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "suggest" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\tREADME.md"],
        },
      }),
    );
    expect(result).toMatchObject({
      action: "skip",
      category: "docs-only",
    });
  });

  it("skips docs-only changes with skip directive", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["M\tdocs/guide.md"],
        },
      }),
    );
    expect(result).toMatchObject({
      action: "skip",
      category: "docs-only",
    });
  });

  it("reviews docs-only candidates when validation failed", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\tREADME.md"],
        },
        validation: { status: "failed", reason: "docs check failed" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("validation failed");
  });

  it("reviews unclassified paths even with skip directive", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\tassets/logo.png"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("unclassified");
  });

  it("needs validation for additive fixtures with skip directive", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\ttests/fixtures/data.json"],
        },
        validation: { status: "not_required" },
      }),
    );
    expect(result.action).toBe("needs_validation");
    expect(result.reason).toContain("fixtures");
  });

  it("skips additive fixtures when validation passed", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\t__snapshots__/abc.ts.snap"],
        },
        validation: { status: "passed", commands: ["npm test"] },
      }),
    );
    expect(result).toMatchObject({
      action: "skip",
      category: "additive-fixture",
    });
  });

  it("reviews additive fixtures when validation unavailable", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\ttests/fixtures/data.json"],
        },
        validation: { status: "unavailable" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("unavailable");
  });

  it("reviews additive fixtures when validation failed", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\ttests/fixtures/data.json"],
        },
        validation: { status: "failed" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("failed");
  });

  it("reviews modified tests (not skip-eligible)", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["M\ttests/index.test.ts"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("risky");
  });

  it("reviews mixed docs and risky paths", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 2,
          diffChars: 200,
          nameStatusLines: ["A\tREADME.md", "A\tsrc/index.ts"],
        },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("risky");
  });

  it("suggest cannot skip additive fixtures in v1", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "suggest" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["A\ttests/fixtures/data.json"],
        },
        validation: { status: "passed" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("default safety fallback");
  });

  it("reviews when no staged files (should not happen for changed, but safe)", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 0,
          diffChars: 0,
          nameStatusLines: [],
        },
      }),
    );
    expect(result.action).toBe("review");
  });

  it("allows multiple docs files with skip directive", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 2,
          diffChars: 200,
          nameStatusLines: ["A\tREADME.md", "M\tCHANGELOG.md"],
        },
      }),
    );
    expect(result).toMatchObject({
      action: "skip",
      category: "docs-only",
    });
  });

  it("reviews when diff includes modified fixture (not purely additive)", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 1,
          diffChars: 100,
          nameStatusLines: ["M\ttests/fixtures/data.json"],
        },
        validation: { status: "passed" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("default safety fallback");
  });

  it("reviews when additive fixture is mixed with docs", () => {
    const result = decideTaskReview(
      makeArgs({
        plannerDirective: { mode: "skip" },
        stagedSummary: {
          fileCount: 2,
          diffChars: 200,
          nameStatusLines: ["A\ttests/fixtures/data.json", "A\tREADME.md"],
        },
        validation: { status: "passed" },
      }),
    );
    expect(result.action).toBe("review");
    expect(result.reason).toContain("default safety fallback");
  });
});
