import { join, resolve } from "node:path";
import { stagingIdentity } from "./candidate-replay.js";
import { checkoutPaths, type RunState } from "./store.js";

const MAX_RETAINED_TEXT = 12_000;
const MAX_COMPLETED_RECEIPT = 3_500;
const MAX_EXCERPT = 280;
const MAX_LIST_ITEMS = 4;

type Delivery = {
  workstreamId: string;
  kind: "publication" | "satisfaction";
  candidateId: string;
  targetSha: string;
  at: string;
  receiptId: string;
};

type Workstream =
  | { kind: "source"; id: string }
  | { kind: "overall"; repairId: string };

export function renderTerminalHandoff(state: RunState): string {
  if (state.phase === "completed") {
    return renderCompleted(state);
  }
  if (state.phase === "incomplete" || state.phase === "failed") {
    return renderRetained(state);
  }
  throw new Error(
    "Terminal handoffs require a completed, incomplete, or failed run.",
  );
}

function renderCompleted(state: RunState): string {
  const handoffDraft = state.wholePlanReview.handoffDraft;
  if (!handoffDraft) {
    throw new Error(
      "Completed runs require an accepted whole-plan handoff draft.",
    );
  }
  const deliveries = deliveredSourceWorkstreams(state);
  const finalFindings = canonicalWholePlanFindings(state);
  const receipt = [
    "## Delivery receipt",
    `Run ID: ${excerpt(state.run.id)}`,
    `Target branch: ${excerpt(state.run.checkout.branchRef)}`,
    `Final published head: ${lastProvenPublishedHead(state)}`,
    `Source workstreams proven delivered: ${deliveries.length}`,
    ...renderList(
      "Delivered source workstreams",
      deliveries.map(formatDelivery),
      3,
    ),
    ...renderList(
      "Retained verification",
      verificationEvidence(state).map((value) =>
        redactCompletedWorkspaceLocations(state, value),
      ),
      3,
    ),
    `Material final residual whole-plan findings: ${finalFindings.length > 0 ? "yes" : "no"}`,
    ...renderList(
      "Canonical final whole-plan findings",
      finalFindings.map((finding) =>
        redactCompletedWorkspaceLocations(state, formatFinding(finding)),
      ),
      3,
    ),
    `Durable evidence: /implement inspect ${state.run.id}`,
  ].join("\n");
  return `${handoffDraft}\n\n${truncateReceipt(receipt)}`;
}

function renderRetained(state: RunState): string {
  const deliveries = deliveredSourceWorkstreams(state);
  const { category, reason } = terminalReason(state);
  const output = [
    `Implement run ${state.run.id} · ${state.phase}`,
    `Terminal category: ${category}`,
    `Terminal reason: ${excerpt(reason)}`,
    `Target branch: ${excerpt(state.run.checkout.branchRef)}`,
    `Last proven published head: ${lastProvenPublishedHead(state)}`,
    ...renderList(
      "Source workstreams proven delivered",
      deliveries.map(formatDelivery),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Failed workstreams",
      terminalWorkstreams(state, "failed"),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Dependency-skipped workstreams",
      terminalWorkstreams(state, "dependency_skipped"),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Unpublished candidates and undelivered workstreams",
      unpublishedSourceWork(state),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Retained failure evidence",
      failureEvidence(state),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Open source findings",
      openFindings(state, "source").map(formatFinding),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Open whole-plan findings",
      openFindings(state, "whole_plan").map(formatFinding),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Retained owned workspace locations",
      retainedWorkspaceLocations(state),
      MAX_LIST_ITEMS,
    ),
    ...renderList(
      "Retained verification",
      verificationEvidence(state),
      MAX_LIST_ITEMS,
    ),
    ...renderList("Uncertainty", uncertaintyEvidence(state), MAX_LIST_ITEMS),
  ].join("\n");
  const commands = [
    `Inspect durable evidence: /implement inspect ${state.run.id}`,
    `Clean retained resources: /implement cleanup ${state.run.id}`,
  ].join("\n");
  return `${truncate(output, MAX_RETAINED_TEXT - commands.length - 1)}\n${commands}`;
}

