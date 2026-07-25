import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ExecGitClient } from "./git.js";
import { VNextSchedulerActor } from "./scheduler-vnext.js";
import {
  settleVNextCleanupDebt,
  trashCompletedVNextRun,
} from "./vnext-cleanup.js";
import {
  acquireCheckoutLease,
  checkoutPaths,
  loadVNextRunState,
  VNextRunStore,
  type CheckoutLeaseCapability,
  type VNextRunState,
} from "./vnext-store.js";

export type VNextRunListing =
  | { kind: "run"; runId: string; state: VNextRunState }
  | { kind: "historical"; runId: string };

export function listCheckoutVNextRuns(checkoutRoot: string): VNextRunListing[] {
  const runs = checkoutPaths(checkoutRoot).runs;
  if (!existsSync(runs)) {
    return [];
  }
  return readdirSync(runs).map((runId) => {
    try {
      assertRunId(runId);
      const path = join(runs, runId);
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error("run entry is symlinked");
      }
      const state = loadVNextRunState(join(path, "run-state.json"));
      if (state.run.checkout.root !== checkoutRoot) {
        throw new Error("run belongs to another checkout");
      }
      return { kind: "run" as const, runId, state };
    } catch {
      return { kind: "historical" as const, runId };
    }
  });
}

export function formatVNextStatus(state: VNextRunState): string {
  const activeRecovery = Object.values(state.recoveryEpisodes).filter(
    (episode) => episode.status === "open",
  );
  const pausedRecovery = Object.values(state.recoveryEpisodes).filter(
    (episode) => episode.status === "paused",
  );
  const phases = [
    ...Object.values(state.workstreams.source).map(
      (workstream) => `${workstream.id}: ${workstream.phase}`,
    ),
    ...Object.values(state.workstreams.overall).map(
      (workstream) => `${workstream.repairId}: ${workstream.phase}`,
    ),
  ].join(", ");
  const openFindings = Object.values(state.findings).filter(
    (finding) => finding.status === "open",
  ).length;
  const activeProcesses = Object.values(state.processLeases)
    .map((lease) => `${lease.kind}:${lease.id}`)
    .join(", ");
  const latestGate = state.gates.at(-1);
  const debts = [
    state.projectionDebt.length > 0
      ? `projection debt ${state.projectionDebt.length}`
      : undefined,
    state.cleanupDebt.length > 0
      ? `cleanup debt ${state.cleanupDebt.length}`
      : undefined,
  ].filter(Boolean);
  return [
    `Run: ${state.run.id}`,
    `Phase: ${state.phase}`,
    `Workstreams: ${phases || "none"}`,
    `Active processes: ${activeProcesses || "none"}`,
    `Open findings: ${openFindings}`,
    `Active recovery: ${state.phase === "paused" ? 0 : activeRecovery.length}`,
    `Paused recovery: ${pausedRecovery.length}`,
    ...(latestGate
      ? [`Latest gate: ${latestGate.kind} ${latestGate.outcome}`]
      : []),
    `Publication: ${Object.keys(state.publication.receipts).length}/${Object.keys(state.publication.intents).length} receipted`,
    `Debt: ${debts.join(", ") || "none"}`,
    ...(state.pause?.reason ? [`Pause: ${state.pause.reason}`] : []),
    ...(state.terminalReason ? [`Safety: ${state.terminalReason}`] : []),
  ].join("\n");
}

export function inspectVNextRun(checkoutRoot: string, runId: string): string {
  assertRunId(runId);
  const path = join(checkoutPaths(checkoutRoot).runs, runId);
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Run artifact is symlinked; inspect it manually.");
  }
  const state = loadVNextRunState(join(path, "run-state.json"));
  if (state.run.checkout.root !== checkoutRoot) {
    throw new Error("Run belongs to a different checkout.");
  }
  const artifacts = join(path, "artifacts");
  return [
    formatVNextStatus(state),
    `State: ${join(path, "run-state.json")}`,
    `Execution plan: ${join(path, "execution-plan.json")}`,
    `Artifacts: ${existsSync(artifacts) ? artifacts : "none"}`,
  ].join("\n");
}

export async function cleanupCompletedVNextRun(args: {
  checkoutRoot: string;
  runId: string;
}): Promise<void> {
  assertRunId(args.runId);
  const git = new ExecGitClient(args.checkoutRoot);
  const lease = await acquireCheckoutLease({
    checkoutRoot: args.checkoutRoot,
    runId: args.runId,
    timeoutMs: 10_000,
  });
  try {
    const trash = join(lease.paths.trash, args.runId);
    if (existsSync(trash)) {
      rmSync(trash, { recursive: true, force: true });
      return;
    }
    await cleanupWithLease({ lease, git, runId: args.runId });
  } finally {
    await lease.release();
  }
}

export async function cleanupWithLease(args: {
  lease: CheckoutLeaseCapability;
  git: ExecGitClient;
  runId: string;
}): Promise<void> {
  const store = VNextRunStore.open(
    args.lease,
    join(args.lease.paths.runs, args.runId, "run-state.json"),
  );
  if (store.read().phase !== "completed") {
    throw new Error("Only completed VNext runs may be destructively cleaned.");
  }
  const actor = new VNextSchedulerActor({ store });
  for (const debt of store.read().cleanupDebt) {
    await settleVNextCleanupDebt({
      store,
      git: args.git,
      debtId: debt.id,
      dispatch: (event) => actor.dispatch(event).then(() => undefined),
    });
  }
  trashCompletedVNextRun({ lease: args.lease, store });
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(runId)) {
    throw new Error(
      "Run ID is invalid; historical artifacts require manual cleanup.",
    );
  }
}
