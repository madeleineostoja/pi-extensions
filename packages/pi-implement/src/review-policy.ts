import type { EffectiveTaskReviewConfig } from "./config.js";
import type { TaskReviewDirective } from "./graph.js";

export type ValidationEvidence = {
  status: "not_required" | "unavailable" | "passed" | "failed";
  commands?: string[];
  reason?: string;
};

export type StagedFileSummary = {
  fileCount: number;
  diffChars: number;
  nameStatusLines: string[];
};

export type TaskReviewDecision =
  | { action: "review"; reason: string }
  | { action: "needs_validation"; reason: string; commandsRequired: true }
  | {
      action: "skip";
      reason: string;
      category: "docs-only" | "additive-fixture";
    };

export type DecideTaskReviewArgs = {
  effectiveConfig: EffectiveTaskReviewConfig;
  plannerDirective?: TaskReviewDirective;
  isRetry: boolean;
  implementerOutcome: "changed" | "already_satisfied";
  scoutFailed: boolean;
  stagedSummary: StagedFileSummary;
  validation: ValidationEvidence;
};

const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc", ".markdown"]);

const RISKY_SOURCE_DIRS = new Set([
  "src",
  "lib",
  "app",
  "packages",
  "services",
  "server",
  "client",
]);

const RISKY_FILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
]);

const RISKY_SEGMENTS = new Set([
  "migrations",
  "migrate",
  "schema",
  "db",
  "auth",
  "security",
  "permission",
  "acl",
  "rbac",
  "oauth",
  "jwt",
  "csrf",
  "xss",
  "crypto",
  "ci",
  "cd",
  "workflows",
  "actions",
  "scripts",
  "bin",
]);

const RISKY_BASENAME_PATTERNS = [
  /^(tsconfig|jsconfig)(\..*)?\.json$/i,
  /^(vite|webpack|rollup|esbuild|babel|eslint|prettier|lint-staged|husky|turborepo|nx)(\..*)?\.(json|js|cjs|mjs|ts)$/i,
  /^dockerfile$/i,
  /^docker-compose\./i,
  /^\.dockerignore$/i,
  /\.config\.(js|cjs|mjs|ts)$/i,
];

const RISKY_PATH_PATTERNS = [
  /(^|[/\\])\.(github|gitlab)([/\\]|$)/i,
  /(^|[/\\])(terraform|pulumi|cdktf)([/\\]|$)/i,
  /\.tf$/i,
  /\.(sh|bat|cmd|ps1|exe)$/i,
];

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".swift",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".dart",
  ".clj",
  ".cljs",
  ".erl",
  ".ex",
  ".exs",
  ".hs",
  ".lua",
  ".pl",
  ".pm",
  ".r",
  ".scala",
  ".groovy",
  ".vb",
  ".fs",
  ".fsx",
  ".ml",
  ".mli",
  ".nim",
  ".zig",
  ".v",
  ".sv",
  ".svh",
]);

const FIXTURE_DIRS = new Set([
  "fixtures",
  "testdata",
  "snapshots",
  "__snapshots__",
  "test-fixtures",
  "fixture-data",
]);

export function classifyPath(
  path: string,
): "docs" | "fixture" | "risky" | "unknown" {
  const lower = path.toLowerCase();
  const segments = lower.split(/[/\\]/);
  const basename = segments[segments.length - 1] ?? "";
  const ext = basename.includes(".")
    ? basename.slice(basename.lastIndexOf("."))
    : "";

  if (RISKY_FILE_NAMES.has(basename)) {
    return "risky";
  }
  if (CODE_EXTENSIONS.has(ext)) {
    return "risky";
  }
  if (segments.some((seg) => RISKY_SOURCE_DIRS.has(seg))) {
    return "risky";
  }
  if (segments.some((seg) => RISKY_SEGMENTS.has(seg))) {
    return "risky";
  }
  if (RISKY_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
    return "risky";
  }
  if (RISKY_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
    return "risky";
  }

  if (segments.some((seg) => FIXTURE_DIRS.has(seg))) {
    return "fixture";
  }

  if (
    segments.includes("docs") ||
    segments.includes("documentation") ||
    segments.includes("doc") ||
    basename.startsWith("readme") ||
    DOC_EXTENSIONS.has(ext)
  ) {
    return "docs";
  }

  return "unknown";
}