function deliveredSourceWorkstreams(state: RunState): Delivery[] {
  const deliveries = new Map<string, Delivery>();
  for (const receipt of Object.values(state.publication.receipts)) {
    const candidate = state.candidates[receipt.candidateId];
    if (candidate?.workstream.kind !== "source") {
      continue;
    }
    chooseDelivery(deliveries, {
      workstreamId: candidate.workstream.id,
      kind: "publication",
      candidateId: candidate.id,
      targetSha: receipt.publishedCommitSha,
      at: receipt.publishedAt,
      receiptId: receipt.intentId,
    });
  }
  for (const receipt of Object.values(state.satisfaction.receipts)) {
    chooseDelivery(deliveries, {
      workstreamId: receipt.workstream.id,
      kind: "satisfaction",
      candidateId: receipt.candidateId,
      targetSha: receipt.assessedTargetSha,
      at: receipt.assessedAt,
      receiptId: receipt.id,
    });
  }
  return [...deliveries.values()].sort((left, right) =>
    compare(left.workstreamId, right.workstreamId),
  );
}

function chooseDelivery(
  deliveries: Map<string, Delivery>,
  next: Delivery,
): void {
  const current = deliveries.get(next.workstreamId);
  if (!current || compareDelivery(current, next) < 0) {
    deliveries.set(next.workstreamId, next);
  }
}

function compareDelivery(left: Delivery, right: Delivery): number {
  return (
    compare(left.at, right.at) ||
    compare(left.kind, right.kind) ||
    compare(left.receiptId, right.receiptId)
  );
}

function lastProvenPublishedHead(state: RunState): string {
  const intents = Object.values(state.publication.intents);
  for (const intent of [...intents].reverse()) {
    const receipt = state.publication.receipts[intent.id];
    if (receipt) {
      return excerpt(receipt.publishedCommitSha);
    }
    const supersession = state.publication.supersessions[intent.id];
    if (supersession) {
      return excerpt(supersession.actualTargetSha);
    }
    if (state.publication.abandonments[intent.id]) {
      return excerpt(intent.targetBaseSha);
    }
    return excerpt(intent.targetBaseSha);
  }

  const receipts = Object.values(state.publication.receipts).sort(
    (left, right) => compare(left.intentId, right.intentId),
  );
  if (receipts.length > 0) {
    return excerpt(receipts.at(-1)!.publishedCommitSha);
  }
  const supersessions = Object.values(state.publication.supersessions).sort(
    (left, right) => compare(left.intentId, right.intentId),
  );
  if (supersessions.length > 0) {
    return excerpt(supersessions.at(-1)!.actualTargetSha);
  }
  const abandonments = Object.values(state.publication.abandonments).sort(
    (left, right) => compare(left.intentId, right.intentId),
  );
  if (abandonments.length > 0) {
    return excerpt(abandonments.at(-1)!.targetBaseSha);
  }
  return `${excerpt(state.run.checkout.startHead)} (no ref advancement is proven)`;
}

function terminalReason(state: RunState): { category: string; reason: string } {
  if (state.failure) {
    return { category: state.failure.category, reason: state.failure.reason };
  }
  const retry = exhaustedWholePlanReviewRetry(state);
  if (state.phase === "incomplete" && retry) {
    return {
      category: "whole_plan_review_retry_exhausted",
      reason: `Whole-plan review retry exhausted after ${retry.attempts} attempts.`,
    };
  }
  const latestFailure = Object.values(state.failures)
    .sort(
      (left, right) => compare(left.at, right.at) || compare(left.id, right.id),
    )
    .at(-1);
  if (latestFailure) {
    return { category: latestFailure.category, reason: latestFailure.evidence };
  }
  return {
    category: state.phase,
    reason:
      state.phase === "incomplete"
        ? "No further safe work remained."
        : "The run ended without a retained failure record.",
  };
}

