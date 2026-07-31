import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import {
  admitCandidateWorkspace,
  observeCandidateWorkspace,
} from "./candidate-admission.js";
import { captureRestoreSnapshot, snapshotChanged } from "./candidate.js";
import {
  TaskWorkspaceManager,
  type TaskWorkspace,
} from "./candidate-worker.js";
import type { ExecutionPlan } from "./execution-plan.js";
import {
  loadRequirementsContext,
  type RequirementsContext,
} from "./requirements-context.js";
import type { GitClient } from "./git.js";
import { buildOverallReworkPrompt } from "./prompts.js";
import { type OverallReworkCompletion } from "./result-schemas.js";
import type { RuntimeWorkstream } from "./scheduler/scheduler.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import { protectedArtifactsMatch, type RunState } from "./store.js";
import {
  spawnValidatedWorker,
  WorkerPacketError,
} from "./worker-invocation.js";
import { WorkstreamCandidateLifecycleError } from "./workstream-candidate.js";

export type OverallRepairPacket = {
  role: "implementer";
  completionKind: "overall-rework";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  runId: string;
  runBaseSha: string;
  baseline: RunState["candidates"][string];
  requirements: RequirementsContext;
  findings: RunState["findings"][string][];
};

export function overallRepairWorkspace(
  state: RunState,
  repairId: string,
  baseSha: string,
): TaskWorkspace {
  if (!state.workstreams.overall[repairId]) {
    throw new Error(`Unknown overall repair: ${repairId}`);
  }
  const root = join(
    resolve(state.run.checkout.root),
    ".pi",
    "pipkin",
    "implement",
    "worktrees",
    state.run.id,
  );
  return {
    taskId: repairId,
    branchName: `pipkin/implement/${state.run.id}/${repairId}`,
    worktreePath: join(root, repairId),
    baseSha,
  };
}

