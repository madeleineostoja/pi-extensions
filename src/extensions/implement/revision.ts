import { mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import {
  admitCandidateWorkspace,
  observeCandidateWorkspace,
  type CandidateWorkspaceObservation,
} from "./candidate-admission.js";
import { captureRestoreSnapshot, snapshotChanged } from "./candidate.js";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import { overallRepairWorkspace } from "./overall-repair.js";
import { readExecutionPlan } from "./execution-plan.js";
import {
  loadRequirementsContext,
  scopedRequirements,
  type RequirementsContext,
} from "./requirements-context.js";
import { buildRevisionPrompt } from "./prompts.js";
import type { RevisionCompletion } from "./result-schemas.js";
import type {
  RuntimeWorkstream,
  SchedulerEffect,
} from "./scheduler/scheduler.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import type { RunState } from "./store.js";
import { spawnValidatedWorker } from "./worker-invocation.js";
import { workstreamWorkspace } from "./workstream-candidate.js";

export type RevisionPacket = {
  role: "implementer";
  completionKind: "revision";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  candidate: RunState["candidates"][string];
  comparisonBase: string;
  reviewComparisonBase: string;
  findingEpoch: number;
  outstandingFindingIds: string[];
  findings: RunState["findings"][string][];
  evidence: string[];
  requirements: RequirementsContext;
};

export type RevisionOutcome =
  | {
      kind: "candidate_ready";
      candidate: RunState["candidates"][string];
      correction: {
        fromCandidateId: string;
        changedPaths: string[];
        evidence: string;
      };
    }
  | { kind: "unchanged"; evidence: string };

export class RevisionFailure extends Error {
  constructor(
    readonly category:
      | "protocol_failure"
      | "provider_failure"
      | "workspace_unsafe",
    message: string,
    readonly observation?: CandidateWorkspaceObservation,
  ) {
    super(message);
  }
}

export function buildRevisionPacket(args: {
  state: RunState;
  effect: Extract<SchedulerEffect, { kind: "run_revision" }>;
}): RevisionPacket {
  const assignment = args.state.revisionAssignments[args.effect.assignmentId];
  const candidate = args.state.candidates[args.effect.candidateId];
  const runtime = runtimeFor(args.state, args.effect.workstream);
  const review = args.state.reviews[workstreamKey(args.effect.workstream)];
  if (
    !assignment ||
    assignment.status !== "open" ||
    !candidate ||
    !runtime ||
    runtime.candidateId !== candidate.id ||
    assignment.candidateId !== candidate.id ||
    assignment.comparisonBase !== candidate.commitSha ||
    !review ||
    review.comparisonBase === "" ||
    review.candidateId !== candidate.id ||
    review.round !== assignment.findingEpoch ||
    !sameIds(review.outstandingIds, assignment.outstandingFindingIds)
  ) {
    throw new RevisionFailure(
      "protocol_failure",
      `Revision assignment ${args.effect.assignmentId} is no longer current.`,
    );
  }
  const findings = assignment.outstandingFindingIds.map((id) => {
    const finding = args.state.findings[id];
    if (
      !finding ||
      finding.status !== "open" ||
      !sameWorkstream(finding.workstream, args.effect.workstream)
    ) {
      throw new RevisionFailure(
        "protocol_failure",
        `Revision assignment ${args.effect.assignmentId} has an invalid finding ${id}.`,
      );
    }
    return finding;
  });
  const plan = args.state.executionPlan
    ? readExecutionPlan(dirname(args.state.executionPlan.path))
    : undefined;
  if (!plan) {
    throw new RevisionFailure(
      "protocol_failure",
      "Revision assignment has no valid immutable execution plan.",
    );
  }
  const context = loadRequirementsContext(
    dirname(args.state.executionPlan!.path),
    plan,
  );
  const requirements =
    args.effect.workstream.kind === "source"
      ? {
          ...context,
          ...scopedRequirements(
            context,
            args.state.workstreams.source[args.effect.workstream.id]!.taskIds,
          ),
        }
      : context;
  return {
    role: "implementer",
    completionKind: "revision",
    identity: `${args.state.run.id}/${args.effect.assignmentId}/${candidate.commitSha}`,
    workspace: {
      path: workspaceFor(args.state, args.effect.workstream, candidate)
        .worktreePath,
      mutationBoundary:
        "Commit corrections only in this assigned candidate worktree. The target checkout and protected source corpus are orchestrator-owned.",
    },
    candidate,
    comparisonBase: assignment.comparisonBase,
    reviewComparisonBase: review.comparisonBase,
    findingEpoch: assignment.findingEpoch,
    outstandingFindingIds: [...assignment.outstandingFindingIds],
    findings,
    evidence: [...assignment.evidence],
    requirements,
  };
}

export async function runRevision(args: {
  state: RunState;
  effect: Extract<SchedulerEffect, { kind: "run_revision" }>;
  git: GitClient;
  subagents: SubagentClient;
  artifactsPath: string;
  signal?: AbortSignal;
  roles: ImplementRoles;
}): Promise<RevisionOutcome> {
  const packet = buildRevisionPacket({
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
    !initial.clean ||
    initial.activeOperation
  ) {
    throw new RevisionFailure(
      "workspace_unsafe",
      "Revision workspace does not match its exact admitted candidate.",
      initial,
    );
  }
  const targetSnapshot = await captureRestoreSnapshot(
    args.git,
    Object.keys(args.state.protectedArtifactHashes),
  );
  let response:
    | { status: "completed"; result: RevisionCompletion }
    | { status: "failed" | "stopped"; error: string }
    | undefined;
  let providerFailure: unknown;
  try {
    const handle = await spawnValidatedWorker({
      packet,
      subagents: args.subagents,
      roles: args.roles,
      taskId: revisionTaskId(args.effect.workstream),
      description: `Revise candidate ${packet.candidate.id}`,
      render: buildRevisionPrompt,
    });
    response = await args.subagents.waitFor<RevisionCompletion>(
      handle,
      args.signal,
    );
  } catch (error) {
    providerFailure = error;
  }
  const observation = await observeCandidateWorkspace(workspaceGit);
  if (
    await snapshotChanged(
      args.git,
      targetSnapshot,
      Object.keys(args.state.protectedArtifactHashes),
    )
  ) {
    throw new RevisionFailure(
      "workspace_unsafe",
      "Revision changed the target checkout or protected source corpus.",
      observation,
    );
  }
  const protectedPaths = Object.keys(args.state.protectedArtifactHashes)
    .map((path) => relative(args.state.run.checkout.root, path))
    .filter((path) => path !== ".." && !path.startsWith("../"));
  const admission = await admitCandidateWorkspace({
    git: workspaceGit,
    observation,
    input: {
      operationId: args.effect.leaseId,
      expectedBranch: workspace.branchName,
      requiredAncestors: [packet.candidate.commitSha],
      comparisonBase: packet.comparisonBase,
      protectedPaths,
      targetBoundaryIntact: true,
    },
  });
  if (admission.kind !== "admitted") {
    if (admission.kind === "unchanged") {
      if (providerFailure || response?.status !== "completed") {
        throw new RevisionFailure(
          "provider_failure",
          providerFailure instanceof Error
            ? providerFailure.message
            : response && response.status !== "completed"
              ? response.error
              : "Revision worker did not produce a completion.",
          observation,
        );
      }
      if (response.result.outcome !== "unchanged") {
        throw new RevisionFailure(
          "protocol_failure",
          "Revision reported a changed correction without an observed candidate change.",
          observation,
        );
      }
      writeRevisionEvidence(args.artifactsPath, args.effect.assignmentId, {
        packet,
        completion: response.result,
        observation,
        outcome: "unchanged",
      });
      return {
        kind: "unchanged",
        evidence: "Revision left the candidate tree unchanged.",
      };
    }
    throw new RevisionFailure(
      "workspace_unsafe",
      `Revision workspace is ${admission.kind}: ${admission.reason}.`,
      observation,
    );
  }
  const reviewChangedPaths = await changedPathsBetween(
    workspaceGit,
    packet.reviewComparisonBase,
    observation.head,
  );
  const evidenceStatus =
    providerFailure || response?.status !== "completed"
      ? "unavailable"
      : "reported";
  const evidencePath = writeRevisionEvidence(
    args.artifactsPath,
    args.effect.assignmentId,
    {
      packet,
      ...(response?.status === "completed"
        ? { completion: response.result }
        : {}),
      ...(providerFailure
        ? {
            error:
              providerFailure instanceof Error
                ? providerFailure.message
                : String(providerFailure),
          }
        : response && response.status !== "completed"
          ? { error: response.error }
          : {}),
      observation,
      admission,
    },
  );
  const completion =
    response?.status === "completed" ? response.result : undefined;
  const candidate: RunState["candidates"][string] = {
    id: `revision:${revisionTaskId(args.effect.workstream)}:${observation.head}`,
    workstream: args.effect.workstream,
    baseSha: packet.candidate.baseSha,
    ...(packet.candidate.integrationBaseSha
      ? { integrationBaseSha: packet.candidate.integrationBaseSha }
      : {}),
    commitSha: observation.head,
    treeSha: observation.tree!,
    evidenceStatus,
    observationArtifact: evidencePath,
    changedPaths: reviewChangedPaths,
    ...(completion
      ? {
          implementationEvidence: {
            summary: completion.summary,
            verification: completion.verification,
            ...(completion.uncertainty
              ? { uncertainty: completion.uncertainty }
              : {}),
            artifactPath: evidencePath,
          },
        }
      : {}),
  };
  return {
    kind: "candidate_ready",
    candidate,
    correction: {
      fromCandidateId: packet.candidate.id,
      changedPaths: reviewChangedPaths,
      evidence: evidencePath,
    },
  };
}

export async function recreateWorkspace(args: {
  state: RunState;
  workstream: RuntimeWorkstream;
  checkpoint: string;
  git: GitClient;
}): Promise<{
  before: CandidateWorkspaceObservation;
  after: CandidateWorkspaceObservation;
  outcome: "restored" | "still_quarantined" | "unsafe";
}> {
  const workspace = workspaceFor(args.state, args.workstream);
  const workspaceGit = args.git.forWorktree(workspace.worktreePath);
  const before = await observeCandidateWorkspace(workspaceGit);
  const manager = new TaskWorkspaceManager(
    args.git,
    workspace.worktreePath + "/..",
  );
  try {
    await manager.recreate(workspace, args.checkpoint);
  } catch {
    try {
      const after = await observeCandidateWorkspace(workspaceGit);
      return {
        before,
        after,
        outcome: after.clean ? "unsafe" : "still_quarantined",
      };
    } catch {
      return { before, after: before, outcome: "unsafe" };
    }
  }
  const after = await observeCandidateWorkspace(workspaceGit);
  return {
    before,
    after,
    outcome:
      after.branch === workspace.branchName &&
      after.head === args.checkpoint &&
      after.clean &&
      !after.activeOperation
        ? "restored"
        : after.clean
          ? "unsafe"
          : "still_quarantined",
  };
}

function workspaceFor(
  state: RunState,
  workstream: RuntimeWorkstream,
  candidate?: RunState["candidates"][string],
) {
  if (workstream.kind === "source") {
    return workstreamWorkspace(state, workstream.id);
  }
  const currentCandidateId =
    state.workstreams.overall[workstream.repairId]?.candidateId;
  const currentCandidate = currentCandidateId
    ? state.candidates[currentCandidateId]
    : undefined;
  return overallRepairWorkspace(
    state,
    workstream.repairId,
    candidate?.baseSha ??
      currentCandidate?.baseSha ??
      state.run.checkout.startHead,
  );
}

function runtimeFor(state: RunState, workstream: RuntimeWorkstream) {
  return workstream.kind === "source"
    ? state.workstreams.source[workstream.id]
    : state.workstreams.overall[workstream.repairId];
}

function revisionTaskId(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source" ? workstream.id : workstream.repairId;
}

function workstreamKey(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source"
    ? `source:${workstream.id}`
    : `overall:${workstream.repairId}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function sameWorkstream(
  left: RuntimeWorkstream,
  right: RuntimeWorkstream,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "source"
      ? left.id === (right as { id: string }).id
      : left.repairId === (right as { repairId: string }).repairId)
  );
}

function writeRevisionEvidence(
  path: string,
  assignmentId: string,
  value: unknown,
): string {
  mkdirSync(path, { recursive: true });
  const evidence = join(path, `${assignmentId}-revision.json`);
  writeAtomicJson(evidence, value);
  return evidence;
}
