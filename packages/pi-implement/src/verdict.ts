import type {
  FindingAssessment,
  RegressionFindingDraft,
  ReviewFindingDraft,
  ReviewObservation,
} from "./result-schemas.js";
import { validateAssessmentCoverage } from "./review-convergence.js";

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

export type InitialReviewResult =
  | { verdict: "approved" }
  | {
      verdict: "changes_requested";
      findings: ReviewFindingDraft[];
      recommendationMarkdown?: string;
    };

export type AnchoredReviewResult = {
  assessments: FindingAssessment[];
  regressions: RegressionFindingDraft[];
  observations?: ReviewObservation[];
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
  value: unknown,
):
  | { ok: true; result: ParsedImplementerResult }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "Implementer completion must be an object." };
  }
  return parseImplementerResultValue(value);
}

function parseImplementerResultValue(
  value: Record<string, unknown>,
):
  | { ok: true; result: ParsedImplementerResult }
  | { ok: false; reason: string } {
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

export function parseOverallReviewVerdict(
  value: unknown,
): OverallReviewVerdict {
  if (!isRecord(value)) {
    return {
      verdict: "changes_requested",
      requiredChanges: ["Overall review completion must be an object."],
    };
  }
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

export function parseReviewerVerdict(value: unknown): ReviewerVerdict {
  if (!isRecord(value)) {
    return {
      verdict: "error",
      reason: "Reviewer completion must be an object.",
    };
  }
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

export function parseInitialReviewResult(
  value: unknown,
  options?: { allowRecommendationMarkdown?: boolean },
): { ok: true; result: InitialReviewResult } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "Initial review completion must be an object.",
    };
  }
  if (value.verdict === "approved") {
    if (
      Object.hasOwn(value, "findings") ||
      Object.hasOwn(value, "recommendationMarkdown")
    ) {
      return {
        ok: false,
        reason:
          "Initial approved review cannot include findings or recommendationMarkdown.",
      };
    }
    return { ok: true, result: { verdict: "approved" } };
  }
  if (value.verdict !== "changes_requested") {
    return {
      ok: false,
      reason: "Initial review verdict must be approved or changes_requested.",
    };
  }
  if (!Array.isArray(value.findings) || value.findings.length === 0) {
    return {
      ok: false,
      reason:
        "Initial changes_requested review must include non-empty findings.",
    };
  }
  const findings: ReviewFindingDraft[] = [];
  for (const finding of value.findings) {
    const parsed = parseFindingDraft(finding);
    if (!parsed) {
      return {
        ok: false,
        reason:
          "Each initial finding requires non-empty summary, evidence, requiredChange, and acceptanceCriteria.",
      };
    }
    findings.push(parsed);
  }
  let recommendationMarkdown: string | undefined;
  if (Object.hasOwn(value, "recommendationMarkdown")) {
    if (!options?.allowRecommendationMarkdown) {
      return {
        ok: false,
        reason: "recommendationMarkdown is allowed only for overall reviews.",
      };
    }
    if (!isNonEmptyString(value.recommendationMarkdown)) {
      return {
        ok: false,
        reason: "recommendationMarkdown must be a non-empty string.",
      };
    }
    recommendationMarkdown = value.recommendationMarkdown.trim();
  }
  return {
    ok: true,
    result: { verdict: "changes_requested", findings, recommendationMarkdown },
  };
}

export function parseAnchoredReviewResult(
  value: unknown,
  outstandingIds: readonly string[],
): { ok: true; result: AnchoredReviewResult } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "Anchored review completion must be an object.",
    };
  }
  if (!Array.isArray(value.assessments) || !Array.isArray(value.regressions)) {
    return {
      ok: false,
      reason:
        "Anchored review must include assessments and regressions arrays.",
    };
  }
  const assessments: FindingAssessment[] = [];
  for (const assessment of value.assessments) {
    if (
      !isRecord(assessment) ||
      !isNonEmptyString(assessment.id) ||
      (assessment.status !== "resolved" &&
        assessment.status !== "unresolved") ||
      !isNonEmptyString(assessment.evidence)
    ) {
      return {
        ok: false,
        reason:
          "Each anchored assessment requires an ID, status, and evidence.",
      };
    }
    assessments.push({
      id: assessment.id.trim(),
      status: assessment.status,
      evidence: assessment.evidence.trim(),
    });
  }
  try {
    validateAssessmentCoverage(outstandingIds, assessments);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const regressions: RegressionFindingDraft[] = [];
  for (const regression of value.regressions) {
    const draft = parseFindingDraft(regression);
    if (
      !draft ||
      !isRecord(regression) ||
      !Array.isArray(regression.changedPaths) ||
      regression.changedPaths.length === 0 ||
      !regression.changedPaths.every(isNonEmptyString) ||
      !isNonEmptyString(regression.causalEvidence)
    ) {
      return {
        ok: false,
        reason:
          "Each regression requires a finding, changedPaths, and causalEvidence.",
      };
    }
    regressions.push({
      ...draft,
      changedPaths: regression.changedPaths.map((path) => path.trim()),
      causalEvidence: regression.causalEvidence.trim(),
    });
  }
  const observations = Array.isArray(value.observations)
    ? value.observations.map(parseObservation)
    : undefined;
  if (observations?.some((observation) => observation === undefined)) {
    return {
      ok: false,
      reason: "Each observation requires non-empty summary and evidence.",
    };
  }
  return {
    ok: true,
    result: {
      assessments,
      regressions,
      observations: observations as ReviewObservation[] | undefined,
    },
  };
}

function parseFindingDraft(value: unknown): ReviewFindingDraft | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.summary) ||
    !isNonEmptyString(value.evidence) ||
    !isNonEmptyString(value.requiredChange) ||
    !Array.isArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.length === 0 ||
    !value.acceptanceCriteria.every(isNonEmptyString)
  ) {
    return undefined;
  }
  return {
    summary: value.summary.trim(),
    evidence: value.evidence.trim(),
    requiredChange: value.requiredChange.trim(),
    acceptanceCriteria: value.acceptanceCriteria.map((criterion) =>
      criterion.trim(),
    ),
  };
}

function parseObservation(value: unknown): ReviewObservation | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.summary) ||
    !isNonEmptyString(value.evidence)
  ) {
    return undefined;
  }
  return { summary: value.summary.trim(), evidence: value.evidence.trim() };
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
  value: unknown,
):
  | { ok: true; result: IntegrationSelfHealResult }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "Integration self-heal completion must be an object.",
    };
  }
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
  value: unknown,
): { ok: true; result: OverallReworkResult } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "Overall rework completion must be an object.",
    };
  }
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
  value: unknown,
):
  | { ok: true; result: SchedulerSelfHealResult }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "Scheduler self-heal completion must be an object.",
    };
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
