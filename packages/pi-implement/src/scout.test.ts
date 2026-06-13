import { describe, expect, it } from "vitest";
import {
  decideScout,
  buildScoutPrompt,
  formatScoutContext,
  buildScoutUnavailableNote,
} from "./scout.js";
import type { EffectiveScoutConfig } from "./config.js";
import type { ScoutDirective } from "./graph.js";

function makeConfig(
  overrides: Partial<EffectiveScoutConfig> = {},
): EffectiveScoutConfig {
  return {
    enabled: true,
    mode: "auto",
    type: "Explore",
    maxResultChars: 50000,
    timeoutMs: 120000,
    ...overrides,
  };
}

function makeDirective(
  overrides: Partial<ScoutDirective> & { mode: ScoutDirective["mode"] } = {
    mode: "suggest",
  },
): ScoutDirective {
  return {
    mode: overrides.mode,
    reason: overrides.reason,
    prompt: overrides.prompt,
    breadth: overrides.breadth,
  };
}

const TASK_TEXT = "Implement the thing";
const COMPILED_CONTRACT = "# Task Contract\n\n## Objective\n\nDo the thing.";
const WORKTREE = "/repo/worktrees/r1/t001-task";
const PLAN_ARTIFACTS = ["/repo/plan.md"];

describe("decideScout", () => {
  it("skips when enabled is false", () => {
    const result = decideScout({
      config: makeConfig({ enabled: false }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({ run: false, reason: "Scout disabled by config" });
  });

  it("skips when mode is off", () => {
    const result = decideScout({
      config: makeConfig({ mode: "off" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({ run: false, reason: "Scout disabled by config" });
  });

  it("runs when mode is always", () => {
    const result = decideScout({
      config: makeConfig({ mode: "always" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({ run: true, reason: "Scout mode is always" });
  });

  it("runs in auto when directive mode is require", () => {
    const result = decideScout({
      config: makeConfig(),
      directive: makeDirective({ mode: "require" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Planner directive requires Scout",
    });
  });

  it("runs in auto when directive mode is suggest", () => {
    const result = decideScout({
      config: makeConfig(),
      directive: makeDirective({ mode: "suggest" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Planner directive suggests Scout",
    });
  });

  it("skips in auto when directive mode is skip on first attempt", () => {
    const result = decideScout({
      config: makeConfig(),
      directive: makeDirective({ mode: "skip" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: false,
      reason: "Planner directive skips Scout on first attempt",
    });
  });

  it("overrides skip directive on retry", () => {
    const result = decideScout({
      config: makeConfig(),
      directive: makeDirective({ mode: "skip" }),
      isRetry: true,
      attemptOrdinal: 2,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Retry/rework feedback warrants fresh Scout context",
    });
  });

  it("overrides skip directive when feedback is present", () => {
    const result = decideScout({
      config: makeConfig(),
      directive: makeDirective({ mode: "skip" }),
      isRetry: false,
      attemptOrdinal: 1,
      feedback: { source: "reviewer", message: "fix the bug" },
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Retry/rework feedback warrants fresh Scout context",
    });
  });

  it("runs in auto on retry even without directive", () => {
    const result = decideScout({
      config: makeConfig(),
      isRetry: true,
      attemptOrdinal: 2,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Retry/rework feedback warrants fresh Scout context",
    });
  });

  it("runs in auto when attemptOrdinal > 1 even without explicit retry flag", () => {
    const result = decideScout({
      config: makeConfig(),
      isRetry: false,
      attemptOrdinal: 2,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Retry/rework feedback warrants fresh Scout context",
    });
  });

  it("runs in auto when feedback message is present", () => {
    const result = decideScout({
      config: makeConfig(),
      isRetry: false,
      attemptOrdinal: 1,
      feedback: { source: "system", message: "validation failed" },
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: true,
      reason: "Retry/rework feedback warrants fresh Scout context",
    });
  });

  it("skips empty feedback message in auto on first attempt", () => {
    const result = decideScout({
      config: makeConfig(),
      isRetry: false,
      attemptOrdinal: 1,
      feedback: { source: "system", message: "   " },
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: false,
      reason:
        "No planner directive and no retry feedback; skipping Scout in auto mode",
    });
  });

  it("skips in auto when no directive and no retry on first attempt", () => {
    const result = decideScout({
      config: makeConfig(),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: false,
      reason:
        "No planner directive and no retry feedback; skipping Scout in auto mode",
    });
  });

  it("does not use task text heuristics in v1", () => {
    const result = decideScout({
      config: makeConfig(),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: "Refactor the entire codebase and add new features",
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({
      run: false,
      reason:
        "No planner directive and no retry feedback; skipping Scout in auto mode",
    });
  });

  it("prefers always mode over directive", () => {
    const result = decideScout({
      config: makeConfig({ mode: "always" }),
      directive: makeDirective({ mode: "skip" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({ run: true, reason: "Scout mode is always" });
  });

  it("prefers disabled over always", () => {
    const result = decideScout({
      config: makeConfig({ enabled: false, mode: "always" }),
      isRetry: false,
      attemptOrdinal: 1,
      taskText: TASK_TEXT,
      compiledContract: COMPILED_CONTRACT,
    });
    expect(result).toEqual({ run: false, reason: "Scout disabled by config" });
  });
});

describe("buildScoutPrompt", () => {
  it("includes the read-only contract and worktree path", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
    });
    expect(prompt).toContain("read-only Scout for pi-implement");
    expect(prompt).toContain(WORKTREE);
    expect(prompt).toContain(PLAN_ARTIFACTS[0]);
    expect(prompt).toContain("Do not edit, write, stage, commit");
  });

  it("includes the compiled contract", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
    });
    expect(prompt).toContain(COMPILED_CONTRACT.trim());
  });

  it("lists plan artifacts as read-only", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: ["/repo/plan.md", "/repo/spec.md"],
      isRetry: false,
    });
    expect(prompt).toContain(
      "Plan artifacts are read-only and must not be edited: /repo/plan.md, /repo/spec.md",
    );
  });

  it("shows (none) when plan artifacts are empty", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: [],
      isRetry: false,
    });
    expect(prompt).toContain(
      "Plan artifacts are read-only and must not be edited: (none)",
    );
  });

  it("does not ask to design or implement the solution", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
    });
    expect(prompt).toContain(
      "Do not design or implement the solution. Only locate and summarize context.",
    );
  });

  it("requests concise implementation-oriented output sections", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
    });
    expect(prompt).toContain("Relevant files and why they matter");
    expect(prompt).toContain("Relevant symbols/functions/classes");
    expect(prompt).toContain("Likely tests or verification commands");
    expect(prompt).toContain("Existing patterns/conventions to preserve");
    expect(prompt).toContain("Uncertainties or limits of the search");
  });

  it("includes directive mode, reason, and breadth when provided", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      directive: {
        mode: "require",
        reason: "broad change",
        breadth: "very thorough",
      },
      isRetry: false,
    });
    expect(prompt).toContain("Mode: require");
    expect(prompt).toContain("Reason: broad change");
    expect(prompt).toContain("Breadth: very thorough");
  });

  it("includes custom prompt from directive", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      directive: {
        mode: "require",
        prompt: "Find auth patterns",
      },
      isRetry: false,
    });
    expect(prompt).toContain("Custom prompt:");
    expect(prompt).toContain("Find auth patterns");
    expect(prompt).toContain("Scout request:\nFind auth patterns");
  });

  it("omits directive section when no directive is given", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
    });
    expect(prompt).not.toContain("## Planner Scout Directive");
  });

  it("includes retry feedback when provided", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: true,
      feedback: { source: "reviewer", message: "fix the bug" },
    });
    expect(prompt).toContain("## Retry Feedback");
    expect(prompt).toContain("Source: reviewer");
    expect(prompt).toContain("fix the bug");
  });

  it("uses retry fallback request when isRetry is true without custom prompt", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: true,
      feedback: { source: "reviewer", message: "fix the bug" },
    });
    expect(prompt).toContain(
      "Find the files, symbols, tests, and existing patterns most relevant to resolving this task and the retry feedback.",
    );
  });

  it("uses default request on first attempt without directive", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
    });
    expect(prompt).toContain(
      "Explore the codebase to locate relevant files, symbols, tests, and patterns for the selected task.",
    );
  });

  it("prioritizes directive custom prompt over retry fallback", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      directive: {
        mode: "require",
        prompt: "Custom directive prompt",
      },
      isRetry: true,
      feedback: { source: "system", message: "failed" },
    });
    expect(prompt).toContain("Custom directive prompt");
    expect(prompt).not.toContain(
      "Find the files, symbols, tests, and existing patterns most relevant to resolving this task and the retry feedback.",
    );
  });

  it("uses feedback fallback when feedback is present but isRetry is false", () => {
    const prompt = buildScoutPrompt({
      worktreePath: WORKTREE,
      compiledContract: COMPILED_CONTRACT,
      planArtifacts: PLAN_ARTIFACTS,
      isRetry: false,
      feedback: { source: "commit-hook", message: "lint failed" },
    });
    expect(prompt).toContain(
      "Find the files, symbols, tests, and existing patterns most relevant to resolving this task and the retry feedback.",
    );
  });
});

