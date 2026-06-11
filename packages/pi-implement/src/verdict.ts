export type VerificationStep = {
  command: string;
  result: string;
  rationale: string;
};

export type ParsedImplementerResult =
  | {
      outcome: "changed";
      summary: string;
      verification: VerificationStep[];
      commitMessage: string;
    }
  | {
      outcome: "already_satisfied";
      summary: string;
      verification: VerificationStep[];
      commitMessage?: string;
    };

export type ReviewerVerdict =
  | { verdict: "approved" }
  | { verdict: "changes_requested"; requiredChanges: string[] }
  | { verdict: "error"; reason: string };

export type OverallReviewVerdict =
  | { verdict: "approved" }
  | {
      verdict: "changes_requested";
      requiredChanges: string[];
      recommendationMarkdown?: string;
    };

export type IntegrationSelfHealResult = {
  repaired: boolean;
  retryIntegration: boolean;
  retryMode?: "continue_candidate" | "retry_cherry_pick" | "retry_validation";
  summary?: string;
  commands?: string[];
  filesChanged?: string[];
  remainingBlocker?: string | null;
};

export type SchedulerSelfHealResult = {
  repaired: boolean;
  retryScheduler: boolean;
  summary?: string;
  commands?: string[];
  filesChanged?: string[];
  remainingBlocker?: string | null;
};

export type OverallReworkResult = {
  summary: string;
  verification: VerificationStep[];
  commitMessage?: string;
};

export function parseImplementerResult(
  text: string,
):
  | { ok: true; result: ParsedImplementerResult }
  | { ok: false; reason: string } {
  const parsed = parseTaggedJsonObject(text, "pi-implement-result");
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const summary = value.summary;
  const verification = value.verification;
  const commitMessage = value.commitMessage;

  const rawOutcome = value.outcome;
  const outcome =
    rawOutcome === undefined
      ? "changed"
      : rawOutcome === "changed" || rawOutcome === "already_satisfied"
        ? rawOutcome
        : undefined;

  if (outcome === undefined) {
    return {
      ok: false,
      reason: `Implementer JSON has invalid outcome "${String(rawOutcome)}". Expected "changed" or "already_satisfied" (or omit outcome for backward compatibility).`,
    };
  }

  if (!isNonEmptyString(summary)) {
    return { ok: false, reason: "Implementer JSON is missing summary." };
  }
  if (!Array.isArray(verification) || verification.length === 0) {
    return {
      ok: false,
      reason: "Implementer JSON must include a non-empty verification array.",
    };
  }
  const steps: VerificationStep[] = [];
  for (const step of verification) {
    if (!isRecord(step)) {
      return {
        ok: false,
        reason: "Each verification entry must be an object.",
      };
    }
    if (
      !isNonEmptyString(step.command) ||
      !isNonEmptyString(step.result) ||
      !isNonEmptyString(step.rationale)
    ) {
      return {
        ok: false,
        reason:
          "Each verification entry must include command, result, and rationale strings.",
      };
    }
    steps.push({
      command: step.command,
      result: step.result,
      rationale: step.rationale,
    });
  }

  if (outcome === "changed") {
    if (!isNonEmptyString(commitMessage)) {
      return {
        ok: false,
        reason: "Implementer JSON is missing commitMessage.",
      };
    }
    return {
      ok: true,
      result: {
        outcome: "changed",
        summary,
        verification: steps,
        commitMessage: commitMessage.trim(),
      },
    };
  }

  // outcome === "already_satisfied"
  return {
    ok: true,
    result: {
      outcome: "already_satisfied",
      summary,
      verification: steps,
      commitMessage:
        typeof commitMessage === "string" ? commitMessage.trim() : undefined,
    },
  };
}

export function parseOverallReviewVerdict(text: string): OverallReviewVerdict {
  const parsed = parseTaggedJsonObject(text, "pi-overall-review-result");
  if (!parsed.ok) {
    return {
      verdict: "changes_requested",
      requiredChanges: [parsed.reason],
    };
  }
  const value = parsed.value;
  if (value.verdict === "approved") {
    return { verdict: "approved" };
  }
  if (value.verdict !== "changes_requested") {
    return {
      verdict: "changes_requested",
      requiredChanges: [
        "Overall review JSON verdict must be either approved or changes_requested.",
      ],
    };
  }
  const requiredChanges = value.requiredChanges;
  if (!Array.isArray(requiredChanges) || requiredChanges.length === 0) {
    return {
      verdict: "changes_requested",
      requiredChanges: [
        "Overall review requested changes but did not provide requiredChanges.",
      ],
    };
  }
  const changes = requiredChanges.filter(isNonEmptyString);
  if (changes.length === 0) {
    return {
      verdict: "changes_requested",
      requiredChanges: [
        "Overall review requiredChanges must contain non-empty strings.",
      ],
    };
  }
  const recommendationMarkdown =
    typeof value.recommendationMarkdown === "string" &&
    value.recommendationMarkdown.trim()
      ? value.recommendationMarkdown.trim()
      : undefined;
  return {
    verdict: "changes_requested",
    requiredChanges: changes,
    recommendationMarkdown,
  };
}

export function parseReviewerVerdict(text: string): ReviewerVerdict {
  const parsed = parseTaggedJsonObject(text, "pi-review-result");
  if (!parsed.ok) {
    return { verdict: "error", reason: parsed.reason };
  }
  const value = parsed.value;
  if (value.verdict === "approved") {
    return { verdict: "approved" };
  }
  if (value.verdict !== "changes_requested") {
    return {
      verdict: "error",
      reason:
        "Reviewer JSON verdict must be either approved or changes_requested.",
    };
  }
  const requiredChanges = value.requiredChanges;
  if (!Array.isArray(requiredChanges) || requiredChanges.length === 0) {
    return {
      verdict: "error",
      reason: "Reviewer requested changes but did not provide requiredChanges.",
    };
  }
  const changes = requiredChanges.filter(isNonEmptyString).slice(0, 5);
  if (changes.length === 0) {
    return {
      verdict: "error",
      reason: "Reviewer requiredChanges must contain non-empty strings.",
    };
  }
  return { verdict: "changes_requested", requiredChanges: changes };
}