function unpublishedSourceWork(state: RunState): string[] {
  const receiptCandidateIds = new Set([
    ...Object.values(state.publication.receipts).map(
      (receipt) => receipt.candidateId,
    ),
    ...Object.values(state.satisfaction.receipts).map(
      (receipt) => receipt.candidateId,
    ),
  ]);
  const deliveredWorkstreamIds = new Set(
    deliveredSourceWorkstreams(state).map((delivery) => delivery.workstreamId),
  );
  const candidateWorkstreams = new Set<string>();
  const candidates = Object.values(state.candidates).flatMap((candidate) => {
    if (
      candidate.workstream.kind !== "source" ||
      receiptCandidateIds.has(candidate.id)
    ) {
      return [];
    }
    candidateWorkstreams.add(candidate.workstream.id);
    return [
      `source:${candidate.workstream.id} · candidate:${candidate.id} · unpublished / not delivered (no publication or satisfaction receipt)`,
    ];
  });
  const withoutCandidates = Object.values(state.workstreams.source)
    .filter(
      (workstream) =>
        !candidateWorkstreams.has(workstream.id) &&
        !deliveredWorkstreamIds.has(workstream.id) &&
        workstream.phase !== "failed" &&
        workstream.phase !== "dependency_skipped",
    )
    .map(
      (workstream) =>
        `source:${workstream.id} · no retained candidate · not delivered (no publication or satisfaction receipt)`,
    );
  return [...candidates, ...withoutCandidates].sort(compare);
}

function terminalWorkstreams(
  state: RunState,
  phase: "failed" | "dependency_skipped",
): string[] {
  const source = Object.values(state.workstreams.source)
    .filter((workstream) => workstream.phase === phase)
    .map((workstream) => `source:${workstream.id}`);
  if (phase === "dependency_skipped") {
    return source.sort(compare);
  }
  return [
    ...source,
    ...Object.values(state.workstreams.overall)
      .filter((workstream) => workstream.phase === "failed")
      .map((workstream) => `overall:${workstream.repairId}`),
  ].sort(compare);
}

function canonicalWholePlanFindings(
  state: RunState,
): RunState["findings"][string][] {
  return (state.wholePlanReview.epoch?.findingIds ?? [])
    .flatMap((id) => {
      const finding = state.findings[id];
      return finding?.status === "open" ? [finding] : [];
    })
    .sort(compareFindings);
}

function openFindings(
  state: RunState,
  scope: "source" | "whole_plan",
): RunState["findings"][string][] {
  return Object.values(state.findings)
    .filter(
      (finding) => finding.status === "open" && finding.scope.kind === scope,
    )
    .sort(compareFindings);
}

function compareFindings(
  left: RunState["findings"][string],
  right: RunState["findings"][string],
): number {
  return (
    compare(left.id, right.id) || left.introducedRound - right.introducedRound
  );
}

type WorkspaceLocation = { label: string; path: string };

function retainedWorkspaceLocations(state: RunState): string[] {
  return workspaceLocations(state).map(
    (location) => `${location.label} · ${location.path}`,
  );
}

function workspaceLocations(state: RunState): WorkspaceLocation[] {
  const worktrees = checkoutPaths(state.run.checkout.root).worktrees;
  const locations: WorkspaceLocation[] = [
    ...Object.values(state.candidates).map((candidate) => {
      const id =
        candidate.workstream.kind === "source"
          ? candidate.workstream.id
          : candidate.workstream.repairId;
      return {
        label: `candidate:${candidate.id}`,
        path: join(worktrees, state.run.id, id),
      };
    }),
    ...Object.values(state.publication.preparations).map((preparation) => ({
      label: `publication staging:${preparation.id}`,
      path: preparation.stagingWorktree,
    })),
    ...Object.values(state.satisfaction.assessments).flatMap((assessment) => {
      const candidate = state.candidates[assessment.candidateId];
      if (!candidate || !assessment.operationId) {
        return [];
      }
      const staging = stagingIdentity({
        runId: state.run.id,
        operationId: assessment.operationId,
        candidateId: candidate.id,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        targetBaseSha: assessment.targetSha,
        targetRef: state.run.checkout.branchRef,
      });
      return [
        {
          label: `satisfaction staging:${assessment.id}`,
          path: join(worktrees, state.run.id, staging.id),
        },
      ];
    }),
  ].sort(
    (left, right) =>
      compare(left.path, right.path) || compare(left.label, right.label),
  );
  const unique = new Map<string, WorkspaceLocation>();
  for (const location of locations) {
    unique.set(resolve(location.path), location);
  }
  return [...unique.values()].sort(
    (left, right) =>
      compare(left.path, right.path) || compare(left.label, right.label),
  );
}