export function decideTaskReview(
  args: DecideTaskReviewArgs,
): TaskReviewDecision {
  const {
    effectiveConfig,
    plannerDirective,
    isRetry,
    implementerOutcome,
    scoutFailed,
    stagedSummary,
    validation,
  } = args;

  // Config mode always forces review
  if (effectiveConfig.mode === "always") {
    return { action: "review", reason: "config mode is always" };
  }

  // already_satisfied always needs review (no diff to inspect, but claim must be checked)
  if (implementerOutcome === "already_satisfied") {
    return {
      action: "review",
      reason: "already_satisfied claims require independent verification",
    };
  }

  // Retry/rework attempts always get review
  if (isRetry) {
    return { action: "review", reason: "retry/rework attempt" };
  }

  // Scout failure on a non-trivial candidate forces review
  if (scoutFailed) {
    return {
      action: "review",
      reason: "scout failure on non-trivial candidate",
    };
  }

  // No planner directive means review (preserves serial-mode and fallback behavior)
  if (!plannerDirective) {
    return { action: "review", reason: "no planner directive" };
  }

  // require always forces review
  if (plannerDirective.mode === "require") {
    return { action: "review", reason: "planner directive is require" };
  }

  // Large diff forces review
  if (stagedSummary.diffChars > effectiveConfig.maxSkipDiffChars) {
    return { action: "review", reason: "diff exceeds size threshold" };
  }

  // Too many files forces review
  if (stagedSummary.fileCount > effectiveConfig.maxSkipFiles) {
    return { action: "review", reason: "too many changed files" };
  }

  if (validation.status === "failed") {
    return { action: "review", reason: "validation failed" };
  }

  if (stagedSummary.nameStatusLines.length === 0) {
    return { action: "review", reason: "no staged files" };
  }

  // Deletions or renames force review
  for (const line of stagedSummary.nameStatusLines) {
    const status = line.split("\t")[0];
    if (status.startsWith("D") || status.startsWith("R")) {
      return {
        action: "review",
        reason: "diff includes deletions or renames",
      };
    }
  }

  // Classify all staged paths
  const classifications = stagedSummary.nameStatusLines.map((line) => {
    const parts = line.split("\t");
    const path = parts.length > 2 ? parts[2] : parts[1];
    return classifyPath(path);
  });

  const hasRisky = classifications.some((c) => c === "risky");
  const hasUnknown = classifications.some((c) => c === "unknown");

  if (hasRisky) {
    return { action: "review", reason: "diff touches risky paths" };
  }

  // All docs: docs-only skip candidate
  const allDocs = classifications.every((c) => c === "docs");
  if (allDocs) {
    // suggest can skip docs-only in v1; skip can also skip docs-only
    if (
      plannerDirective.mode === "skip" ||
      plannerDirective.mode === "suggest"
    ) {
      return {
        action: "skip",
        reason: "docs-only changes with low-risk directive",
        category: "docs-only",
      };
    }
  }

  // Additive fixtures: every file must be Added under a fixture dir, no risky paths
  const allAdditiveFixtures =
    stagedSummary.nameStatusLines.length > 0 &&
    stagedSummary.nameStatusLines.every((line) => {
      const parts = line.split("\t");
      const status = parts[0];
      const path = parts.length > 2 ? parts[2] : parts[1];
      return status === "A" && classifyPath(path) === "fixture";
    });

  if (allAdditiveFixtures) {
    if (plannerDirective.mode === "skip") {
      // Needs passed validation; if not yet evaluated, request it
      if (validation.status === "passed") {
        return {
          action: "skip",
          reason: "additive fixtures with passed validation",
          category: "additive-fixture",
        };
      }
      if (validation.status === "not_required") {
        return {
          action: "needs_validation",
          reason: "additive fixtures require objective validation",
          commandsRequired: true,
        };
      }
      if (validation.status === "unavailable") {
        return {
          action: "review",
          reason: "validation unavailable for fixture skip",
        };
      }
      if (validation.status === "failed") {
        return {
          action: "review",
          reason: "validation failed for fixture candidate",
        };
      }
      // Default to needs_validation for additive fixtures when status is not_required (shouldn't happen after first call)
      return {
        action: "needs_validation",
        reason: "additive fixtures require objective validation",
        commandsRequired: true,
      };
    }
    // suggest cannot skip additive fixtures in v1
  }

  // If we get here with unknown-classified paths and a skip directive, still review
  if (hasUnknown) {
    return { action: "review", reason: "unclassified paths require review" };
  }

  // Fallback: review for any remaining case
  return { action: "review", reason: "default safety fallback" };
}
