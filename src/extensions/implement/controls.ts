import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ExecGitClient, type GitClient } from "./git.js";
import { sweepOwnedRunResources, trashRun } from "./cleanup.js";
import {
  acquireCheckoutLease,
  checkoutPaths,
  loadRunState,
  RunStore,
  type CheckoutLeaseCapability,
  type RunState,
} from "./store.js";
import { reduceRunEvent } from "./scheduler/scheduler.js";
import { sourceCorpusPath } from "./requirements-context.js";
import {
  settleProjectionTransactions,
  settlePublicationTransactions,
} from "./transaction-settlement.js";

export type RunListing =
  | { kind: "run"; runId: string; state: RunState }
  | { kind: "historical"; runId: string };

export function listCheckoutRuns(checkoutRoot: string): RunListing[] {
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
      const state = loadRunState(join(path, "run-state.json"));
      if (state.run.checkout.root !== checkoutRoot) {
        throw new Error("run belongs to another checkout");
      }
      return { kind: "run" as const, runId, state };
    } catch {
      return { kind: "historical" as const, runId };
    }
  });
}

export function formatStatus(state: RunState): string {
  const activeRevisions = Object.values(state.revisionAssignments).filter(
    (assignment) => assignment.status === "open",
  );
  const latestFailure = Object.values(state.failures).at(-1);
  const phases = [
    ...Object.values(state.workstreams.source).map(
      (workstream) => `${workstream.id}: ${workstream.phase}`,
    ),
    ...Object.values(state.workstreams.overall).map(
      (workstream) => `${workstream.repairId}: ${workstream.phase}`,
    ),
  ].join(", ");
  const openFindingRecords = Object.values(state.findings).filter(
    (finding) => finding.status === "open",
  );
  const openFindings = openFindingRecords.length;
  const finalResiduals = (
    state.wholePlanReview.epoch?.findingIds ?? []
  ).flatMap((id) => {
    const finding = state.findings[id];
    return finding?.status === "open" ? [finding] : [];
  });
  const terminalLanes = [
    ...Object.values(state.workstreams.source)
      .filter(
        (workstream) =>
          workstream.phase === "failed" ||
          workstream.phase === "dependency_skipped",
      )
      .map((workstream) => `${workstream.id}: ${workstream.phase}`),
    ...Object.values(state.workstreams.overall)
      .filter((workstream) => workstream.phase === "failed")
      .map((workstream) => `${workstream.repairId}: failed`),
  ];
  const activeProcesses = Object.values(state.processLeases)
    .map((lease) => `${lease.kind}:${lease.id}`)
    .join(", ");
  const candidateContext = Object.values(state.candidates).map((candidate) => {
    const review =
      state.reviews[
        candidate.workstream.kind === "source"
          ? `source:${candidate.workstream.id}`
          : `overall:${candidate.workstream.repairId}`
      ];
    return [
      `${candidate.id}: historical base ${candidate.baseSha}`,
      ...(candidate.integrationBaseSha
        ? [`integration base ${candidate.integrationBaseSha}`]
        : []),
      ...(review?.previousCandidateId
        ? [`previous candidate ${review.previousCandidateId}`]
        : []),
      ...(review?.latestCorrection
        ? [
            `final review ${review.latestCorrection.mode} correction · ${review.latestCorrection.evidence}`,
          ]
        : []),
    ].join(" · ");
  });
  const reconciliation = Object.values(state.reconciliationAssignments).map(
    (assignment) =>
      `${assignment.id}: ${assignment.semanticAttempt} ${assignment.status} · failed target ${assignment.targetSha} · context ${assignment.context.key}`,
  );
  const publication = Object.values(state.publication.intents).map((intent) => {
    const supersession = state.publication.supersessions[intent.id];
    const abandonment = state.publication.abandonments[intent.id];
    const receipt = state.publication.receipts[intent.id];
    return `${intent.id}: preparation target ${intent.targetBaseSha} · ${
      receipt
        ? `published ${receipt.publishedCommitSha}`
        : supersession
          ? `superseded by ${supersession.actualTargetSha}`
          : abandonment
            ? "abandoned without a ref write"
            : "pending"
    }`;
  });
  const satisfaction = Object.values(state.satisfaction.receipts).map(
    (receipt) =>
      `${receipt.workstream.id}: ${receipt.candidateId} @ ${receipt.assessedTargetSha}`,
  );
  const publicationUncertainty =
    state.failure?.category === "publication_uncertain"
      ? state.failure.reason
      : Object.values(state.failures)
          .filter((failure) => failure.category === "publication_uncertain")
          .at(-1)?.evidence;
  return [
    `Run: ${state.run.id}`,
    `Run start target: ${state.run.checkout.startHead}`,
    `Phase: ${state.phase}`,
    `Workstreams: ${phases || "none"}`,
    `Active processes: ${activeProcesses || "none"}`,
    `Open findings: ${openFindings}`,
    ...(finalResiduals.length > 0
      ? [`Final residual findings: ${finalResiduals.length}`]
      : []),
    ...(openFindingRecords.length > 0
      ? [
          `Open finding evidence: ${openFindingRecords
            .map((finding) => `${finding.id} · ${finding.evidence}`)
            .join("; ")}`,
        ]
      : []),
    ...(terminalLanes.length > 0
      ? [`Unavailable lanes: ${terminalLanes.join(", ")}`]
      : []),
    `Active revisions: ${["failed", "incomplete"].includes(state.phase) ? 0 : activeRevisions.length}`,
    ...(candidateContext.length > 0
      ? [`Candidates: ${candidateContext.join("; ")}`]
      : []),
    ...(reconciliation.length > 0
      ? [`Reconciliation: ${reconciliation.join("; ")}`]
      : []),
    ...(latestFailure?.category === "target_moved"
      ? [`Moved target: ${latestFailure.targetEvidence ?? "observed"}`]
      : []),
    ...(latestFailure
      ? [
          `Latest failure: ${latestFailure.category} · ${latestFailure.assignment}`,
          `Failure evidence: ${latestFailure.evidence}`,
        ]
      : []),
    `Publication: ${Object.keys(state.publication.receipts).length}/${Object.keys(state.publication.intents).length} receipted; ${Object.keys(state.publication.supersessions).length} superseded; ${Object.keys(state.publication.abandonments).length} abandoned`,
    ...(satisfaction.length > 0
      ? [`Satisfaction receipts: ${satisfaction.join("; ")}`]
      : []),
    ...(publication.length > 0
      ? [`Publication intents: ${publication.join("; ")}`]
      : []),
    ...(publicationUncertainty
      ? [`Publication uncertainty: ${publicationUncertainty}`]
      : []),
    `Debt: ${state.projectionDebt.length > 0 ? `projection debt ${state.projectionDebt.length}` : "none"}`,
    ...(state.failure
      ? [
          `Failure: ${state.failure.category} · ${state.failure.reason}`,
          `Failure origin: ${state.failure.originPhase} at ${state.failure.at}`,
        ]
      : []),
  ].join("\n");
}

