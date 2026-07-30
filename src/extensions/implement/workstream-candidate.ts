import { mkdirSync, readFileSync } from "node:fs";
import {
  admitCandidateWorkspace,
  observeCandidateWorkspace,
  type CandidateWorkspaceObservation,
} from "./candidate-admission.js";
import { dirname, join, relative, resolve } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import {
  TaskWorkspaceManager,
  type TaskWorkspace,
} from "./candidate-worker.js";
import { captureRestoreSnapshot, snapshotChanged } from "./candidate.js";
import { readExecutionPlan, type ExecutionPlan } from "./execution-plan.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import { buildWorkstreamImplementerPrompt } from "./prompts.js";
import {
  canonicalPath,
  protectedArtifactsMatch as artifactHashesMatch,
  resolveCorpusPath as resolveImmutableCorpusPath,
} from "./source-integrity.js";
import { type WorkstreamImplementerCompletion } from "./result-schemas.js";
import type {
  ImplementRoles,
  SubagentClient,
  SubagentHandle,
} from "./subagents.js";
import {
  spawnValidatedWorker,
  WorkerPacketError,
} from "./worker-invocation.js";
import type { RunState } from "./store.js";

export type WorkstreamPacket = {
  role: "implementer";
  completionKind: "implementer";
  identity: string;
  workspace: {
    path: string;
    mutationBoundary: string;
  };
  workstreamId: string;
  baseSha: string;
  tasks: ExecutionPlan["tasks"];
  priorCheckpoints: Record<string, string>;
  recoveryObligations: string[];
  sourceMaterial: Array<{ path: string; content: string }>;
};

export type WorkstreamCandidateOutcome =
  | {
      kind: "candidate_ready";
      candidate: RunState["candidates"][string];
      checkpoints: Record<string, string>;
      satisfied: Record<string, string>;
      summary: string;
      verification: WorkstreamImplementerCompletion["verification"];
      uncertainty?: string;
      evidencePath?: string;
    }
  | {
      kind: "satisfaction_claimed";
      candidate: RunState["candidates"][string];
      evidence: Record<string, string>;
      summary: string;
      verification: WorkstreamImplementerCompletion["verification"];
      uncertainty?: string;
      evidencePath?: string;
    };

export type WorkstreamCandidateLifecycleArgs = {
  state: RunState;
  plan: ExecutionPlan;
  workstreamId: string;
  git: GitClient;
  subagents: SubagentClient;
  signal?: AbortSignal;
  roles: ImplementRoles;
  recoveryObligations?: string[];
  trustedCheckpoint?: string;
  artifactsPath?: string;
  artifactLeaseId?: string;
};

type WorkspaceObservation = CandidateWorkspaceObservation;

type RecoveryWorkspaceEvidence = {
  id: string;
  checkpoint?: string;
  changedPaths: string[];
  stateEvidence: string;
};

export class WorkstreamCandidateLifecycleError extends Error {
  constructor(
    message: string,
    readonly trustedCheckpoint?: string,
    readonly trustedCandidate?: RunState["candidates"][string],
    readonly recoveryWorkspace?: RecoveryWorkspaceEvidence,
  ) {
    super(message);
  }
}

export class TargetBoundaryError extends WorkstreamCandidateLifecycleError {}
export class TargetPreconditionError extends TargetBoundaryError {}

