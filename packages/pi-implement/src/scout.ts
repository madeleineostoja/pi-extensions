import type { EffectiveScoutConfig } from "./config.js";
import type { ScoutDirective } from "./graph.js";

export type ScoutDecisionInput = {
  config: EffectiveScoutConfig;
  directive?: ScoutDirective;
  isRetry: boolean;
  attemptOrdinal: number;
  feedback?: { source: string; message: string };
  taskText: string;
  compiledContract: string;
};

export type ScoutDecision =
  | { run: true; reason: string }
  | { run: false; reason: string };

export function decideScout(input: ScoutDecisionInput): ScoutDecision {
  const { config, directive, isRetry, attemptOrdinal, feedback } = input;

  if (!config.enabled || config.mode === "off") {
    return { run: false, reason: "Scout disabled by config" };
  }

  if (config.mode === "always") {
    return { run: true, reason: "Scout mode is always" };
  }

  const hasRetrySignal =
    isRetry ||
    attemptOrdinal > 1 ||
    (feedback !== undefined && feedback.message.trim().length > 0);

  if (hasRetrySignal) {
    return {
      run: true,
      reason: "Retry/rework feedback warrants fresh Scout context",
    };
  }

  if (directive) {
    if (directive.mode === "require") {
      return { run: true, reason: "Planner directive requires Scout" };
    }
    if (directive.mode === "suggest") {
      return { run: true, reason: "Planner directive suggests Scout" };
    }
    if (directive.mode === "skip") {
      return {
        run: false,
        reason: "Planner directive skips Scout on first attempt",
      };
    }
  }

  return {
    run: false,
    reason:
      "No planner directive and no retry feedback; skipping Scout in auto mode",
  };
}

export type ScoutPromptInput = {
  worktreePath: string;
  compiledContract: string;
  planArtifacts: string[];
  directive?: ScoutDirective;
  isRetry: boolean;
  feedback?: { source: string; message: string };
};

export function buildScoutPrompt(input: ScoutPromptInput): string {
  const {
    worktreePath,
    compiledContract,
    planArtifacts,
    directive,
    isRetry,
    feedback,
  } = input;

  const lines: string[] = [
    "You are a read-only Scout for pi-implement. Explore the assigned worktree to locate implementation context for exactly one selected task. Do not edit, write, stage, commit, install dependencies, or run mutating commands.",
    "",
    `Assigned worktree: ${worktreePath}`,
    `Plan artifacts are read-only and must not be edited: ${planArtifacts.join(", ") || "(none)"}`,
    "",
    "Compiled task contract:",
    compiledContract,
  ];

  if (directive) {
    lines.push("");
    lines.push("## Planner Scout Directive");
    lines.push("");
    lines.push(`Mode: ${directive.mode}`);
    if (directive.reason) {
      lines.push(`Reason: ${directive.reason}`);
    }
    if (directive.breadth) {
      lines.push(`Breadth: ${directive.breadth}`);
    }
    if (directive.prompt) {
      lines.push("");
      lines.push("Custom prompt:");
      lines.push(directive.prompt);
    }
  }

  if (feedback) {
    lines.push("");
    lines.push("## Retry Feedback");
    lines.push("");
    lines.push(`Source: ${feedback.source}`);
    lines.push("");
    lines.push(feedback.message);
  }

  let scoutRequest: string;
  if (directive?.prompt) {
    scoutRequest = directive.prompt;
  } else if (isRetry || feedback) {
    scoutRequest =
      "Find the files, symbols, tests, and existing patterns most relevant to resolving this task and the retry feedback.";
  } else {
    scoutRequest =
      "Explore the codebase to locate relevant files, symbols, tests, and patterns for the selected task.";
  }

  lines.push("");
  lines.push("Scout request:");
  lines.push(scoutRequest);
  lines.push("");
  lines.push("Return a concise Scout Context with:");
  lines.push("");
  lines.push("- Relevant files and why they matter");
  lines.push("- Relevant symbols/functions/classes");
  lines.push("- Likely tests or verification commands");
  lines.push("- Existing patterns/conventions to preserve");
  lines.push("- Uncertainties or limits of the search");
  lines.push("");
  lines.push(
    "Do not design or implement the solution. Only locate and summarize context.",
  );

  return lines.join("\n");
}

export function formatScoutContext(
  scoutResult: string,
  maxChars: number,
): string {
  const trimmed = scoutResult.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const notice = "\n\n[Scout context truncated to fit length limit]";
  if (maxChars <= notice.length) {
    return trimmed.slice(0, Math.max(0, maxChars));
  }

  const contentBudget = maxChars - notice.length;
  const truncated = trimmed.slice(0, contentBudget);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutoff =
    lastNewline > contentBudget * 0.8 ? lastNewline : contentBudget;
  return trimmed.slice(0, cutoff) + notice;
}

export function buildScoutUnavailableNote(reason: string): string {
  return `Scout was unavailable for this attempt (${reason}). Treat this as a missing optimization, not a blocker. Proceed with the task using the task contract and your own exploration.`;
}