export function inspectRun(checkoutRoot: string, runId: string): string {
  assertRunId(runId);
  const paths = checkoutPaths(checkoutRoot);
  const path = join(paths.runs, runId);
  const entry = (() => {
    try {
      return lstatSync(path);
    } catch {
      throw new Error("Run is unavailable or historical; inspect it manually.");
    }
  })();
  if (entry.isSymbolicLink()) {
    throw new Error("Run artifact is symlinked; inspect it manually.");
  }
  if (!entry.isDirectory()) {
    throw new Error("Run is unavailable or historical; inspect it manually.");
  }
  const state = loadRunState(join(path, "run-state.json"));
  if (state.run.checkout.root !== checkoutRoot) {
    throw new Error("Run belongs to a different checkout.");
  }
  const artifacts = join(path, "artifacts");
  const worktree = join(paths.worktrees, runId);
  return [
    formatStatus(state),
    `State: ${join(path, "run-state.json")}`,
    `Execution plan: ${join(path, "execution-plan.json")}`,
    `Source corpus: ${sourceCorpusPath(path)}`,
    `Artifacts: ${artifacts}${existsSync(artifacts) ? "" : " (not retained)"}`,
    `Retained worktree: ${existsSync(worktree) ? worktree : "none"}`,
  ].join("\n");
}

export async function assertProspectiveRunPreflight(
  git: GitClient,
): Promise<void> {
  try {
    if (!(await git.root())) {
      throw new Error("missing root");
    }
  } catch {
    throw new Error("A new run requires a Git worktree.");
  }
  try {
    if (!(await git.head())) {
      throw new Error("missing HEAD");
    }
  } catch {
    throw new Error("A new run requires a resolvable HEAD.");
  }
  if (!(await git.currentBranch())) {
    throw new Error("A new run requires a named local branch.");
  }
  const operation = await git.activeOperation();
  if (operation) {
    throw new Error(
      `A new run cannot start during an active ${operation} operation.`,
    );
  }
  if (!(await git.isClean())) {
    throw new Error(
      "A new run requires a clean target checkout with no nonignored untracked files.",
    );
  }
}

export async function cleanupCompletedRun(args: {
  checkoutRoot: string;
  runId: string;
  prospectiveStart?: boolean;
}): Promise<void> {
  assertRunId(args.runId);
  const git = new ExecGitClient(args.checkoutRoot);
  const lease = await acquireCheckoutLease({
    checkoutRoot: args.checkoutRoot,
    runId: args.runId,
    timeoutMs: 10_000,
  });
  try {
    if (args.prospectiveStart) {
      await assertProspectiveRunPreflight(git);
    }
    if (removeRetainedTrash(lease, args.runId)) {
      return;
    }
    await cleanupWithLease({ lease, git, runId: args.runId });
  } finally {
    await lease.release();
  }
}

