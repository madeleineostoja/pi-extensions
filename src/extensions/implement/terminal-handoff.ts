import type { RunState } from "./store.js";

const MAX_RETAINED_TEXT = 12_000;
const MAX_EXCERPT = 280;

type Delivery = {
  workstreamId: string;
  kind: "publication" | "satisfaction";
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
    "",
    `- Run: ${code(state.run.id)}`,
    `- Published: ${code(lastProvenPublishedHead(state))} → ${code(state.run.checkout.branchRef)}`,
    `- Delivered workstreams: ${formatNames(deliveries.map((delivery) => delivery.workstreamId))}`,
    `- Residual findings: ${finalFindings.length === 0 ? "None." : `${finalFindings.length} material ${plural(finalFindings.length, "finding")} retained.`}`,
    `- Evidence: ${code(`/implement inspect ${state.run.id}`)}`,
  ].join("\n");
  return `${handoffDraft}\n\n${receipt}`;
}

function renderRetained(state: RunState): string {
  const deliveries = deliveredSourceWorkstreams(state);
  const deliveredIds = new Set(
    deliveries.map((delivery) => delivery.workstreamId),
  );
  const failed = terminalWorkstreamNames(state, "failed", deliveredIds);
  const skipped = terminalWorkstreamNames(
    state,
    "dependency_skipped",
    deliveredIds,
  );
  const notDelivered = Object.values(state.workstreams.source)
    .filter(
      (workstream) =>
        !deliveredIds.has(workstream.id) &&
        workstream.phase !== "failed" &&
        workstream.phase !== "dependency_skipped",
    )
    .map((workstream) => workstream.id)
    .sort(compare);
  const issues = retainedIssues(state);
  const verificationCount = retainedVerificationCount(state);
  const report = [
    "## Run outcome",
    "",
    terminalOutcome(state),
    "",
    "## Delivery status",
    "",
    `- Delivered: ${formatNames(deliveries.map((delivery) => delivery.workstreamId))}`,
    `- Failed: ${formatNames(failed)}`,
    `- Dependency-skipped: ${formatNames(skipped)}`,
    `- Not delivered: ${formatNames(notDelivered)}`,
    "",
    "## Failures and residual findings",
    "",
    ...(issues.length > 0
      ? issues.map((issue) => `- ${issue}`)
      : ["No additional failures or residual findings were recorded."]),
  ].join("\n");
  const retained = [
    "## Retained state and cleanup",
    "",
    "This run cannot be resumed. Detailed evidence and owned resources remain retained for inspection and cleanup.",
    "",
    ...(verificationCount > 0
      ? [`- Retained verification records: ${verificationCount}`]
      : []),
    `- Inspect: ${code(`/implement inspect ${state.run.id}`)}`,
    `- Clean up: ${code(`/implement cleanup ${state.run.id}`)}`,
    "",
    "## Delivery receipt",
    "",
    `- Run: ${code(state.run.id)}`,
    `- Branch: ${code(state.run.checkout.branchRef)}`,
    `- Last proven published head: ${code(lastProvenPublishedHead(state))}`,
  ].join("\n");
  return `${truncate(report, MAX_RETAINED_TEXT - retained.length - 2)}\n\n${retained}`;
}

function terminalOutcome(state: RunState): string {
  const prefix =
    state.phase === "incomplete" ? "The run is incomplete." : "The run failed.";
  if (state.failure) {
    return `${prefix} ${excerpt(state.failure.reason)}`;
  }
  const retry = exhaustedWholePlanReviewRetry(state);
  if (retry) {
    return `${prefix} Whole-plan review could not complete after ${retry.attempts} ${plural(retry.attempts, "attempt")}.`;
  }
  const primary = primaryFailure(state);
  if (primary) {
    return `${prefix} Primary blocker: ${code(workstreamLabel(primary.workstream))} — ${excerpt(primary.evidence)}`;
  }
  const skipped = terminalWorkstreamNames(
    state,
    "dependency_skipped",
    new Set(),
  );
  if (skipped.length > 0) {
    return `${prefix} No further safe work remained after required dependencies failed.`;
  }
  return `${prefix} No more specific terminal reason was retained.`;
}