export async function runWorkstreamCandidate(
  args: WorkstreamCandidateLifecycleArgs,
): Promise<WorkstreamCandidateOutcome> {
  let plan: ExecutionPlan;
  let workstream: ExecutionPlan["workstreams"][number];
  let runtime: RunState["workstreams"]["source"][string];
  try {
    plan = exactPlanForState(args.state, args.plan);
    const selected = plan.workstreams.find(
      (candidate) => candidate.id === args.workstreamId,
    );
    const retained = args.state.workstreams.source[args.workstreamId];
    if (!selected || !retained) {
      throw new Error(`Unknown source workstream: ${args.workstreamId}`);
    }
    if (
      args.state.executionPlan?.hash !== plan.executionPlanHash ||
      retained.taskIds.join("\0") !== selected.taskIds.join("\0") ||
      !retained.baseSha
    ) {
      throw new Error(
        `Workstream ${args.workstreamId} does not match its immutable execution plan.`,
      );
    }
    workstream = selected;
    runtime = retained;
  } catch (error) {
    throw new WorkerPacketError(
      `Implementer packet ${args.state.run.id}/${args.workstreamId} could not be materialized: ${message(error)}`,
    );
  }
  if ((await args.git.head()) !== runtime.baseSha) {
    throw new TargetPreconditionError(
      "Target checkout changed from the assigned workstream base before execution.",
    );
  }
  const protectedPaths = Object.keys(args.state.protectedArtifactHashes);
  if (!(await protectedArtifactsMatch(args.state))) {
    throw new TargetPreconditionError(
      "Protected artifacts changed before workstream execution.",
    );
  }

  const workspace = workstreamWorkspace(args.state, args.workstreamId);
  mkdirSync(worktreesRunRoot(args.state), { recursive: true });
  const manager = new TaskWorkspaceManager(
    args.git,
    worktreesRunRoot(args.state),
  );
  const branches = await args.git.listBranchesMatching(workspace.branchName);
  await manager.ensure(workspace, {
    existingBranch: branches.includes(workspace.branchName),
  });
  const workspaceGit = args.git.forWorktree(workspace.worktreePath);
  const expectedCheckpoint =
    args.trustedCheckpoint ??
    trustedCheckpointForWorkstream(args.state, args.workstreamId) ??
    workspace.baseSha;
  if (
    (await workspaceGit.head()) !== expectedCheckpoint ||
    !(await workspaceGit.isClean())
  ) {
    throw new WorkstreamCandidateLifecycleError(
      "Owned workspace does not match its trusted checkpoint; recreate it before retrying.",
    );
  }
  let packet: WorkstreamPacket;
  try {
    packet = buildWorkstreamPacket({
      state: args.state,
      plan,
      workstreamId: args.workstreamId,
      workspace,
      recoveryObligations: args.recoveryObligations,
    });
  } catch (error) {
    throw new WorkerPacketError(
      `Implementer packet ${args.state.run.id}/${args.workstreamId} could not be materialized: ${message(error)}`,
    );
  }
  const targetBefore = await captureRestoreSnapshot(args.git, protectedPaths);
  let agentId: SubagentHandle<WorkstreamImplementerCompletion> | undefined;
  let result:
    | { status: "completed"; result: WorkstreamImplementerCompletion }
    | { status: "failed" | "stopped"; error: string }
    | undefined;
  let failure: unknown;
  try {
    agentId = await spawnValidatedWorker({
      packet,
      subagents: args.subagents,
      roles: args.roles,
      taskId: args.workstreamId,
      description: `Implement workstream ${args.workstreamId}`,
      render: buildWorkstreamImplementerPrompt,
    });
    result = await args.subagents.waitFor(agentId, args.signal);
  } catch (error) {
    failure = error;
    if (agentId) {
      try {
        await args.subagents.stop(agentId);
        await args.subagents.waitFor(agentId);
      } catch {
        // The runtime may already have settled the failed worker.
      }
    }
  }

  const candidateProtectedPaths = protectedPaths
    .map((path) => protectedPathInWorktree(args.state, path))
    .filter((path): path is string => path !== undefined);
  const observation = await observeWorkspace(workspaceGit);
  const targetChanged = await snapshotChanged(
    args.git,
    targetBefore,
    protectedPaths,
  );
  if (targetChanged || !(await protectedArtifactsMatch(args.state))) {
    const evidence =
      "Implementer changed the target checkout or protected artifacts.";
    writeEvidence(args, {
      status: "target_changed",
      observation,
      ...(result?.status === "completed" ? { completion: result.result } : {}),
    });
    throw new TargetBoundaryError(
      evidence,
      undefined,
      undefined,
      workspaceEvidence(args.workstreamId, observation),
    );
  }
  const trustedCheckpoint = await retainedCheckpoint(
    workspaceGit,
    workspace.branchName,
    workspace.baseSha,
    candidateProtectedPaths,
    observation,
  );
  const trustedCandidate = trustedCheckpoint
    ? await checkpointCandidate({
        workstreamId: args.workstreamId,
        baseSha: workspace.baseSha,
        checkpoint: trustedCheckpoint,
        git: workspaceGit,
      })
    : undefined;
  const unavailableCandidate = await unavailableCandidateOutcome({
    workstream,
    workspace,
    workspaceGit,
    observation,
    protectedPaths: candidateProtectedPaths,
    operationId: args.artifactLeaseId ?? workspace.branchName,
  });
  const recoveryWorkspace = workspaceEvidence(
    args.workstreamId,
    observation,
    trustedCheckpoint,
  );
  if (failure) {
    const evidence = `Workstream implementer failed: ${message(failure)}`;
    const evidencePath = writeEvidence(args, {
      status: "failed",
      error: message(failure),
      observation,
      trustedCheckpoint,
      trustedCandidate,
      ...(unavailableCandidate ? { unavailableCandidate } : {}),
    });
    if (unavailableCandidate) {
      return withUnavailableEvidence(unavailableCandidate, evidencePath);
    }
    throw new WorkstreamCandidateLifecycleError(
      evidence,
      trustedCheckpoint,
      trustedCandidate,
      { ...recoveryWorkspace, stateEvidence: evidence },
    );
  }
  if (!result || result.status !== "completed") {
    const evidence = `Workstream implementer ${result?.status}: ${result?.error ?? "no completion"}`;
    const evidencePath = writeEvidence(args, {
      ...result,
      observation,
      trustedCheckpoint,
      trustedCandidate,
      ...(unavailableCandidate ? { unavailableCandidate } : {}),
    });
    if (unavailableCandidate) {
      return withUnavailableEvidence(unavailableCandidate, evidencePath);
    }
    throw new WorkstreamCandidateLifecycleError(
      evidence,
      trustedCheckpoint,
      trustedCandidate,
      { ...recoveryWorkspace, stateEvidence: evidence },
    );
  }

  try {
    const outcome = await validateCompletion({
      completion: result.result,
      workstream,
      workspace,
      workspaceGit,
      observation,
      protectedPaths: candidateProtectedPaths,
    });
    const evidencePath = writeEvidence(args, {
      status: "completed",
      completion: result.result,
      observation,
      outcome,
    });
    return evidencePath ? { ...outcome, evidencePath } : outcome;
  } catch (error) {
    const evidence = message(error);
    const evidencePath = writeEvidence(args, {
      status: "validation_failed",
      completion: result.result,
      observation,
      trustedCheckpoint,
      trustedCandidate,
      ...(unavailableCandidate ? { unavailableCandidate } : {}),
      error: evidence,
    });
    if (unavailableCandidate) {
      return withUnavailableEvidence(unavailableCandidate, evidencePath);
    }
    throw new WorkstreamCandidateLifecycleError(
      evidence,
      trustedCheckpoint,
      trustedCandidate,
      { ...recoveryWorkspace, stateEvidence: evidence },
    );
  }
}