export async function runOverallRepair(args: {
  state: RunState;
  plan: ExecutionPlan;
  repairId: string;
  git: GitClient;
  subagents: SubagentClient;
  artifactsPath: string;
  operationId: string;
  signal?: AbortSignal;
  roles: ImplementRoles;
}): Promise<{
  candidate: RunState["candidates"][string];
  checkpoints: Record<string, string>;
  satisfied: Record<string, string>;
}> {
  const runtime = args.state.workstreams.overall[args.repairId];
  const baseline = runtime?.candidateId
    ? args.state.candidates[runtime.candidateId]
    : undefined;
  if (!runtime || !baseline || baseline.workstream.kind !== "overall") {
    throw new Error("Overall repair has no durable baseline candidate.");
  }
  if (!(await protectedArtifactsMatch(args.state))) {
    throw new WorkstreamCandidateLifecycleError(
      "Protected source artifacts changed before overall repair.",
      "workspace_unsafe",
    );
  }
  const workspace = overallRepairWorkspace(
    args.state,
    args.repairId,
    baseline.commitSha,
  );
  const manager = new TaskWorkspaceManager(
    args.git,
    resolve(workspace.worktreePath, ".."),
  );
  const branches = await args.git.listBranchesMatching(workspace.branchName);
  await manager.ensure(workspace, {
    existingBranch: branches.includes(workspace.branchName),
  });
  const workspaceGit = args.git.forWorktree(workspace.worktreePath);
  const initial = await observeCandidateWorkspace(workspaceGit);
  if (
    initial.head !== baseline.commitSha ||
    initial.tree !== baseline.treeSha ||
    initial.branch !== workspace.branchName ||
    initial.activeOperation ||
    !initial.clean
  ) {
    throw new WorkstreamCandidateLifecycleError(
      "Overall repair workspace does not match its durable baseline.",
      "workspace_unsafe",
      undefined,
      initial,
    );
  }
  const protectedPaths = Object.keys(args.state.protectedArtifactHashes);
  const targetSnapshot = await captureRestoreSnapshot(args.git, protectedPaths);
  const findings = Object.values(args.state.findings).filter(
    (finding) =>
      finding.workstream.kind === "overall" &&
      finding.workstream.repairId === args.repairId &&
      finding.status === "open",
  );
  if (findings.length === 0) {
    throw new Error("Overall repair requires complete current open findings.");
  }
  const packet: OverallRepairPacket = {
    role: "implementer",
    completionKind: "overall-rework",
    identity: `${args.state.run.id}/${args.repairId}/${baseline.id}`,
    workspace: {
      path: workspace.worktreePath,
      mutationBoundary:
        "Commit tracked corrections only in this owned worktree.",
    },
    runId: args.state.run.id,
    runBaseSha: args.state.run.checkout.startHead,
    baseline,
    requirements: loadRequirementsContext(
      join(args.state.executionPlan!.path, ".."),
      args.plan,
    ),
    findings,
  };
  let result:
    | Awaited<ReturnType<typeof args.subagents.waitFor<unknown>>>
    | undefined;
  let failure: unknown;
  try {
    const handle = await spawnValidatedWorker({
      packet,
      subagents: args.subagents,
      roles: args.roles,
      taskId: args.repairId,
      description: `Repair whole-plan findings for ${args.repairId}`,
      render: buildOverallReworkPrompt,
    });
    result = await args.subagents.waitFor<unknown>(handle, args.signal);
  } catch (error) {
    failure = error;
  }
  const observation = await observeCandidateWorkspace(workspaceGit);
  const targetChanged =
    (await snapshotChanged(args.git, targetSnapshot, protectedPaths)) ||
    !(await protectedArtifactsMatch(args.state));
  if (targetChanged) {
    throw new WorkstreamCandidateLifecycleError(
      "Overall repair implementer changed the target checkout or protected artifacts.",
      "workspace_unsafe",
      undefined,
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
      operationId: args.operationId,
      expectedBranch: workspace.branchName,
      requiredAncestors: [baseline.commitSha],
      comparisonBase: baseline.commitSha,
      protectedPaths: candidateProtectedPaths,
      targetBoundaryIntact: true,
    },
  });
  const completion =
    result?.status === "completed"
      ? (result.result as OverallReworkCompletion)
      : undefined;
  const artifactPath = writeOverallRepairEvidence(args, {
    packet,
    ...(completion ? { completion } : {}),
    ...(failure
      ? { error: message(failure) }
      : result && result.status !== "completed"
        ? { error: result.error }
        : {}),
    observation,
    admission,
  });
  if (admission.kind !== "admitted") {
    if (admission.kind === "quarantined" || admission.kind === "unsafe") {
      throw new WorkstreamCandidateLifecycleError(
        `Overall repair workspace is ${admission.kind}: ${admission.reason}.`,
        "workspace_unsafe",
        undefined,
        observation,
      );
    }
    const evidence = failure
      ? message(failure)
      : result && result.status !== "completed"
        ? result.error
        : "Overall repair must produce a non-empty candidate delta.";
    throw new WorkstreamCandidateLifecycleError(
      evidence,
      failure instanceof WorkerPacketError
        ? "protocol_failure"
        : completion
          ? "protocol_failure"
          : "provider_failure",
      undefined,
      observation,
    );
  }
  const evidenceStatus = completion ? "reported" : "unavailable";
  return {
    candidate: {
      id: `overall:${args.state.run.id}:${args.repairId}:${observation.head}`,
      workstream: {
        kind: "overall",
        repairId: args.repairId,
      } satisfies RuntimeWorkstream,
      baseSha: baseline.commitSha,
      commitSha: observation.head,
      treeSha: observation.tree!,
      evidenceStatus,
      observationArtifact: artifactPath,
      changedPaths: admission.changedPaths,
      ...(completion
        ? {
            implementationEvidence: {
              summary: completion.summary,
              verification: completion.verification,
              ...(completion.uncertainty
                ? { uncertainty: completion.uncertainty }
                : {}),
              artifactPath,
              changedPaths: admission.changedPaths,
            },
          }
        : {}),
    },
    checkpoints: {},
    satisfied: {},
  };
}

function writeOverallRepairEvidence(
  args: Pick<
    Parameters<typeof runOverallRepair>[0],
    "artifactsPath" | "repairId" | "operationId"
  >,
  value: unknown,
): string {
  mkdirSync(args.artifactsPath, { recursive: true });
  const path = join(
    args.artifactsPath,
    `${args.repairId}-${args.operationId}-observation.json`,
  );
  writeAtomicJson(path, value);
  return path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
