import type {
  FindingAdmissionBatch,
  FindingAssessment,
  FindingReworkCompletion,
  RegressionFindingDraft,
  ReviewFindingDraft,
  ReviewFindingProposal,
  ReviewObservation,
  DeferredConcernAssessment,
} from "./result-schemas.js";
import { validateAssessmentCoverage } from "./review-convergence.js";

export type VerificationStep = {
  command: string;
  result: string;
  rationale: string;
};

export type ParsedFindingReworkCompletion = FindingReworkCompletion & {
  verification: VerificationStep[];
};

export type ParsedImplementerResult =
  | {
      outcome: "changed";
      summary: string;
      verification: VerificationStep[];
      commitMessage: string;
      findingCompletions?: ParsedFindingReworkCompletion[];
    }
  | {
      outcome: "already_satisfied";
      summary: string;
      verification: VerificationStep[];
      commitMessage?: string;
      findingCompletions?: ParsedFindingReworkCompletion[];
    };

export type InitialReviewResult =
  | { verdict: "approved" }
  | {
      verdict: "changes_requested";
      findings: Array<ReviewFindingProposal & { proposalId: string }>;
      recommendationMarkdown?: string;
      deferredConcernAssessments?: DeferredConcernAssessment[];
    }
  | {
      verdict: "approved";
      deferredConcernAssessments?: DeferredConcernAssessment[];
    };

export type AdmissionResult = FindingAdmissionBatch;

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

export type IntegrationRecoveryResult = {
  disposition: "retry_validation" | "candidate_rework" | "blocked";
  summary: string;
  commands?: string[];
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
  findingCompletions?: ParsedFindingReworkCompletion[];
  commitMessage?: string;
};

export function parseImplementerResult(
  value: unknown,
  options?: { expectedFindingIds?: readonly string[] },
):
  | { ok: true; result: ParsedImplementerResult }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: "Implementer completion must be an object." };
  }
  return parseImplementerResultValue(value, options);
}

function parseImplementerResultValue(
  value: Record<string, unknown>,
  options?: { expectedFindingIds?: readonly string[] },
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

  const findingCompletions = parseFindingReworkCompletions(
    value.findingCompletions,
    options?.expectedFindingIds,
  );
  if (!findingCompletions.ok) {
    return findingCompletions;
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
        ...(findingCompletions.result.length > 0
          ? { findingCompletions: findingCompletions.result }
          : {}),
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
      ...(findingCompletions.result.length > 0
        ? { findingCompletions: findingCompletions.result }
        : {}),
    },
  };
}

export function parseInitialReviewResult(
  value: unknown,
  options?: {
    allowRecommendationMarkdown?: boolean;
    requireProposalBasis?: boolean;
    deferredConcernIds?: readonly string[];
  },
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
    const deferredConcernAssessments = parseDeferredConcernAssessments(
      value.deferredConcernAssessments,
      options?.deferredConcernIds,
    );
    if (!deferredConcernAssessments.ok) {
      return deferredConcernAssessments;
    }
    return {
      ok: true,
      result: {
        verdict: "approved",
        ...(deferredConcernAssessments.result.length > 0
          ? { deferredConcernAssessments: deferredConcernAssessments.result }
          : {}),
      },
    };
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
  const findings: Array<ReviewFindingProposal & { proposalId: string }> = [];
  const usedProposalIds = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    const parsed = parseFindingProposal(finding, options?.requireProposalBasis);
    if (!parsed) {
      return {
        ok: false,
        reason:
          "Each initial finding requires non-empty summary, evidence, requiredChange, acceptanceCriteria, and a grounded basis.",
      };
    }
    let proposalId = parsed.proposalId;
    if (!proposalId || usedProposalIds.has(proposalId)) {
      let ordinal = index + 1;
      do {
        proposalId = `P${ordinal++}`;
      } while (usedProposalIds.has(proposalId));
    }
    usedProposalIds.add(proposalId);
    findings.push({ ...parsed, proposalId: proposalId! });
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
  const deferredConcernAssessments = parseDeferredConcernAssessments(
    value.deferredConcernAssessments,
    options?.deferredConcernIds,
    findings.map((finding) => finding.proposalId),
  );
  if (!deferredConcernAssessments.ok) {
    return deferredConcernAssessments;
  }
  return {
    ok: true,
    result: {
      verdict: "changes_requested",
      findings,
      recommendationMarkdown,
      ...(deferredConcernAssessments.result.length > 0
        ? { deferredConcernAssessments: deferredConcernAssessments.result }
        : {}),
    },
  };
}

