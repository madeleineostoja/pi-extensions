import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import {
  admitCandidateWorkspace,
  observeCandidateWorkspace,
  type CandidateWorkspaceObservation,
} from "./candidate-admission.js";
import { captureRestoreSnapshot, snapshotChanged } from "./candidate.js";
import type { GitClient } from "./git.js";
import { overallRepairWorkspace } from "./overall-repair.js";
import { buildReconciliationPrompt } from "./prompts.js";
import type { ReconciliationCompletion } from "./result-schemas.js";
import type { SchedulerEffect } from "./scheduler/scheduler.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import type { RunState } from "./store.js";
import {
  spawnValidatedWorker,
  WorkerPacketError,
} from "./worker-invocation.js";
import { workstreamWorkspace } from "./workstream-candidate.js";

export type ReconciliationPacket = {
  role: "implementer";
  completionKind: "reconciliation";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  candidate: RunState["candidates"][string];
  failedTarget: { commitSha: string; treeSha: string };
  priorIntegrationBase: string;
  replay: {
    disposition: "overlap" | "conflict" | "changed_patch";
    candidatePaths: string[];
    targetPaths: string[];
    relevantPaths: string[];
    evidence: string;
    hookEvidence?: string;
  };
  priorEvidence: string[];
  semanticAttempt: "initial" | "escalated";
  publicationCommitSubject?: string;
};

export type ReconciliationOutcome = {
  candidate: RunState["candidates"][string];
  correction: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
  };
};

export class ReconciliationFailure extends Error {
  constructor(
    readonly category:
      | "protocol_failure"
      | "provider_failure"
      | "workspace_unsafe"
      | "semantic_blocked",
    message: string,
    readonly observation?: CandidateWorkspaceObservation,
  ) {
    super(message);
  }
}

export function buildReconciliationPacket(args: {
  state: RunState;
  effect: Extract<SchedulerEffect, { kind: "run_reconciliation_worker" }>;
}): ReconciliationPacket {
  const assignment =
    args.state.reconciliationAssignments[args.effect.assignmentId];
  const candidate = args.state.candidates[args.effect.candidateId];
  const runtime = runtimeFor(args.state, args.effect.workstream);
  const lease = args.state.processLeases[args.effect.leaseId];
  const review = args.state.reviews[workstreamKey(args.effect.workstream)];
  if (
    !assignment ||
    assignment.status !== "pending" ||
    !candidate ||
    !runtime ||
    lease?.kind !== "reconciliation" ||
    lease.candidateId !== candidate.id ||
    lease.reconciliationAssignmentId !== assignment.id ||
    runtime.candidateId !== candidate.id ||
    assignment.candidateId !== candidate.id ||
    assignment.candidateCommitSha !== candidate.commitSha ||
    assignment.candidateTreeSha !== candidate.treeSha ||
    assignment.operationId === "" ||
    !sameWorkstream(assignment.workstream, args.effect.workstream) ||
    !review ||
    review.candidateId !== candidate.id
  ) {
    throw new ReconciliationFailure(
      "protocol_failure",
      `Reconciliation assignment ${args.effect.assignmentId} is no longer current.`,
    );
  }
  const workspace = workspaceFor(args.state, args.effect.workstream, candidate);
  return {
    role: "implementer",
    completionKind: "reconciliation",
    identity: `${args.state.run.id}/${assignment.id}/${candidate.commitSha}/${assignment.targetSha}`,
    workspace: {
      path: workspace.worktreePath,
      mutationBoundary:
        "Merge only in this assigned candidate worktree. Do not access the target checkout, sibling worktrees, publication staging, or protected source corpus. Do not push, rewrite candidate history, bypass hooks, or leave an active Git operation or uncommitted work.",
    },
    candidate,
    failedTarget: {
      commitSha: assignment.targetSha,
      treeSha: assignment.targetTreeSha,
    },
    priorIntegrationBase: candidate.integrationBaseSha ?? candidate.baseSha,
    replay: {
      disposition: assignment.disposition,
      candidatePaths: [...assignment.paths.candidate],
      targetPaths: [...assignment.paths.target],
      relevantPaths: [...assignment.paths.replay],
      evidence: assignment.evidence,
      ...(assignment.hookEvidence
        ? { hookEvidence: assignment.hookEvidence }
        : {}),
    },
    priorEvidence: [
      ...review.evidence,
      ...(assignment.priorAttemptEvidence ?? []),
      ...(assignment.attemptEvidence ?? []),
    ],
    semanticAttempt: assignment.semanticAttempt ?? "initial",
    ...(review.publicationCommitSubject
      ? { publicationCommitSubject: review.publicationCommitSubject }
      : {}),
  };
}

