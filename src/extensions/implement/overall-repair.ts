import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import { captureRestoreSnapshot, snapshotChanged } from "./candidate.js";
import {
  TaskWorkspaceManager,
  type TaskWorkspace,
} from "./candidate-worker.js";
import type { ExecutionPlan } from "./execution-plan.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import { buildOverallReworkPrompt } from "./prompts.js";
import { type OverallReworkCompletion } from "./result-schemas.js";
import type { ImplementRoles, SubagentClient } from "./subagents.js";
import type { RuntimeWorkstream } from "./scheduler.js";
import { protectedArtifactsMatch, type RunState } from "./store.js";
import { spawnValidatedWorker } from "./worker-invocation.js";

export type OverallRepairPacket = {
  role: "implementer";
  completionKind: "overall-rework";
  identity: string;
  workspace: { path: string; mutationBoundary: string };
  runId: string;
  runBaseSha: string;
  baseline: RunState["candidates"][string];
  plan: ExecutionPlan;
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
    throw new Error(
      "Protected source artifacts changed before overall repair.",
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
  if (
    (await workspaceGit.head()) !== baseline.commitSha ||
    (await workspaceGit.currentBranch()) !== workspace.branchName ||
    (await workspaceGit.activeOperation()) ||
    !(await workspaceGit.isClean())
  ) {
    throw new Error(
      "Overall repair workspace does not match its durable baseline.",
    );
  }
  const targetSnapshot = await captureRestoreSnapshot(
    args.git,
    Object.keys(args.state.protectedArtifactHashes),
  );
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
    plan: args.plan,
    findings,
  };
  const handle = await spawnValidatedWorker({
    packet,
    subagents: args.subagents,
    roles: args.roles,
    taskId: args.repairId,
    description: `Repair whole-plan findings for ${args.repairId}`,
    render: buildOverallReworkPrompt,
  });
  const result = await args.subagents.waitFor<unknown>(handle, args.signal);
  if (result.status !== "completed") {
    throw new Error(
      `Overall repair implementer ${result.status}: ${result.error}`,
    );
  }
  if (
    (await snapshotChanged(
      args.git,
      targetSnapshot,
      Object.keys(args.state.protectedArtifactHashes),
    )) ||
    !(await protectedArtifactsMatch(args.state))
  ) {
    throw new Error(
      "Overall repair implementer changed the target checkout or protected artifacts.",
    );
  }
  const completion = result.result as OverallReworkCompletion;
  if (
    (await workspaceGit.currentBranch()) !== workspace.branchName ||
    (await workspaceGit.activeOperation())
  ) {
    throw new Error(
      "Overall repair implementer left the owned workspace on an unsafe Git state.",
    );
  }
  if (!(await workspaceGit.isClean())) {
    const checkpoint = await workspaceGit.checkpoint(
      completion.commitMessage,
      false,
    );
    if (checkpoint.exitCode !== 0) {
      throw new Error(
        `Overall repair checkpoint failed: ${checkpoint.stderr || checkpoint.stdout}`,
      );
    }
  }
  const commitSha = await workspaceGit.head();
  if (!(await workspaceGit.isAncestor(baseline.commitSha, commitSha))) {
    throw new Error(
      "Overall repair candidate does not descend from its reviewed baseline.",
    );
  }
  const changedPaths = await changedPathsBetween(
    workspaceGit,
    baseline.commitSha,
    commitSha,
  );
  const protectedPaths = new Set(
    Object.keys(args.state.protectedArtifactHashes).map((path) =>
      relative(args.state.run.checkout.root, path),
    ),
  );
  if (changedPaths.some((path) => protectedPaths.has(path))) {
    throw new Error(
      "Overall repair candidate changed a protected plan artifact.",
    );
  }
  const treeSha = await workspaceGit.treeAt(commitSha);
  mkdirSync(args.artifactsPath, { recursive: true });
  writeAtomicJson(
    join(args.artifactsPath, `${args.repairId}-completion.json`),
    completion,
  );
  return {
    candidate: {
      id: `overall:${args.state.run.id}:${args.repairId}:${commitSha}`,
      workstream: {
        kind: "overall",
        repairId: args.repairId,
      } satisfies RuntimeWorkstream,
      baseSha: baseline.commitSha,
      commitSha,
      treeSha,
      commitMessage: completion.commitMessage,
      implementationEvidence: {
        summary: completion.summary,
        verification: completion.verification,
        artifactPath: join(
          args.artifactsPath,
          `${args.repairId}-completion.json`,
        ),
        changedPaths,
      },
    },
    checkpoints: {},
    satisfied: {},
  };
}