function parseDeferredConcernAssessments(
  value: unknown,
  expectedIds: readonly string[] | undefined,
  proposalIds: readonly string[] = [],
):
  | { ok: true; result: DeferredConcernAssessment[] }
  | { ok: false; reason: string } {
  if (expectedIds === undefined) {
    if (value !== undefined) {
      return {
        ok: false,
        reason: "Deferred concern assessments are not allowed for this review.",
      };
    }
    return { ok: true, result: [] };
  }
  if (!Array.isArray(value)) {
    return expectedIds.length === 0
      ? { ok: true, result: [] }
      : {
          ok: false,
          reason: "Overall review must assess every supplied deferred concern.",
        };
  }
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  const assessments: DeferredConcernAssessment[] = [];
  for (const assessment of value) {
    if (
      !isRecord(assessment) ||
      !isNonEmptyString(assessment.id) ||
      ![
        "not_reproducible",
        "covered_by_proposal",
        "observed_non_blocking",
      ].includes(String(assessment.status)) ||
      !isNonEmptyString(assessment.evidence)
    ) {
      return {
        ok: false,
        reason:
          "Each deferred concern assessment requires an ID, status, and evidence.",
      };
    }
    const id = assessment.id.trim();
    if (!expected.has(id) || seen.has(id)) {
      return {
        ok: false,
        reason: `Overall review deferred concern coverage includes unknown or duplicate ID: ${id}`,
      };
    }
    const proposalId = isNonEmptyString(assessment.proposalId)
      ? assessment.proposalId.trim()
      : undefined;
    if (assessment.status === "covered_by_proposal") {
      if (!proposalId || !proposalIds.includes(proposalId)) {
        return {
          ok: false,
          reason: `Deferred concern ${id} must link to a proposal in this completion.`,
        };
      }
    } else if (proposalId) {
      return {
        ok: false,
        reason: `Deferred concern ${id} may link a proposal only when covered_by_proposal.`,
      };
    }
    seen.add(id);
    assessments.push({
      id,
      status: assessment.status as DeferredConcernAssessment["status"],
      ...(proposalId ? { proposalId } : {}),
      evidence: assessment.evidence.trim(),
    });
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Overall review omitted deferred concern IDs: ${missing.join(", ")}`,
    };
  }
  return { ok: true, result: assessments };
}

export function parseAdmissionResult(
  value: unknown,
): { ok: true; result: AdmissionResult } | { ok: false; reason: string } {
  if (!isRecord(value) || !isNonEmptyString(value.proposalBatchId)) {
    return {
      ok: false,
      reason: "Admission completion must include proposalBatchId.",
    };
  }
  if (!Array.isArray(value.dispositions)) {
    return {
      ok: false,
      reason: "Admission completion must include dispositions.",
    };
  }
  const dispositions: AdmissionResult["dispositions"] = [];
  for (const disposition of value.dispositions) {
    if (
      !isRecord(disposition) ||
      !isNonEmptyString(disposition.proposalId) ||
      !["admit", "defer", "demote", "reject"].includes(
        String(disposition.disposition),
      ) ||
      !["certain", "uncertain"].includes(String(disposition.certainty)) ||
      !isNonEmptyString(disposition.rationale)
    ) {
      return {
        ok: false,
        reason:
          "Each admission disposition requires proposalId, disposition, certainty, and rationale.",
      };
    }
    dispositions.push({
      proposalId: disposition.proposalId.trim(),
      disposition:
        disposition.disposition as AdmissionResult["dispositions"][number]["disposition"],
      certainty:
        disposition.certainty as AdmissionResult["dispositions"][number]["certainty"],
      rationale: disposition.rationale.trim(),
    });
  }
  return {
    ok: true,
    result: { proposalBatchId: value.proposalBatchId.trim(), dispositions },
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

function parseFindingProposal(
  value: unknown,
  requireBasis = false,
): ReviewFindingProposal | undefined {
  const draft = parseFindingDraft(value);
  if (!draft || !isRecord(value)) {
    return undefined;
  }
  if (!isRecord(value.basis)) {
    return requireBasis
      ? undefined
      : {
          ...draft,
          basis: {
            kind: "correctness_invariant",
            invariant:
              "Legacy initial review finding without a structured basis.",
          },
        };
  }
  const proposalId = isNonEmptyString(value.proposalId)
    ? value.proposalId.trim()
    : undefined;
  if (
    value.basis.kind === "requirement" &&
    Array.isArray(value.basis.requirementIds) &&
    value.basis.requirementIds.length > 0 &&
    value.basis.requirementIds.every(isNonEmptyString)
  ) {
    return {
      ...draft,
      proposalId,
      basis: {
        kind: "requirement",
        requirementIds: value.basis.requirementIds.map((id) => id.trim()),
      },
    };
  }
  if (
    value.basis.kind === "candidate_regression" &&
    Array.isArray(value.basis.changedPaths) &&
    value.basis.changedPaths.length > 0 &&
    value.basis.changedPaths.every(isNonEmptyString) &&
    isNonEmptyString(value.basis.causalEvidence)
  ) {
    return {
      ...draft,
      proposalId,
      basis: {
        kind: "candidate_regression",
        changedPaths: value.basis.changedPaths.map((path) => path.trim()),
        causalEvidence: value.basis.causalEvidence.trim(),
      },
    };
  }
  if (
    value.basis.kind === "correctness_invariant" &&
    isNonEmptyString(value.basis.invariant)
  ) {
    return {
      ...draft,
      proposalId,
      basis: {
        kind: "correctness_invariant",
        invariant: value.basis.invariant.trim(),
      },
    };
  }
  return undefined;
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

export function parseIntegrationRecoveryResult(
  value: unknown,
):
  | { ok: true; result: IntegrationRecoveryResult }
  | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: "Integration recovery completion must be an object.",
    };
  }
  const disposition = value.disposition;
  if (
    disposition !== "retry_validation" &&
    disposition !== "candidate_rework" &&
    disposition !== "blocked"
  ) {
    return {
      ok: false,
      reason: "Integration recovery result has an invalid disposition.",
    };
  }
  if (!isNonEmptyString(value.summary)) {
    return {
      ok: false,
      reason: "Integration recovery result is missing summary.",
    };
  }
  return {
    ok: true,
    result: {
      disposition,
      summary: value.summary,
      commands: Array.isArray(value.commands)
        ? value.commands.filter(
            (command): command is string => typeof command === "string",
          )
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
  options?: { expectedFindingIds?: readonly string[] },
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

  const findingCompletions = parseFindingReworkCompletions(
    value.findingCompletions,
    options?.expectedFindingIds,
  );
  if (!findingCompletions.ok) {
    return findingCompletions;
  }
  return {
    ok: true,
    result: {
      summary,
      verification: steps,
      commitMessage:
        typeof commitMessage === "string" ? commitMessage.trim() : undefined,
      ...(findingCompletions.result.length > 0
        ? { findingCompletions: findingCompletions.result }
        : {}),
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

export function validateFindingCoverage(
  expectedIds: readonly string[],
  completions: readonly { id: string }[],
  stage: string,
): void {
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  for (const completion of completions) {
    if (!expected.has(completion.id)) {
      throw new Error(`${stage} includes unknown finding ID: ${completion.id}`);
    }
    if (seen.has(completion.id)) {
      throw new Error(
        `${stage} includes finding ID more than once: ${completion.id}`,
      );
    }
    seen.add(completion.id);
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`${stage} omitted finding IDs: ${missing.join(", ")}`);
  }
}

function parseFindingReworkCompletions(
  value: unknown,
  expectedIds: readonly string[] | undefined,
):
  | { ok: true; result: ParsedFindingReworkCompletion[] }
  | { ok: false; reason: string } {
  if (expectedIds === undefined && value === undefined) {
    return { ok: true, result: [] };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason:
        "Rework JSON must include findingCompletions for every outstanding finding.",
    };
  }
  const completions: ParsedFindingReworkCompletion[] = [];
  for (const completion of value) {
    if (
      !isRecord(completion) ||
      !isNonEmptyString(completion.id) ||
      (completion.status !== "addressed" &&
        completion.status !== "not_addressed") ||
      !isNonEmptyString(completion.evidence) ||
      !Array.isArray(completion.changedPaths) ||
      !completion.changedPaths.every(isNonEmptyString) ||
      !Array.isArray(completion.verification) ||
      completion.verification.length === 0
    ) {
      return {
        ok: false,
        reason:
          "Each finding completion requires an ID, status, evidence, changedPaths, and verification.",
      };
    }
    const verification = parseVerificationSteps(completion.verification);
    if (!verification.ok) {
      return verification;
    }
    if (
      completion.status === "addressed" &&
      completion.changedPaths.length === 0 &&
      !/\b(no (source )?change|no code change|existing (behavior|implementation)|already (satisfied|correct)|verification only)\b/i.test(
        completion.evidence,
      )
    ) {
      return {
        ok: false,
        reason:
          "An addressed completion without changedPaths must explain why no source change was necessary.",
      };
    }
    completions.push({
      id: completion.id.trim(),
      status: completion.status,
      evidence: completion.evidence.trim(),
      changedPaths: completion.changedPaths.map((path) => path.trim()),
      verification: verification.result,
    });
  }
  if (expectedIds !== undefined) {
    try {
      validateFindingCoverage(expectedIds, completions, "Rework completion");
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: true, result: completions };
}

function parseVerificationSteps(
  value: unknown[],
): { ok: true; result: VerificationStep[] } | { ok: false; reason: string } {
  const steps: VerificationStep[] = [];
  for (const step of value) {
    if (
      !isRecord(step) ||
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
      command: step.command.trim(),
      result: step.result.trim(),
      rationale: step.rationale.trim(),
    });
  }
  return { ok: true, result: steps };
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