export function isValidCommitMessage(message: string): boolean {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? "";
  return /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert): .\S/.test(
    firstLine,
  );
}

export function fallbackCommitMessage(taskText: string): string {
  const cleaned = taskText
    .replace(/[`*_#[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${fallbackType(cleaned)}: ${cleaned.slice(0, 72) || "implement plan task"}`;
}

function fallbackType(taskText: string): string {
  if (/\b(fix|bug|broken|regression)\b/.test(taskText)) {
    return "fix";
  }
  if (/\b(docs?|readme|comment)\b/.test(taskText)) {
    return "docs";
  }
  if (/\btest(s|ing)?\b/.test(taskText)) {
    return "test";
  }
  if (/\brefactor\b/.test(taskText)) {
    return "refactor";
  }
  return "chore";
}

export function parseIntegrationSelfHealResult(
  text: string,
):
  | { ok: true; result: IntegrationSelfHealResult }
  | { ok: false; reason: string } {
  const parsed = parseTaggedJsonObject(text, "pi-self-heal-result");
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const repaired = value.repaired === true;
  const retryIntegration = value.retryIntegration === true;
  const retryMode = parseRetryMode(value.retryMode);
  if (retryIntegration && retryMode === undefined) {
    return {
      ok: false,
      reason:
        "Self-heal result missing retryMode when retryIntegration is true.",
    };
  }
  return {
    ok: true,
    result: {
      repaired,
      retryIntegration,
      retryMode,
      summary: typeof value.summary === "string" ? value.summary : undefined,
      commands: Array.isArray(value.commands)
        ? value.commands.filter((c): c is string => typeof c === "string")
        : undefined,
      filesChanged: Array.isArray(value.filesChanged)
        ? value.filesChanged.filter((c): c is string => typeof c === "string")
        : undefined,
      remainingBlocker:
        value.remainingBlocker === null ||
        typeof value.remainingBlocker === "string"
          ? value.remainingBlocker
          : undefined,
    },
  };
}

export function parseOverallReworkResult(
  text: string,
): { ok: true; result: OverallReworkResult } | { ok: false; reason: string } {
  const parsed = parseTaggedJsonObject(text, "pi-overall-rework-result");
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const summary = value.summary;
  const verification = value.verification;
  const commitMessage = value.commitMessage;

  if (!isNonEmptyString(summary)) {
    return { ok: false, reason: "Rework JSON is missing summary." };
  }
  if (!Array.isArray(verification) || verification.length === 0) {
    return {
      ok: false,
      reason: "Rework JSON must include a non-empty verification array.",
    };
  }
  const steps: VerificationStep[] = [];
  for (const step of verification) {
    if (!isRecord(step)) {
      return {
        ok: false,
        reason: "Each verification entry must be an object.",
      };
    }
    if (
      !isNonEmptyString(step.command) ||
      !isNonEmptyString(step.result) ||
      !isNonEmptyString(step.rationale)
    ) {
      return {
        ok: false,
        reason:
          "Each verification entry must include command, result, and rationale strings.",
      };
    }
    steps.push({
      command: step.command,
      result: step.result,
      rationale: step.rationale,
    });
  }

  return {
    ok: true,
    result: {
      summary,
      verification: steps,
      commitMessage:
        typeof commitMessage === "string" ? commitMessage.trim() : undefined,
    },
  };
}

export function parseSchedulerSelfHealResult(
  text: string,
):
  | { ok: true; result: SchedulerSelfHealResult }
  | { ok: false; reason: string } {
  const parsed = parseTaggedJsonObject(text, "pi-self-heal-result");
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value;
  const repaired = value.repaired === true;
  const retryScheduler = value.retryScheduler === true;
  return {
    ok: true,
    result: {
      repaired,
      retryScheduler,
      summary: typeof value.summary === "string" ? value.summary : undefined,
      commands: Array.isArray(value.commands)
        ? value.commands.filter((c): c is string => typeof c === "string")
        : undefined,
      filesChanged: Array.isArray(value.filesChanged)
        ? value.filesChanged.filter((c): c is string => typeof c === "string")
        : undefined,
      remainingBlocker:
        value.remainingBlocker === null ||
        typeof value.remainingBlocker === "string"
          ? value.remainingBlocker
          : undefined,
    },
  };
}

function parseRetryMode(
  value: unknown,
): "continue_candidate" | "retry_cherry_pick" | "retry_validation" | undefined {
  if (
    value === "continue_candidate" ||
    value === "retry_cherry_pick" ||
    value === "retry_validation"
  ) {
    return value;
  }
  return undefined;
}

function parseTaggedJsonObject(
  text: string,
  tag:
    | "pi-implement-result"
    | "pi-review-result"
    | "pi-overall-review-result"
    | "pi-self-heal-result"
    | "pi-overall-rework-result",
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string } {
  const candidate = lastTaggedContent(text, tag);
  if (!candidate) {
    return { ok: false, reason: `Response did not include <${tag}> output.` };
  }
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, reason: "Tagged JSON output must be an object." };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Could not parse tagged JSON output: ${message}`,
    };
  }
}

function lastTaggedContent(text: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "gi");
  const matches = [...text.matchAll(pattern)];
  return matches.at(-1)?.[1]?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