export async function cleanupWithLease(args: {
  lease: CheckoutLeaseCapability;
  git: GitClient;
  runId: string;
  allowIncomplete?: boolean;
}): Promise<void> {
  const store = openExactRun(args.lease, args.runId);
  await assertCurrentRunAuthority(store, args.git, args.lease);
  await terminalizeInterruptedRun(store);
  await settlePublicationTransactions({
    store,
    git: args.git,
  });
  await settleProjectionTransactions({ store });
  const state = store.read();
  const allowedPhases = args.allowIncomplete
    ? ["completed", "incomplete", "failed"]
    : ["completed"];
  if (!allowedPhases.includes(state.phase)) {
    throw new Error(
      args.allowIncomplete
        ? "Only completed, incomplete, or failed runs may be cleaned up."
        : "Only completed runs may be destructively cleaned.",
    );
  }
  if (Object.keys(state.processLeases).length > 0) {
    throw new Error(
      "Run retains unresolved process ownership and cannot be cleaned up.",
    );
  }
  await sweepOwnedRunResources({ lease: args.lease, store, git: args.git });
  trashRun({ lease: args.lease, store });
}

export async function releaseCompletedRunResources(args: {
  lease: CheckoutLeaseCapability;
  store: RunStore;
  git: GitClient;
}): Promise<void> {
  await assertCurrentRunAuthority(args.store, args.git, args.lease);
  const state = args.store.read();
  if (state.phase !== "completed") {
    throw new Error("Only completed runs release resources automatically.");
  }
  if (Object.keys(state.processLeases).length > 0) {
    throw new Error(
      "Run retains unresolved process ownership and cannot release resources.",
    );
  }
  await sweepOwnedRunResources(args);
}

export async function cleanupRun(args: {
  checkoutRoot: string;
  runId: string;
}): Promise<void> {
  assertRunId(args.runId);
  const git = new ExecGitClient(args.checkoutRoot);
  const checkoutIdentity = await git.checkoutIdentity();
  const lease = await acquireCheckoutLease({
    checkoutRoot: args.checkoutRoot,
    gitDir: checkoutIdentity,
    runId: args.runId,
    timeoutMs: 10_000,
  });
  try {
    if (removeRetainedTrash(lease, args.runId)) {
      return;
    }
    await cleanupWithLease({
      lease,
      git,
      runId: args.runId,
      allowIncomplete: true,
    });
  } finally {
    await lease.release();
  }
}

export async function terminalizeInterruptedRun(
  store: RunStore,
): Promise<void> {
  let state = store.read();
  if (["planning", "running", "whole_plan_review"].includes(state.phase)) {
    const transition = reduceRunEvent(state, {
      kind: "failure_requested",
      category: "interrupted",
      reason: "Run was retained after its actor ended.",
      now: new Date().toISOString(),
    });
    if (!transition.accepted) {
      throw new Error(
        transition.error ?? "Retained run could not be terminalized.",
      );
    }
    await store.update(state.revision, () => transition.state);
    state = store.read();
  }
  if (state.phase !== "stopping") {
    return;
  }
  for (const lease of Object.values(state.processLeases)) {
    const transition = reduceRunEvent(store.read(), {
      kind: "process_abandoned",
      leaseId: lease.id,
    });
    if (!transition.accepted) {
      throw new Error(
        transition.error ?? "Retained process lease could not be settled.",
      );
    }
    await store.update(store.read().revision, () => transition.state);
  }
  state = store.read();
  if (state.phase === "stopping") {
    const transition = reduceRunEvent(state, { kind: "run_failed" });
    if (!transition.accepted) {
      throw new Error(
        transition.error ?? "Retained run could not be finalized.",
      );
    }
    await store.update(state.revision, () => transition.state);
  }
}

export function assertNoFailedRuns(checkoutRoot: string): void {
  const retained = listCheckoutRuns(checkoutRoot).find(
    (run) => run.kind === "run" && run.state.phase !== "completed",
  );
  if (retained) {
    throw new Error(
      `Run ${retained.runId} is retained in this checkout; inspect and clean it up before starting a new run.`,
    );
  }
}

function removeRetainedTrash(
  lease: CheckoutLeaseCapability,
  runId: string,
): boolean {
  const trash = join(lease.paths.trash, runId);
  if (!existsSync(trash)) {
    return false;
  }
  rmSync(trash, { recursive: true, force: true });
  return true;
}

function openExactRun(lease: CheckoutLeaseCapability, runId: string): RunStore {
  const directory = join(lease.paths.runs, runId);
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) {
    throw new Error("Run is historical or symlinked; recover it manually.");
  }
  const path = join(directory, "run-state.json");
  if (!existsSync(path)) {
    throw new Error("Run is historical or missing; recover it manually.");
  }
  return RunStore.open(lease, path);
}

async function assertCurrentRunAuthority(
  store: RunStore,
  git: GitClient,
  lease: CheckoutLeaseCapability,
): Promise<void> {
  const state = store.read();
  const [root, gitDir] = await Promise.all([
    git.root(),
    git.checkoutIdentity(),
  ]);
  if (
    state.run.checkout.root !== root ||
    state.run.checkout.gitDir !== gitDir ||
    state.run.id !== lease.owner.runId
  ) {
    throw new Error(
      "Run belongs to a different checkout; recover it manually.",
    );
  }
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(runId)) {
    throw new Error(
      "Run ID is invalid; historical artifacts require manual cleanup.",
    );
  }
}
