import type {
  FindingAssessment,
  RegressionFindingDraft,
  ReviewFindingDraft,
  ReviewFindingProposal,
  ReviewObservation,
} from "./result-schemas.js";

export type ReviewFinding = ReviewFindingDraft & {
  proposalId?: string;
  basis?: ReviewFindingProposal["basis"];
  id: string;
  introducedRound: number;
  origin: "initial" | "regression";
};

export type ReviewConvergenceState = {
  round: number;
  findings: ReviewFinding[];
  outstandingIds: string[];
  bestOutstandingCount: number;
  consecutiveStalledRounds: number;
};

export type ReviewConvergenceOutcome = "approved" | "continue" | "stalled";

export type AnchoredReviewInput = {
  assessments: FindingAssessment[];
  regressions: RegressionFindingDraft[];
  observations?: ReviewObservation[];
};

export type AnchoredReviewUpdate = {
  state: ReviewConvergenceState;
  outcome: ReviewConvergenceOutcome;
  observations: ReviewObservation[];
};

export function applyNoopReview(state: ReviewConvergenceState): {
  state: ReviewConvergenceState;
  outcome: Exclude<ReviewConvergenceOutcome, "approved">;
} {
  const nextState: ReviewConvergenceState = {
    ...state,
    round: state.round + 1,
    consecutiveStalledRounds: state.consecutiveStalledRounds + 1,
  };
  return {
    state: nextState,
    outcome: nextState.consecutiveStalledRounds >= 2 ? "stalled" : "continue",
  };
}

export function createReviewConvergenceState(args: {
  drafts: Array<ReviewFindingDraft & { proposalId?: string }>;
  idPrefix?: string;
}): ReviewConvergenceState {
  const findings = allocateFindings({
    drafts: args.drafts,
    idPrefix: args.idPrefix,
    introducedRound: 0,
    origin: "initial",
  });
  return {
    round: 0,
    findings,
    outstandingIds: findings.map((finding) => finding.id),
    bestOutstandingCount: findings.length,
    consecutiveStalledRounds: 0,
  };
}

export function openRegressionReviewEpoch(args: {
  closedState: ReviewConvergenceState;
  regressions: RegressionFindingDraft[];
  latestDeltaPaths: readonly string[];
  idPrefix?: string;
}): { state: ReviewConvergenceState; observations: ReviewObservation[] } {
  if (args.closedState.outstandingIds.length > 0) {
    throw new Error(
      "A regression-only epoch requires an approved prior epoch.",
    );
  }
  const { qualifyingRegressions, demotedObservations } = qualifyRegressions(
    args.regressions,
    args.latestDeltaPaths,
  );
  const newFindings = allocateFindings({
    drafts: qualifyingRegressions,
    idPrefix: args.idPrefix,
    introducedRound: 0,
    origin: "regression",
    existingFindings: args.closedState.findings,
  });
  return {
    state: {
      round: 0,
      findings: [...args.closedState.findings, ...newFindings],
      outstandingIds: newFindings.map((finding) => finding.id),
      bestOutstandingCount: newFindings.length,
      consecutiveStalledRounds: 0,
    },
    observations: demotedObservations,
  };
}

export function applyAnchoredReview(args: {
  state: ReviewConvergenceState;
  review: AnchoredReviewInput;
  latestDeltaPaths: readonly string[];
  idPrefix?: string;
}): AnchoredReviewUpdate {
  validateAssessmentCoverage(
    args.state.outstandingIds,
    args.review.assessments,
  );

  const assessmentsById = new Map(
    args.review.assessments.map((assessment) => [assessment.id, assessment]),
  );
  const unresolvedIds = new Set(
    args.review.assessments
      .filter((assessment) => assessment.status === "unresolved")
      .map((assessment) => assessment.id),
  );
  const { qualifyingRegressions, demotedObservations } = qualifyRegressions(
    args.review.regressions,
    args.latestDeltaPaths,
  );
  const round = args.state.round + 1;
  const findings = [
    ...args.state.findings.map((finding) => ({
      ...finding,
      evidence: assessmentsById.get(finding.id)?.evidence ?? finding.evidence,
    })),
    ...allocateFindings({
      drafts: qualifyingRegressions,
      idPrefix: args.idPrefix,
      introducedRound: round,
      origin: "regression",
      existingFindings: args.state.findings,
    }),
  ];
  const outstandingIds = [
    ...args.state.outstandingIds.filter((id) => unresolvedIds.has(id)),
    ...findings.slice(args.state.findings.length).map((finding) => finding.id),
  ];
  const outstandingCount = outstandingIds.length;
  const hasNewLow = outstandingCount < args.state.bestOutstandingCount;
  const state: ReviewConvergenceState = {
    round,
    findings,
    outstandingIds,
    bestOutstandingCount: hasNewLow
      ? outstandingCount
      : args.state.bestOutstandingCount,
    consecutiveStalledRounds: hasNewLow
      ? 0
      : args.state.consecutiveStalledRounds + 1,
  };
  return {
    state,
    outcome:
      outstandingCount === 0
        ? "approved"
        : state.consecutiveStalledRounds >= 2
          ? "stalled"
          : "continue",
    observations: [...(args.review.observations ?? []), ...demotedObservations],
  };
}

function qualifyRegressions(
  regressions: readonly RegressionFindingDraft[],
  latestDeltaPaths: readonly string[],
): {
  qualifyingRegressions: RegressionFindingDraft[];
  demotedObservations: ReviewObservation[];
} {
  const qualifyingRegressions = regressions.filter((regression) =>
    regression.changedPaths.some((path) => latestDeltaPaths.includes(path)),
  );
  return {
    qualifyingRegressions,
    demotedObservations: regressions
      .filter((regression) => !qualifyingRegressions.includes(regression))
      .map(({ summary, evidence }) => ({ summary, evidence })),
  };
}

export function validateAssessmentCoverage(
  outstandingIds: readonly string[],
  assessments: readonly FindingAssessment[],
): void {
  const expected = new Set(outstandingIds);
  const seen = new Set<string>();
  for (const assessment of assessments) {
    if (!expected.has(assessment.id)) {
      throw new Error(
        `Anchored review assessed unknown finding ID: ${assessment.id}`,
      );
    }
    if (seen.has(assessment.id)) {
      throw new Error(
        `Anchored review assessed finding ID more than once: ${assessment.id}`,
      );
    }
    seen.add(assessment.id);
  }
  const missing = outstandingIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Anchored review omitted finding IDs: ${missing.join(", ")}`,
    );
  }
}

function allocateFindings(args: {
  drafts: ReviewFindingDraft[];
  idPrefix?: string;
  introducedRound: number;
  origin: ReviewFinding["origin"];
  existingFindings?: readonly ReviewFinding[];
}): ReviewFinding[] {
  const prefix = args.idPrefix ?? "R";
  const nextNumber =
    (args.existingFindings ?? []).reduce(
      (maximum, finding) => Math.max(maximum, idNumber(finding.id, prefix)),
      0,
    ) + 1;
  return args.drafts.map((draft, index) => ({
    ...draft,
    id: `${prefix}${nextNumber + index}`,
    introducedRound: args.introducedRound,
    origin: args.origin,
  }));
}

function idNumber(id: string, prefix: string): number {
  const number = Number(id.slice(prefix.length));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