export async function recreateWorkstreamWorkspace(args: {
  state: RunState;
  workstreamId: string;
  git: GitClient;
  trustedCheckpoint: string;
}): Promise<void> {
  const workspace = workstreamWorkspace(args.state, args.workstreamId);
  const manager = new TaskWorkspaceManager(
    args.git,
    worktreesRunRoot(args.state),
  );
  await manager.recreate(workspace, args.trustedCheckpoint);
}

export function buildWorkstreamPacket(args: {
  state: RunState;
  plan: ExecutionPlan;
  workstreamId: string;
  workspace: TaskWorkspace;
  recoveryObligations?: string[];
}): WorkstreamPacket {
  const plan = exactPlanForState(args.state, args.plan);
  const expectedWorkspace = workstreamWorkspace(args.state, args.workstreamId);
  if (
    resolve(args.workspace.worktreePath) !==
      resolve(expectedWorkspace.worktreePath) ||
    args.workspace.baseSha !== expectedWorkspace.baseSha
  ) {
    throw new WorkstreamCandidateLifecycleError(
      `Implementer packet ${args.state.run.id}/${args.workstreamId} has an invalid assigned workspace.`,
    );
  }
  const workstream = plan.workstreams.find(
    (candidate) => candidate.id === args.workstreamId,
  );
  if (!workstream) {
    throw new WorkstreamCandidateLifecycleError(
      `Unknown execution-plan workstream: ${args.workstreamId}`,
    );
  }
  const tasks = workstream.taskIds.map((taskId) => {
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new WorkstreamCandidateLifecycleError(
        `Workstream ${args.workstreamId} references unknown task ${taskId}.`,
      );
    }
    return task;
  });
  const supportingPaths = new Set<string>();
  for (const task of tasks) {
    for (const document of task.supportingDocuments ?? []) {
      try {
        const path = resolveCorpusPath(plan, args.state, document);
        if (path !== plan.source.planPath) {
          supportingPaths.add(path);
        }
      } catch {
        continue;
      }
    }
  }
  const sourceMaterial = [
    ...tasks.map((task) => ({
      path: `${task.sourceAnchor.path}:${task.sourceAnchor.lineNumber}`,
      content: task.sourceBlock,
    })),
    ...[...supportingPaths].map((path) => ({
      path,
      content: readFileSync(path, "utf-8"),
    })),
  ];
  const priorCheckpoints = Object.fromEntries(
    tasks.flatMap((task) => {
      const runtime = args.state.tasks[task.id];
      return runtime?.phase === "checkpointed"
        ? [[task.id, runtime.checkpoint]]
        : [];
    }),
  );
  return {
    role: "implementer",
    completionKind: "implementer",
    identity: `${args.state.run.id}/${args.workstreamId}`,
    workspace: {
      path: expectedWorkspace.worktreePath,
      mutationBoundary:
        "Work only in the assigned disposable worktree. The target checkout and source artifacts are orchestrator-owned: do not access or mutate them. Do not push, rewrite unrelated history, bypass hooks, or leave an active Git operation or uncommitted work behind.",
    },
    workstreamId: args.workstreamId,
    baseSha: expectedWorkspace.baseSha,
    tasks,
    priorCheckpoints,
    recoveryObligations: args.recoveryObligations ?? [],
    sourceMaterial,
  };
}

