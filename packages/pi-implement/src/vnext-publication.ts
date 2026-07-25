import type {
  VNextSchedulerEffect,
  VNextSchedulerEvent,
} from "./scheduler-vnext.js";
import type { VNextRunState } from "./vnext-store.js";
import {
  type PublicationOutcome,
  type WriteAheadPublicationIntent,
  type WriteAheadPublisher,
} from "./write-ahead-publication.js";

export class VNextPublicationError extends Error {
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

export async function runVNextPublication(args: {
  state: VNextRunState;
  effect: Extract<VNextSchedulerEffect, { kind: "run_publication" }>;
  publisher: WriteAheadPublisher;
  dispatch: (event: VNextSchedulerEvent) => Promise<void>;
  projectionDebt?: VNextRunState["projectionDebt"][number];
  resume?: boolean;
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
  const initial = args.resume
    ? await args.publisher.recover(writeAheadIntent)
    : await args.publisher.publish(writeAheadIntent);
  const outcome =
    initial.kind === "published" || initial.kind === "safety_paused"
      ? initial
      : await args.publisher.recover(writeAheadIntent);
  if (outcome.kind !== "published") {
    throw new VNextPublicationError(outcome);
  }
  await args.dispatch({
    kind: "publication_receipt_recorded",
    receipt: {
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
  intent: VNextRunState["publication"]["intents"][string],
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
