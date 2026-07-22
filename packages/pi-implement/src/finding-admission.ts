import { createHash } from "node:crypto";
import type {
  FindingAdmissionBatch,
  ReviewFindingDraft,
  ReviewFindingProposal,
  ReviewObservation,
} from "./result-schemas.js";

export type FindingAdmissionScope = "task" | "overall" | "integration";

export type EffectiveFindingAdmission = {
  proposalId: string;
  disposition: "admit" | "defer" | "demote" | "reject";
  certainty: "certain" | "uncertain";
  rationale: string;
  fallbackReason?: string;
};

export type FindingAdmissionEvaluation = {
  proposalBatchId: string;
  admissions: EffectiveFindingAdmission[];
  admittedDrafts: Array<ReviewFindingDraft & { proposalId: string }>;
  deferredConcerns: Array<ReviewFindingProposal & { proposalId: string }>;
  observations: ReviewObservation[];
  rejected: Array<ReviewFindingProposal & { proposalId: string }>;
  fallbackReason?: string;
};

export function createProposalBatchId(args: {
  scope: FindingAdmissionScope;
  contextId: string;
  candidateIdentity: string;
  latestDeltaPaths: readonly string[];
  proposals: readonly (ReviewFindingProposal & { proposalId: string })[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scope: args.scope,
        contextId: args.contextId,
        candidateIdentity: args.candidateIdentity,
        latestDeltaPaths: [...args.latestDeltaPaths].sort(),
        proposals: args.proposals,
      }),
    )
    .digest("hex");
}

export function evaluateFindingAdmission(args: {
  scope: FindingAdmissionScope;
  proposalBatchId: string;
  proposals: readonly (ReviewFindingProposal & { proposalId: string })[];
  knownRequirementIds: readonly string[];
  adjudication?: FindingAdmissionBatch;
  failureReason?: string;
}): FindingAdmissionEvaluation {
  const allFallback = args.failureReason
    ? args.failureReason
    : !args.adjudication
      ? "Adjudication did not produce a usable completion."
      : args.adjudication.proposalBatchId !== args.proposalBatchId
        ? "Adjudication proposal batch ID did not match the supplied batch."
        : undefined;
  const knownIds = new Set(
    args.proposals.map((proposal) => proposal.proposalId),
  );
  const adjudications = args.adjudication?.dispositions ?? [];
  const counts = new Map<string, number>();
  for (const disposition of adjudications) {
    counts.set(
      disposition.proposalId,
      (counts.get(disposition.proposalId) ?? 0) + 1,
    );
  }
  const hasUnknownId = adjudications.some(
    (disposition) => !knownIds.has(disposition.proposalId),
  );
  const fallbackReason =
    allFallback ??
    (hasUnknownId
      ? "Adjudication included an unknown proposal ID."
      : undefined);
  const knownRequirements = new Set(args.knownRequirementIds);
  const dispositionsById = new Map(
    adjudications.map((disposition) => [disposition.proposalId, disposition]),
  );
  const admissions = args.proposals.map((proposal) => {
    const disposition = dispositionsById.get(proposal.proposalId);
    const missingOrDuplicate = (counts.get(proposal.proposalId) ?? 0) !== 1;
    const unknownRequirement =
      proposal.basis.kind === "requirement" &&
      proposal.basis.requirementIds.some((id) => !knownRequirements.has(id));
    if (fallbackReason || missingOrDuplicate || !disposition) {
      return admit(
        proposal.proposalId,
        fallbackReason ??
          "Adjudication did not cover this proposal exactly once.",
      );
    }
    if (disposition.certainty === "uncertain") {
      return admit(
        proposal.proposalId,
        `Adjudicator marked this proposal uncertain: ${disposition.rationale}`,
        "uncertain",
      );
    }
    if (unknownRequirement) {
      return admit(
        proposal.proposalId,
        "Proposal references an unknown requirement ID.",
      );
    }
    return {
      ...disposition,
      disposition:
        args.scope === "overall" && disposition.disposition === "defer"
          ? "admit"
          : disposition.disposition,
      ...(args.scope === "overall" && disposition.disposition === "defer"
        ? { fallbackReason: "Overall review concerns cannot be deferred." }
        : {}),
    };
  });
  const byId = new Map(
    args.proposals.map((proposal) => [proposal.proposalId, proposal]),
  );
  return {
    proposalBatchId: args.proposalBatchId,
    admissions,
    admittedDrafts: admissions
      .filter((entry) => entry.disposition === "admit")
      .map((entry) => {
        const proposal = byId.get(entry.proposalId)!;
        return {
          proposalId: proposal.proposalId,
          summary: proposal.summary,
          evidence: proposal.evidence,
          requiredChange: proposal.requiredChange,
          acceptanceCriteria: proposal.acceptanceCriteria,
          basis: proposal.basis,
        };
      }),
    deferredConcerns: admissions
      .filter((entry) => entry.disposition === "defer")
      .map((entry) => byId.get(entry.proposalId)!),
    observations: admissions
      .filter((entry) => entry.disposition === "demote")
      .map((entry) => {
        const proposal = byId.get(entry.proposalId)!;
        return { summary: proposal.summary, evidence: proposal.evidence };
      }),
    rejected: admissions
      .filter((entry) => entry.disposition === "reject")
      .map((entry) => byId.get(entry.proposalId)!),
    fallbackReason,
  };
}

function admit(
  proposalId: string,
  rationale: string,
  certainty: "certain" | "uncertain" = "certain",
): EffectiveFindingAdmission {
  return {
    proposalId,
    disposition: "admit",
    certainty,
    rationale,
    fallbackReason: rationale,
  };
}