export function workstreamWorkspace(
  state: RunState,
  workstreamId: string,
): TaskWorkspace {
  if (!state.workstreams.source[workstreamId]) {
    throw new WorkstreamCandidateLifecycleError(
      `Unknown source workstream: ${workstreamId}`,
    );
  }
  const baseSha = state.workstreams.source[workstreamId]!.baseSha;
  if (!baseSha) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream has no assigned runtime base.",
    );
  }
  return {
    taskId: workstreamId,
    branchName: `pipkin/implement/${state.run.id}/${workstreamId}`,
    worktreePath: join(worktreesRunRoot(state), workstreamId),
    baseSha,
  };
}

function worktreesRunRoot(state: RunState): string {
  return join(
    resolve(state.run.checkout.root),
    ".pi",
    "pipkin",
    "implement",
    "worktrees",
    state.run.id,
  );
}

async function unavailableCandidateOutcome(args: {
  workstream: ExecutionPlan["workstreams"][number];
  workspace: TaskWorkspace;
  workspaceGit: GitClient;
  observation: WorkspaceObservation;
  protectedPaths: string[];
  operationId: string;
}): Promise<WorkstreamCandidateOutcome | undefined> {
  const admission = await admitCandidateWorkspace({
    git: args.workspaceGit,
    observation: args.observation,
    input: {
      operationId: args.operationId,
      expectedBranch: args.workspace.branchName,
      requiredAncestors: [args.workspace.baseSha],
      comparisonBase: args.workspace.baseSha,
      protectedPaths: args.protectedPaths,
      targetBoundaryIntact: true,
    },
  });
  if (admission.kind !== "admitted") {
    return undefined;
  }
  const treeSha = args.observation.tree!;
  if (treeSha === (await args.workspaceGit.treeAt(args.workspace.baseSha))) {
    return undefined;
  }
  const changedPaths = admission.changedPaths;
  return {
    kind: "candidate_ready",
    candidate: {
      id: `candidate:${args.workstream.id}:${args.observation.head}`,
      workstream: { kind: "source", id: args.workstream.id },
      baseSha: args.workspace.baseSha,
      commitSha: args.observation.head,
      treeSha,
      evidenceStatus: "unavailable",
      changedPaths,
    },
    checkpoints: Object.fromEntries(
      args.workstream.taskIds.map((taskId) => [taskId, args.observation.head]),
    ),
    satisfied: {},
    summary: "Worker semantic completion is unavailable.",
    verification: [],
  };
}

function withUnavailableEvidence(
  outcome: WorkstreamCandidateOutcome,
  evidencePath: string | undefined,
): WorkstreamCandidateOutcome {
  if (outcome.kind !== "candidate_ready") {
    return outcome;
  }
  return {
    ...outcome,
    candidate: {
      ...outcome.candidate,
      ...(evidencePath ? { observationArtifact: evidencePath } : {}),
    },
    ...(evidencePath ? { evidencePath } : {}),
  };
}