function retainedIssues(state: RunState): string[] {
  const issues: string[] = [];
  const retry = exhaustedWholePlanReviewRetry(state);
  if (retry) {
    issues.push(
      `Whole-plan review exhausted ${retry.attempts} ${plural(retry.attempts, "attempt")}: ${excerpt(retry.evidence.at(-1) ?? retry.evidence[0] ?? "No detailed reason was retained.")}`,
    );
  }
  const primary = state.failure ? undefined : primaryFailure(state);
  for (const failure of failuresByWorkstream(state)) {
    if (failure.id !== primary?.id) {
      issues.push(
        `${code(workstreamLabel(failure.workstream))}: ${excerpt(failure.evidence)}`,
      );
    }
  }
  for (const finding of openFindings(state)) {
    issues.push(
      `Open finding in ${code(workstreamLabel(finding.workstream))}: ${excerpt(finding.summary)}`,
    );
  }
  for (const gap of verificationGaps(state)) {
    issues.push(`Not verified: ${excerpt(gap)}`);
  }
  return unique(issues);
}

function primaryFailure(state: RunState) {
  return failuresByWorkstream(state).at(-1);
}

function failuresByWorkstream(state: RunState) {
  const failures = Object.values(state.failures)
    .filter((failure) => failure.category !== "dependency_skipped")
    .sort(
      (left, right) => compare(left.at, right.at) || compare(left.id, right.id),
    );
  const latest = new Map<string, (typeof failures)[number]>();
  for (const failure of failures) {
    latest.set(workstreamKey(failure.workstream), failure);
  }
  return [...latest.values()].sort(
    (left, right) => compare(left.at, right.at) || compare(left.id, right.id),
  );
}

function verificationGaps(state: RunState): string[] {
  const gaps = [
    ...Object.values(state.candidates).flatMap((candidate) =>
      candidate.implementationEvidence?.uncertainty
        ? [
            `${workstreamLabel(candidate.workstream)} — ${candidate.implementationEvidence.uncertainty}`,
          ]
        : [],
    ),
    ...Object.entries(state.reviews).flatMap(([workstream, review]) =>
      review.latestCorrection?.uncertainty
        ? [`${workstream} — ${review.latestCorrection.uncertainty}`]
        : [],
    ),
  ];
  const unsettledPublications = Object.values(state.publication.intents).filter(
    (intent) =>
      !state.publication.receipts[intent.id] &&
      !state.publication.supersessions[intent.id] &&
      !state.publication.abandonments[intent.id],
  ).length;
  if (unsettledPublications > 0) {
    gaps.push(
      `The outcome of ${unsettledPublications} publication ${plural(unsettledPublications, "attempt")} is uncertain.`,
    );
  }
  return unique(gaps.sort(compare));
}

function retainedVerificationCount(state: RunState): number {
  return unique([
    ...Object.values(state.candidates).flatMap(
      (candidate) => candidate.implementationEvidence?.verification ?? [],
    ),
    ...Object.values(state.reviews).flatMap(
      (review) => review.latestCorrection?.verification ?? [],
    ),
    ...(state.wholePlanReview.evidence ? [state.wholePlanReview.evidence] : []),
  ]).length;
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
      at: receipt.publishedAt,
      receiptId: receipt.intentId,
    });
  }
  for (const receipt of Object.values(state.satisfaction.receipts)) {
    chooseDelivery(deliveries, {
      workstreamId: receipt.workstream.id,
      kind: "satisfaction",
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

function terminalWorkstreamNames(
  state: RunState,
  phase: "failed" | "dependency_skipped",
  deliveredIds: Set<string>,
): string[] {
  const source = Object.values(state.workstreams.source)
    .filter(
      (workstream) =>
        workstream.phase === phase && !deliveredIds.has(workstream.id),
    )
    .map((workstream) => workstream.id);
  const overall = Object.values(state.workstreams.overall)
    .filter((workstream) => workstream.phase === phase)
    .map((workstream) => `whole-plan repair ${workstream.repairId}`);
  return [...source, ...overall].sort(compare);
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

function openFindings(state: RunState): RunState["findings"][string][] {
  return Object.values(state.findings)
    .filter((finding) => finding.status === "open")
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

function exhaustedWholePlanReviewRetry(
  state: RunState,
): NonNullable<RunState["wholePlanReview"]["reviewRetry"]> | undefined {
  const retry = state.wholePlanReview.reviewRetry;
  return retry?.status === "exhausted" ? retry : undefined;
}

function workstreamKey(workstream: Workstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function workstreamLabel(workstream: Workstream): string {
  return workstream.kind === "source"
    ? workstream.id
    : `whole-plan repair ${workstream.repairId}`;
}

function formatNames(values: string[]): string {
  return values.length === 0
    ? "None."
    : values.map((value) => code(value)).join(", ");
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function excerpt(value: string): string {
  return value.length <= MAX_EXCERPT
    ? value
    : `${value.slice(0, MAX_EXCERPT - 1)}…`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