describe("formatScoutContext", () => {
  it("returns empty string for empty result", () => {
    expect(formatScoutContext("", 100)).toBe("");
    expect(formatScoutContext("   ", 100)).toBe("");
  });

  it("returns the result unchanged when under maxChars", () => {
    const result = "Short context";
    expect(formatScoutContext(result, 100)).toBe("Short context");
  });

  it("truncates result when over maxChars", () => {
    const result = "a".repeat(200);
    const formatted = formatScoutContext(result, 100);
    expect(formatted.length).toBeLessThanOrEqual(100);
    expect(formatted).toContain(
      "[Scout context truncated to fit length limit]",
    );
    expect(formatted.startsWith("a")).toBe(true);
  });

  it("truncates at last newline when within 80% of maxChars", () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `This is line number ${i + 1} here`,
    );
    const result = lines.join("\n");
    const maxChars = 150;
    const formatted = formatScoutContext(result, maxChars);
    expect(formatted.length).toBeLessThanOrEqual(maxChars);
    expect(formatted).toContain(
      "[Scout context truncated to fit length limit]",
    );
    expect(formatted).not.toContain("line number 5");
  });

  it("truncates at maxChars when no newline is within 80%", () => {
    const result = "a".repeat(200);
    const formatted = formatScoutContext(result, 100);
    expect(formatted.length).toBeLessThanOrEqual(100);
    expect(formatted).toContain(
      "[Scout context truncated to fit length limit]",
    );
    const beforeNote = formatted.split("\n\n[Scout context truncated")[0]!;
    expect(beforeNote.length).toBeLessThanOrEqual(
      100 - "\n\n[Scout context truncated to fit length limit]".length,
    );
  });

  it("preserves leading and trailing whitespace by trimming", () => {
    const result = "  context  ";
    expect(formatScoutContext(result, 100)).toBe("context");
  });

  it("handles exact length match", () => {
    const result = "x".repeat(50);
    expect(formatScoutContext(result, 50)).toBe(result);
  });

  it("keeps result within maxChars when maxChars is smaller than the notice", () => {
    const result = "a".repeat(100);
    const maxChars = 10;
    const formatted = formatScoutContext(result, maxChars);
    expect(formatted.length).toBeLessThanOrEqual(maxChars);
    expect(formatted).not.toContain("[Scout context truncated");
  });

  it("keeps result within maxChars when maxChars equals the notice length", () => {
    const notice = "\n\n[Scout context truncated to fit length limit]";
    const result = "b".repeat(200);
    const maxChars = notice.length;
    const formatted = formatScoutContext(result, maxChars);
    expect(formatted.length).toBeLessThanOrEqual(maxChars);
  });

  it("keeps result within maxChars for a range of small caps", () => {
    const result = "c".repeat(200);
    for (let maxChars = 1; maxChars <= 60; maxChars++) {
      const formatted = formatScoutContext(result, maxChars);
      expect(formatted.length).toBeLessThanOrEqual(maxChars);
    }
  });
});

describe("buildScoutUnavailableNote", () => {
  it("returns a note with the reason", () => {
    const note = buildScoutUnavailableNote("timeout");
    expect(note).toContain("Scout was unavailable for this attempt (timeout)");
    expect(note).toContain("missing optimization, not a blocker");
  });
});