async function validateCompletion(args: {
  completion: WorkstreamImplementerCompletion;
  workstream: ExecutionPlan["workstreams"][number];
  workspace: TaskWorkspace;
  workspaceGit: GitClient;
  observation: WorkspaceObservation;
  protectedPaths: string[];
}): Promise<WorkstreamCandidateOutcome> {
  if (args.observation.branch !== args.workspace.branchName) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream candidate is no longer on its owned branch.",
    );
  }
  if (args.observation.activeOperation !== undefined) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream candidate has an active Git operation.",
    );
  }
  if (!args.observation.clean) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream candidate is dirty.",
    );
  }

  const implementationEvidence = {
    summary: args.completion.summary,
    verification: args.completion.verification,
    ...(args.completion.uncertainty
      ? { uncertainty: args.completion.uncertainty }
      : {}),
  };
  if (args.completion.outcome === "already_satisfied") {
    if (args.observation.head !== args.workspace.baseSha) {
      throw new WorkstreamCandidateLifecycleError(
        "An already-satisfied workstream cannot create commits.",
      );
    }
    const satisfactionEvidence =
      "evidence" in args.completion ? args.completion.evidence : undefined;
    if (!satisfactionEvidence) {
      throw new WorkstreamCandidateLifecycleError(
        "An already-satisfied workstream requires concrete repository-state evidence.",
      );
    }
    const evidence = Object.fromEntries(
      args.workstream.taskIds.map((taskId) => [taskId, satisfactionEvidence]),
    );
    return {
      kind: "satisfaction_claimed",
      candidate: {
        id: `satisfied:${args.workstream.id}:${args.workspace.baseSha}`,
        workstream: { kind: "source", id: args.workstream.id },
        baseSha: args.workspace.baseSha,
        commitSha: args.workspace.baseSha,
        treeSha: await args.workspaceGit.treeAt(args.workspace.baseSha),
        evidenceStatus: "reported",
        implementationEvidence,
      },
      evidence,
      summary: args.completion.summary,
      verification: args.completion.verification,
      ...(args.completion.uncertainty
        ? { uncertainty: args.completion.uncertainty }
        : {}),
    };
  }

  const candidateTip = args.observation.head;
  if (candidateTip === args.workspace.baseSha) {
    throw new WorkstreamCandidateLifecycleError(
      "A changed workstream must advance beyond its assigned base.",
    );
  }
  if (
    !(await args.workspaceGit.isAncestor(args.workspace.baseSha, candidateTip))
  ) {
    throw new WorkstreamCandidateLifecycleError(
      "Candidate does not descend from its assigned base.",
    );
  }
  const treeSha = args.observation.tree!;
  if ((await args.workspaceGit.treeAt(args.workspace.baseSha)) === treeSha) {
    throw new WorkstreamCandidateLifecycleError(
      "A changed workstream must change the candidate tree.",
    );
  }
  if (
    await candidateChangesProtectedPaths(
      args.workspaceGit,
      args.workspace.baseSha,
      candidateTip,
      args.protectedPaths,
    )
  ) {
    throw new WorkstreamCandidateLifecycleError(
      "Candidate changes protected plan artifacts.",
    );
  }
  const changedPaths = await changedPathsBetween(
    args.workspaceGit,
    args.workspace.baseSha,
    candidateTip,
  );
  const checkpoints = Object.fromEntries(
    args.workstream.taskIds.map((taskId) => [taskId, candidateTip]),
  );
  return {
    kind: "candidate_ready",
    candidate: {
      id: `candidate:${args.workstream.id}:${candidateTip}`,
      workstream: { kind: "source", id: args.workstream.id },
      baseSha: args.workspace.baseSha,
      commitSha: candidateTip,
      treeSha,
      evidenceStatus: "reported",
      changedPaths,
      implementationEvidence,
    },
    checkpoints,
    satisfied: {},
    summary: args.completion.summary,
    verification: args.completion.verification,
    ...(args.completion.uncertainty
      ? { uncertainty: args.completion.uncertainty }
      : {}),
  };
}

function exactPlanForState(
  state: RunState,
  supplied: ExecutionPlan,
): ExecutionPlan {
  if (!state.executionPlan) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream execution requires a bound execution plan.",
    );
  }
  const persisted = readExecutionPlan(dirname(state.executionPlan.path));
  if (
    !persisted ||
    persisted.executionPlanHash !== state.executionPlan.hash ||
    supplied.executionPlanHash !== persisted.executionPlanHash
  ) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream execution plan does not match the persisted immutable plan.",
    );
  }
  return persisted;
}