export async function runReconciliation(args: {
  state: RunState;
  effect: Extract<SchedulerEffect, { kind: "run_reconciliation_worker" }>;
  git: GitClient;
  subagents: SubagentClient;
  artifactsPath: string;
  signal?: AbortSignal;
  roles: ImplementRoles;
}): Promise<ReconciliationOutcome> {
  const packet = buildReconciliationPacket({
    state: args.state,
    effect: args.effect,
  });
  const workspace = workspaceFor(
    args.state,
    args.effect.workstream,
    packet.candidate,
  );
  const workspaceGit = args.git.forWorktree(workspace.worktreePath);
  const initial = await observeCandidateWorkspace(workspaceGit);
  if (
    initial.branch !== workspace.branchName ||
    initial.head !== packet.candidate.commitSha ||
    initial.tree !== packet.candidate.treeSha ||
    !initial.clean ||
    initial.activeOperation
  ) {
    throw new ReconciliationFailure(
      "workspace_unsafe",
      "Reconciliation workspace does not match its exact admitted candidate.",
      initial,
    );
  }
  if (
    (await args.git.treeAt(packet.failedTarget.commitSha)) !==
    packet.failedTarget.treeSha
  ) {
    throw new ReconciliationFailure(
      "workspace_unsafe",
      "Retained failed-target tree no longer matches its immutable identity.",
      initial,
    );
  }
  const protectedPaths = Object.keys(args.state.protectedArtifactHashes);
  const targetSnapshot = await captureRestoreSnapshot(args.git, protectedPaths);
  let response:
    | { status: "completed"; result: ReconciliationCompletion }
    | { status: "failed" | "stopped"; error: string }
    | undefined;
  let providerFailure: unknown;
  try {
    const handle = await spawnValidatedWorker({
      packet,
      subagents: args.subagents,
      roles: args.roles,
      taskId: reconciliationTaskId(args.effect.workstream),
      description: `Reconcile candidate ${packet.candidate.id}`,
      render: buildReconciliationPrompt,
    });
    response = await args.subagents.waitFor<ReconciliationCompletion>(
      handle,
      args.signal,
    );
  } catch (error) {
    providerFailure = error;
  }
  const observation = await observeCandidateWorkspace(workspaceGit);
  if (await snapshotChanged(args.git, targetSnapshot, protectedPaths)) {
    throw new ReconciliationFailure(
      "workspace_unsafe",
      "Reconciliation changed the target checkout or protected source corpus.",
      observation,
    );
  }
  const candidateProtectedPaths = protectedPaths
    .map((path) => relative(args.state.run.checkout.root, path))
    .filter((path) => path !== ".." && !path.startsWith("../"));
  const admission = await admitCandidateWorkspace({
    git: workspaceGit,
    observation,
    input: {
      operationId: args.effect.leaseId,
      expectedBranch: workspace.branchName,
      requiredAncestors: [
        packet.candidate.commitSha,
        packet.failedTarget.commitSha,
      ],
      comparisonBase: packet.failedTarget.commitSha,
      protectedPaths: candidateProtectedPaths,
      targetBoundaryIntact: true,
    },
  });
  if (admission.kind !== "admitted") {
    const failure =
      providerFailure ??
      (response?.status !== "completed" ? response?.error : undefined);
    throw new ReconciliationFailure(
      admission.kind === "unchanged" && !failure
        ? "semantic_blocked"
        : admission.kind === "quarantined" || admission.kind === "unsafe"
          ? "workspace_unsafe"
          : providerFailure instanceof WorkerPacketError
            ? "protocol_failure"
            : "provider_failure",
      `Reconciliation workspace is ${admission.kind}: ${admission.reason}.`,
      observation,
    );
  }
  if (
    (await workspaceGit.parent(observation.head)) !== packet.candidate.commitSha
  ) {
    throw new ReconciliationFailure(
      "workspace_unsafe",
      "Reconciliation must produce one merge commit directly from the retained candidate.",
      observation,
    );
  }
  if (observation.tree === packet.candidate.treeSha) {
    throw new ReconciliationFailure(
      "semantic_blocked",
      "Reconciliation merged the target without changing the prior candidate tree.",
      observation,
    );
  }
  const evidenceStatus =
    providerFailure || response?.status !== "completed"
      ? "unavailable"
      : "reported";
  const evidencePath = writeReconciliationEvidence(
    args.artifactsPath,
    args.effect.assignmentId,
    {
      packet,
      ...(response?.status === "completed"
        ? { completion: response.result }
        : {}),
      ...(providerFailure
        ? { error: message(providerFailure) }
        : response && response.status !== "completed"
          ? { error: response.error }
          : {}),
      observation,
      admission,
    },
  );
  const completion =
    response?.status === "completed" ? response.result : undefined;
  return {
    candidate: {
      id: `reconciliation:${reconciliationTaskId(args.effect.workstream)}:${observation.head}`,
      workstream: args.effect.workstream,
      baseSha: packet.candidate.baseSha,
      integrationBaseSha: packet.failedTarget.commitSha,
      commitSha: observation.head,
      treeSha: observation.tree!,
      evidenceStatus,
      observationArtifact: evidencePath,
      changedPaths: admission.changedPaths,
      ...(completion
        ? {
            implementationEvidence: {
              summary: completion.summary,
              verification: completion.verification,
              ...(completion.uncertainty
                ? { uncertainty: completion.uncertainty }
                : {}),
              artifactPath: evidencePath,
              changedPaths: admission.changedPaths,
            },
          }
        : {}),
    },
    correction: {
      fromCandidateId: packet.candidate.id,
      changedPaths: admission.changedPaths,
      evidence: evidencePath,
    },
  };
}

