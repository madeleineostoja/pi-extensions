import type { SchedulerEvent } from "./scheduler.js";
import type { RunStore } from "./store.js";
import { resumeCheckboxProjection } from "./projection.js";

export async function runProjection(args: {
  store: RunStore;
  debtId: string;
  dispatch: (event: SchedulerEvent) => Promise<void>;
}): Promise<void> {
  const state = args.store.read();
  const debt = state.projectionDebt.find((item) => item.id === args.debtId);
  if (!debt) {
    throw new Error("Projection effect does not own durable projection debt.");
  }
  const outcome = resumeCheckboxProjection(state.run.checkout.root, {
    id: debt.id,
    canonicalPath: debt.canonicalPath,
    expectedOldContent: debt.expectedOldContent,
    expectedOldHash: debt.expectedOldHash,
    expectedNewContent: debt.expectedNewContent,
    expectedNewHash: debt.expectedNewHash,
    taskIds: debt.taskIds,
  });
  if (outcome.kind === "safety_paused") {
    await args.dispatch({
      kind: "safety_paused",
      reason: outcome.reason,
    });
    return;
  }
  const nextHashes = {
    ...state.protectedArtifactHashes,
    [debt.canonicalPath]: outcome.protectedHash,
  };
  await args.store.recordProjection(state.revision, debt.taskIds, nextHashes);
  await args.dispatch({ kind: "projection_debt_settled", debtId: debt.id });
}