function trustedCheckpointForWorkstream(
  state: RunState,
  workstreamId: string,
): string | undefined {
  const workstream = state.workstreams.source[workstreamId];
  const candidate = workstream?.candidateId
    ? state.candidates[workstream.candidateId]
    : undefined;
  if (
    candidate?.workstream.kind === "source" &&
    candidate.workstream.id === workstreamId
  ) {
    return candidate.commitSha;
  }
  return [...(workstream?.taskIds ?? [])]
    .reverse()
    .map((taskId) => state.tasks[taskId])
    .find((task) => task?.phase === "checkpointed")?.checkpoint;
}

async function retainedCheckpoint(
  git: GitClient,
  expectedBranch: string,
  baseSha: string,
  protectedPaths: string[],
  observation: WorkspaceObservation,
): Promise<string | undefined> {
  if (
    observation.branch !== expectedBranch ||
    observation.activeOperation !== undefined ||
    !observation.clean ||
    !(await git.isAncestor(baseSha, observation.head))
  ) {
    return undefined;
  }
  return (await candidateChangesProtectedPaths(
    git,
    baseSha,
    observation.head,
    protectedPaths,
  ))
    ? undefined
    : observation.head;
}

async function observeWorkspace(git: GitClient): Promise<WorkspaceObservation> {
  return observeCandidateWorkspace(git);
}

async function checkpointCandidate(args: {
  workstreamId: string;
  baseSha: string;
  checkpoint: string;
  git: GitClient;
}): Promise<RunState["candidates"][string] | undefined> {
  if (
    args.checkpoint === args.baseSha ||
    (await args.git.treeAt(args.checkpoint)) ===
      (await args.git.treeAt(args.baseSha))
  ) {
    return undefined;
  }
  return {
    id: `checkpoint:${args.workstreamId}:${args.checkpoint}`,
    workstream: { kind: "source", id: args.workstreamId },
    baseSha: args.baseSha,
    commitSha: args.checkpoint,
    treeSha: await args.git.treeAt(args.checkpoint),
  };
}

function workspaceEvidence(
  workstreamId: string,
  observation: WorkspaceObservation,
  checkpoint?: string,
): RecoveryWorkspaceEvidence {
  const status = observation.status.map(
    (entry) => `${entry.status} ${entry.path}`,
  );
  return {
    id: `source:${workstreamId}`,
    ...(checkpoint ? { checkpoint } : {}),
    changedPaths: [...new Set(observation.status.map((entry) => entry.path))],
    stateEvidence: [
      `Owned workspace HEAD: ${observation.head}.`,
      observation.clean
        ? "Owned workspace is clean."
        : `Owned workspace changes: ${status.join(", ")}.`,
      observation.activeOperation
        ? `Active Git operation: ${observation.activeOperation}.`
        : "No active Git operation.",
    ].join(" "),
  };
}

function resolveCorpusPath(
  plan: ExecutionPlan,
  state: RunState,
  path: string,
): string {
  try {
    return resolveImmutableCorpusPath({
      planPath: plan.source.planPath,
      checkoutRoot: state.run.checkout.root,
      corpus: plan.source.corpusFiles,
      reference: path,
    });
  } catch (error) {
    throw new WorkstreamCandidateLifecycleError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function protectedPathInWorktree(
  state: RunState,
  path: string,
): string | undefined {
  const relativePath = relative(
    canonicalPath(state.run.checkout.root),
    canonicalPath(path),
  );
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\\\" : "/"}`)
  ) {
    return undefined;
  }
  return relativePath;
}

async function candidateChangesProtectedPaths(
  git: GitClient,
  baseSha: string,
  candidateTip: string,
  protectedPaths: string[],
): Promise<boolean> {
  const changed = await changedPathsBetween(git, baseSha, candidateTip);
  return protectedPaths.some((path) => changed.includes(path));
}

async function protectedArtifactsMatch(state: RunState): Promise<boolean> {
  return artifactHashesMatch(state.protectedArtifactHashes);
}

function writeEvidence(
  args: WorkstreamCandidateLifecycleArgs,
  evidence: unknown,
): string | undefined {
  if (!args.artifactsPath || !args.artifactLeaseId) {
    return undefined;
  }
  const path = join(
    args.artifactsPath,
    "implementation",
    args.workstreamId,
    `${args.artifactLeaseId}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeAtomicJson(path, evidence);
  return path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