function workspaceFor(
  state: RunState,
  workstream: ReconciliationPacket["candidate"]["workstream"],
  candidate: RunState["candidates"][string],
) {
  return workstream.kind === "source"
    ? workstreamWorkspace(state, workstream.id)
    : overallRepairWorkspace(state, workstream.repairId, candidate.baseSha);
}

function runtimeFor(
  state: RunState,
  workstream: ReconciliationPacket["candidate"]["workstream"],
) {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]
    : state.workstreams.overall[workstream.repairId];
}

function reconciliationTaskId(
  workstream: ReconciliationPacket["candidate"]["workstream"],
): string {
  return workstream.kind === "source" ? workstream.id : workstream.repairId;
}

function workstreamKey(
  workstream: ReconciliationPacket["candidate"]["workstream"],
): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function sameWorkstream(
  left: ReconciliationPacket["candidate"]["workstream"],
  right: ReconciliationPacket["candidate"]["workstream"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "source"
      ? left.id === (right as { id: string }).id
      : left.repairId === (right as { repairId: string }).repairId)
  );
}

function writeReconciliationEvidence(
  path: string,
  assignmentId: string,
  value: unknown,
): string {
  mkdirSync(path, { recursive: true });
  const evidence = join(path, `${assignmentId}-reconciliation.json`);
  writeAtomicJson(evidence, value);
  return evidence;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