function redactCompletedWorkspaceLocations(
  state: RunState,
  value: string,
): string {
  return workspaceLocations(state)
    .map((location) => location.path)
    .sort((left, right) => right.length - left.length || compare(left, right))
    .reduce(
      (redacted, location) =>
        redacted.split(location).join("[released workspace]"),
      value,
    );
}

function failureEvidence(state: RunState): string[] {
  const failures = Object.values(state.failures)
    .sort(
      (left, right) => compare(left.at, right.at) || compare(left.id, right.id),
    )
    .map((failure) => {
      const command = failure.command
        ? ` · command: ${failure.command.output}`
        : "";
      return `${workstreamName(failure.workstream)} · ${failure.category} · ${failure.evidence}${command}`;
    });
  const retry = exhaustedWholePlanReviewRetry(state);
  return retry
    ? [
        ...retry.evidence.map(
          (evidence) => `whole-plan review retry · ${evidence}`,
        ),
        ...failures,
      ]
    : failures;
}

function exhaustedWholePlanReviewRetry(
  state: RunState,
): NonNullable<RunState["wholePlanReview"]["reviewRetry"]> | undefined {
  const retry = state.wholePlanReview.reviewRetry;
  return retry?.status === "exhausted" ? retry : undefined;
}

function verificationEvidence(state: RunState): string[] {
  return uniqueSorted([
    ...Object.values(state.candidates).flatMap((candidate) =>
      (candidate.implementationEvidence?.verification ?? []).map(
        (verification) => `candidate:${candidate.id} · ${verification}`,
      ),
    ),
    ...Object.entries(state.reviews).flatMap(([workstream, review]) =>
      (review.latestCorrection?.verification ?? []).map(
        (verification) => `${workstream} correction · ${verification}`,
      ),
    ),
    ...(state.wholePlanReview.evidence
      ? [`whole-plan review · ${state.wholePlanReview.evidence}`]
      : []),
  ]);
}

function uncertaintyEvidence(state: RunState): string[] {
  const publication = uniqueSorted([
    ...Object.values(state.failures)
      .filter((failure) => failure.category === "publication_uncertain")
      .map((failure) => `publication · ${failure.evidence}`),
    ...(state.failure?.category === "publication_uncertain"
      ? [`publication · ${state.failure.reason}`]
      : []),
    ...Object.values(state.publication.intents)
      .filter(
        (intent) =>
          !state.publication.receipts[intent.id] &&
          !state.publication.supersessions[intent.id] &&
          !state.publication.abandonments[intent.id],
      )
      .map(
        (intent) =>
          `publication · intent ${intent.id} has no durable settlement; target write outcome is uncertain.`,
      ),
  ]);
  return [
    ...publication,
    ...uniqueSorted([
      ...Object.values(state.candidates).flatMap((candidate) =>
        candidate.implementationEvidence?.uncertainty
          ? [
              `candidate:${candidate.id} · ${candidate.implementationEvidence.uncertainty}`,
            ]
          : [],
      ),
      ...Object.entries(state.reviews).flatMap(([workstream, review]) =>
        review.latestCorrection?.uncertainty
          ? [
              `${workstream} correction · ${review.latestCorrection.uncertainty}`,
            ]
          : [],
      ),
    ]),
  ];
}

function formatDelivery(delivery: Delivery): string {
  return `${delivery.workstreamId} · ${delivery.kind} receipt · ${delivery.targetSha} · ${delivery.candidateId}`;
}

function formatFinding(finding: RunState["findings"][string]): string {
  return `${finding.id} · ${finding.status} · ${workstreamName(finding.workstream)} · ${finding.summary} · evidence: ${finding.evidence}`;
}

function workstreamName(workstream: Workstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function renderList(label: string, values: string[], limit: number): string[] {
  if (values.length === 0) {
    return [`${label}: none recorded`];
  }
  return [
    `${label}:`,
    ...values.slice(0, limit).map((value) => `- ${excerpt(value)}`),
    ...(values.length > limit
      ? [`- … (${values.length - limit} more retained)`]
      : []),
  ];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function excerpt(value: string): string {
  return value.length <= MAX_EXCERPT
    ? value
    : `${value.slice(0, MAX_EXCERPT - 1)}…`;
}

function truncateReceipt(receipt: string): string {
  return truncate(receipt, MAX_COMPLETED_RECEIPT);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
