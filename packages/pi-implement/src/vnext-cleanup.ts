import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitClient } from "./git.js";
import type { VNextSchedulerEvent } from "./scheduler-vnext.js";
import type { CheckoutLeaseCapability, VNextRunStore } from "./vnext-store.js";

export async function settleVNextCleanupDebt(args: {
  store: VNextRunStore;
  git: GitClient;
  debtId: string;
  dispatch: (event: VNextSchedulerEvent) => Promise<void>;
}): Promise<void> {
  const state = args.store.read();
  const debt = state.cleanupDebt.find((item) => item.id === args.debtId);
  if (!debt) {
    throw new Error("Cleanup effect does not own durable cleanup debt.");
  }
  if (!debt.worktreePath || !debt.branchName || !debt.expectedCommitSha) {
    throw new Error(
      "Cleanup debt does not prove an owned worktree and branch.",
    );
  }
  const workspace = args.git.forWorktree(debt.worktreePath);
  const [head, branch, clean, descendant] = await Promise.all([
    workspace.head(),
    workspace.currentBranch(),
    workspace.isClean(),
    args.git.isAncestor(state.run.checkout.startHead, debt.expectedCommitSha),
  ]);
  if (
    head !== debt.expectedCommitSha ||
    branch !== debt.branchName ||
    !clean ||
    !descendant
  ) {
    throw new Error(
      "Owned cleanup resource no longer matches its durable identity.",
    );
  }
  await args.git.removeWorktree(debt.worktreePath);
  await args.git.deleteTaskBranch(debt.branchName);
  await args.dispatch({ kind: "cleanup_debt_settled", debtId: debt.id });
}

export function trashCompletedVNextRun(args: {
  lease: CheckoutLeaseCapability;
  store: VNextRunStore;
}): void {
  args.lease.assertOwned();
  const state = args.store.read();
  if (
    state.phase !== "completed" ||
    state.projectionDebt.length > 0 ||
    state.cleanupDebt.length > 0 ||
    Object.keys(state.processLeases).length > 0
  ) {
    throw new Error("Run retains external obligations and cannot enter trash.");
  }
  const runDirectory = join(args.lease.paths.runs, state.run.id);
  const trashDirectory = join(args.lease.paths.trash, state.run.id);
  mkdirSync(args.lease.paths.trash, { recursive: true });
  if (existsSync(trashDirectory)) {
    rmSync(trashDirectory, { recursive: true, force: true });
    return;
  }
  if (!existsSync(runDirectory)) {
    return;
  }
  renameSync(runDirectory, trashDirectory);
  rmSync(trashDirectory, { recursive: true, force: true });
}
