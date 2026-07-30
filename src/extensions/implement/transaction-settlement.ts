import { readFileSync } from "node:fs";
import { canonicalPath, sha256 } from "./source-integrity.js";
import { settleCheckboxProjection } from "./projection.js";
import { WriteAheadPublisher } from "./write-ahead-publication.js";
import type { GitClient } from "./git.js";
import type { RunStore } from "./store.js";

export async function settlePublicationTransactions(args: {
  store: RunStore;
  git: GitClient;
}): Promise<void> {
  for (const intent of Object.values(args.store.read().publication.intents)) {
    const state = args.store.read();
    const workstream =
      intent.workstream.kind === "source"
        ? state.workstreams.source[intent.workstream.id]
        : state.workstreams.overall[intent.workstream.repairId];
    if (workstream?.phase === "completed") {
      continue;
    }
    const outcome = await new WriteAheadPublisher({
      git: args.git,
      checkoutRoot: state.run.checkout.root,
      checkoutIdentity: state.run.checkout.gitDir,
      protectedPaths: Object.keys(state.protectedArtifactHashes),
    }).recover(intent);
    if (outcome.kind === "published") {
      if (!state.publication.receipts[intent.id]) {
        await args.store.update(state.revision, (current) => ({
          ...current,
          publication: {
            ...current.publication,
            receipts: {
              ...current.publication.receipts,
              [intent.id]: {
                ...outcome.receipt,
                operationId: intent.operationId,
              },
            },
          },
        }));
      }
      continue;
    }
    if (
      outcome.kind !== "retry_from_base" ||
      state.publication.receipts[intent.id]
    ) {
      throw new Error(
        outcome.kind === "safety_paused"
          ? outcome.reason
          : "Publication recovery could not prove an exact durable transaction state.",
      );
    }
  }
}

export async function settleProjectionTransactions(args: {
  store: RunStore;
}): Promise<void> {
  const initial = args.store.read();
  if (initial.projectionDebt.length === 0) {
    return;
  }
  if (!projectionDebtMatchesIntent(initial)) {
    throw new Error(
      "Projection recovery requires each protected source artifact to match an exact retained intent side.",
    );
  }
  for (const debt of initial.projectionDebt) {
    const state = args.store.read();
    if (!state.projectionDebt.some((item) => item.id === debt.id)) {
      continue;
    }
    const outcome = settleCheckboxProjection(state.run.checkout.root, debt);
    if (outcome.kind === "safety_paused") {
      throw new Error(`Projection recovery is unsafe: ${outcome.reason}`);
    }
    await args.store.recordProjection(state.revision, debt.taskIds, {
      ...state.protectedArtifactHashes,
      [debt.canonicalPath]: outcome.protectedHash,
    });
    const recorded = args.store.read();
    await args.store.update(recorded.revision, (current) => ({
      ...current,
      projectionDebt: current.projectionDebt.filter(
        (item) => item.id !== debt.id,
      ),
    }));
  }
}

function projectionDebtMatchesIntent(
  state: ReturnType<RunStore["read"]>,
): boolean {
  const projectedPaths = new Set(
    state.projectionDebt.map((debt) => canonicalPath(debt.canonicalPath)),
  );
  return (
    state.projectionDebt.every((debt) => {
      try {
        const content = readFileSync(debt.canonicalPath, "utf-8");
        const hash = sha256(content);
        return (
          (hash === debt.expectedOldHash &&
            content === debt.expectedOldContent) ||
          (hash === debt.expectedNewHash && content === debt.expectedNewContent)
        );
      } catch {
        return false;
      }
    }) &&
    state.run.source.corpus
      .filter((artifact) => !projectedPaths.has(canonicalPath(artifact.path)))
      .every((artifact) => {
        try {
          return sha256(readFileSync(artifact.path, "utf-8")) === artifact.hash;
        } catch {
          return false;
        }
      })
  );
}
