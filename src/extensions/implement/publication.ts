import type { SchedulerEffect, SchedulerEvent } from "./scheduler/scheduler.js";
import type { RunState } from "./store.js";
import {
  type PublicationOutcome,
  type WriteAheadPublicationIntent,
  type WriteAheadPublisher,
} from "./write-ahead-publication.js";

export class MissingHookEvidenceError extends Error {
  constructor() {
    super("Publication preparation lacks ordinary commit hook evidence.");
  }
}

export class PublicationError extends Error {
  constructor(
    readonly outcome: Exclude<PublicationOutcome, { kind: "published" }>,
  ) {
    super(
      outcome.kind === "safety_paused"
        ? outcome.reason
        : outcome.kind === "target_moved"
          ? `Target moved from ${outcome.expected} to ${outcome.actual}.`
          : "Publication remains ready to retry from its durable base.",
    );
  }
}

export async function runPublication(args: {
  state: RunState;
  effect: Extract<SchedulerEffect, { kind: "run_publication" }>;
  publisher: Pick<WriteAheadPublisher, "publish" | "recover">;
  dispatch: (event: SchedulerEvent) => Promise<void>;
  projectionDebt?: RunState["projectionDebt"][number];
}): Promise<void> {
  const intent = args.state.publication.intents[args.effect.intentId];
  if (!intent || intent.candidateId !== args.effect.candidateId) {
    throw new Error("Publication effect does not own a durable intent.");
  }
  const preparation = args.state.publication.preparations[intent.preparationId];
  if (
    !preparation ||
    preparation.candidateId !== intent.candidateId ||
    preparation.targetBaseSha !== intent.targetBaseSha ||
    preparation.preparedCommitSha !== intent.preparedCommitSha ||
    preparation.preparedTreeSha !== intent.preparedTreeSha ||
    preparation.targetRef !== intent.targetRef
  ) {
    throw new Error(
      "Publication intent does not match its durable preparation.",
    );
  }
  if (!preparation.hookCommand) {
    throw new MissingHookEvidenceError();
  }
  const existingReceipt = args.state.publication.receipts[intent.id];
  if (existingReceipt) {
    await args.dispatch({
      kind: "publication_completed",
      workstream: args.effect.workstream,
      leaseId: args.effect.leaseId,
      intentId: intent.id,
      projectionDebt: args.projectionDebt,
    });
    return;
  }
  const writeAheadIntent = toWriteAheadIntent(intent);
  let outcome: PublicationOutcome;
  let recoveredAfterFailure = false;
  try {
    outcome = await args.publisher.publish(writeAheadIntent);
  } catch (error) {
    try {
      outcome = await args.publisher.recover(writeAheadIntent);
      recoveredAfterFailure = true;
    } catch {
      throw error;
    }
  }
  if (outcome.kind === "target_moved") {
    await args.dispatch({
      kind: "publication_target_moved",
      workstream: args.effect.workstream,
      leaseId: args.effect.leaseId,
      intentId: intent.id,
      candidateId: intent.candidateId,
      expectedTargetSha: outcome.expected,
      actualTargetSha: outcome.actual,
    });
    return;
  }
  if (
    !recoveredAfterFailure &&
    outcome.kind !== "published" &&
    outcome.kind !== "safety_paused"
  ) {
    outcome = await args.publisher.recover(writeAheadIntent);
  }
  if (outcome.kind !== "published") {
    throw new PublicationError(outcome);
  }
  await args.dispatch({
    kind: "publication_receipt_recorded",
    operationId: args.effect.leaseId,
    receipt: {
      operationId: args.effect.leaseId,
      intentId: intent.id,
      candidateId: intent.candidateId,
      targetBaseSha: intent.targetBaseSha,
      publishedCommitSha: outcome.receipt.publishedCommitSha,
      publishedTreeSha: outcome.receipt.publishedTreeSha,
      targetRef: intent.targetRef,
      protectedArtifactHashes: intent.protectedArtifactHashes,
      publishedAt: outcome.receipt.publishedAt,
    },
  });
  await args.dispatch({
    kind: "publication_completed",
    workstream: args.effect.workstream,
    leaseId: args.effect.leaseId,
    intentId: intent.id,
    projectionDebt: args.projectionDebt,
  });
}

function toWriteAheadIntent(
  intent: RunState["publication"]["intents"][string],
): WriteAheadPublicationIntent {
  return {
    id: intent.id,
    candidateId: intent.candidateId,
    targetBaseSha: intent.targetBaseSha,
    preparedCommitSha: intent.preparedCommitSha,
    preparedTreeSha: intent.preparedTreeSha,
    targetRef: intent.targetRef,
    protectedArtifactSnapshots: intent.protectedArtifactSnapshots,
    protectedArtifactHashes: intent.protectedArtifactHashes,
  };
}
