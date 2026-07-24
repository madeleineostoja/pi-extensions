import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Static } from "typebox";
import { writeAtomicJson } from "./atomic-json.js";
import {
  TaskWorkspaceManager,
  type TaskWorkspace,
} from "./candidate-worker.js";
import { captureRestoreSnapshot, snapshotChanged } from "./candidate.js";
import {
  readExecutionPlan,
  type ExecutionPlan,
} from "./execution-plan-vnext.js";
import type { GitClient } from "./git.js";
import { buildWorkstreamImplementerPrompt } from "./prompts.js";
import {
  workstreamImplementerResultSchema,
  type WorkstreamImplementerCompletion,
} from "./result-schemas.js";
import type { SubagentClient, SubagentHandle } from "./subagents.js";
import type { VNextRunState } from "./vnext-store.js";

export type WorkstreamPacket = {
  workstreamId: string;
  worktreePath: string;
  baseSha: string;
  tasks: ExecutionPlan["tasks"];
  priorCheckpoints: Record<string, string>;
  recoveryObligations: string[];
  sourceMaterial: Array<{ path: string; content: string }>;
};

export type WorkstreamCandidateOutcome =
  | {
      kind: "candidate_ready";
      candidate: VNextRunState["candidates"][string];
      checkpoints: Record<string, string>;
      satisfied: Record<string, string>;
      summary: string;
      verification: WorkstreamImplementerCompletion["verification"];
      uncertainty?: string;
      evidencePath?: string;
    }
  | {
      kind: "satisfaction_claimed";
      evidence: Record<string, string>;
      summary: string;
      verification: WorkstreamImplementerCompletion["verification"];
      uncertainty?: string;
      evidencePath?: string;
    };

export type WorkstreamCandidateLifecycleArgs = {
  state: VNextRunState;
  plan: ExecutionPlan;
  workstreamId: string;
  git: GitClient;
  subagents: SubagentClient;
  signal?: AbortSignal;
  roles?: {
    model?: string;
    type?: string;
    thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  recoveryObligations?: string[];
  trustedCheckpoint?: string;
  artifactsPath?: string;
};

export class WorkstreamCandidateLifecycleError extends Error {
  constructor(
    message: string,
    readonly trustedCheckpoint?: string,
  ) {
    super(message);
  }
}

export async function runWorkstreamCandidate(
  args: WorkstreamCandidateLifecycleArgs,
): Promise<WorkstreamCandidateOutcome> {
  const plan = exactPlanForState(args.state, args.plan);
  const workstream = plan.workstreams.find(
    (candidate) => candidate.id === args.workstreamId,
  );
  const runtime = args.state.workstreams.source[args.workstreamId];
  if (!workstream || !runtime) {
    throw new WorkstreamCandidateLifecycleError(
      `Unknown source workstream: ${args.workstreamId}`,
    );
  }
  if (
    args.state.executionPlan?.hash !== plan.executionPlanHash ||
    runtime.taskIds.join("\0") !== workstream.taskIds.join("\0")
  ) {
    throw new WorkstreamCandidateLifecycleError(
      `Workstream ${args.workstreamId} does not match its immutable execution plan.`,
    );
  }
  if ((await args.git.head()) !== args.state.run.checkout.startHead) {
    throw new WorkstreamCandidateLifecycleError(
      "Target checkout changed from the run base before workstream execution.",
    );
  }
  const protectedPaths = Object.keys(args.state.protectedArtifactHashes);
  if (!(await protectedArtifactsMatch(args.state))) {
    throw new WorkstreamCandidateLifecycleError(
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
  const packet = buildWorkstreamPacket({
    state: args.state,
    plan,
    workstreamId: args.workstreamId,
    workspace,
    recoveryObligations: args.recoveryObligations,
  });
  const targetBefore = await captureRestoreSnapshot(args.git, protectedPaths);
  let agentId: SubagentHandle<WorkstreamImplementerCompletion> | undefined;
  let result:
    | { status: "completed"; result: WorkstreamImplementerCompletion }
    | { status: "failed" | "stopped"; error: string }
    | undefined;
  let failure: unknown;
  try {
    agentId = await args.subagents.spawn({
      type: args.roles?.type ?? "pi-implement:implementer",
      role: "implementer",
      taskId: args.workstreamId,
      prompt: buildWorkstreamImplementerPrompt({
        worktreePath: packet.worktreePath,
        baseSha: packet.baseSha,
        priorCheckpoints: packet.priorCheckpoints,
        recoveryObligations: packet.recoveryObligations,
        tasks: packet.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          objective: task.compiledContract.objective,
          inScope: task.compiledContract.inScope,
          acceptanceCriteria: task.compiledContract.acceptanceCriteria,
          outOfScope: task.compiledContract.outOfScope,
          provenance: task.provenance,
          implementationNotes: task.compiledContract.implementationNotes,
          verificationGuidance: task.compiledContract.verificationGuidance,
        })),
        sourceMaterial: packet.sourceMaterial,
      }),
      description: `Implement workstream ${args.workstreamId}`,
      cwd: workspace.worktreePath,
      model: args.roles?.model,
      thinking: args.roles?.thinking,
      completion: {
        description: "Report the workstream checkpoints or satisfied evidence.",
        schema: workstreamImplementerResultSchema,
      },
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

  const targetChanged = await snapshotChanged(
    args.git,
    targetBefore,
    protectedPaths,
  );
  if (targetChanged || !(await protectedArtifactsMatch(args.state))) {
    writeEvidence(args.artifactsPath, args.workstreamId, {
      status: "target_changed",
    });
    throw new WorkstreamCandidateLifecycleError(
      "Implementer changed the target checkout or protected artifacts.",
    );
  }
  const trustedCheckpoint = await retainedCheckpoint(
    workspaceGit,
    workspace.baseSha,
    protectedPaths
      .map((path) => protectedPathInWorktree(args.state, path))
      .filter((path): path is string => path !== undefined),
  );
  if (failure) {
    writeEvidence(args.artifactsPath, args.workstreamId, {
      status: "failed",
      error: message(failure),
      trustedCheckpoint,
    });
    throw new WorkstreamCandidateLifecycleError(
      `Workstream implementer failed: ${message(failure)}`,
      trustedCheckpoint,
    );
  }
  if (!result || result.status !== "completed") {
    writeEvidence(args.artifactsPath, args.workstreamId, {
      ...result,
      trustedCheckpoint,
    });
    throw new WorkstreamCandidateLifecycleError(
      `Workstream implementer ${result?.status}: ${result?.error ?? "no completion"}`,
      trustedCheckpoint,
    );
  }

  const outcome = await validateCompletion({
    completion: result.result,
    workstream,
    workspace,
    workspaceGit,
    protectedPaths: protectedPaths
      .map((path) => protectedPathInWorktree(args.state, path))
      .filter((path): path is string => path !== undefined),
  });
  const evidencePath = writeEvidence(args.artifactsPath, args.workstreamId, {
    status: "completed",
    completion: result.result,
    outcome,
  });
  return evidencePath ? { ...outcome, evidencePath } : outcome;
}

export async function recreateWorkstreamWorkspace(args: {
  state: VNextRunState;
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
  state: VNextRunState;
  plan: ExecutionPlan;
  workstreamId: string;
  workspace: TaskWorkspace;
  recoveryObligations?: string[];
}): WorkstreamPacket {
  const plan = exactPlanForState(args.state, args.plan);
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
  const materialPaths = new Set(
    tasks.flatMap((task) =>
      task.provenance.map((reference) =>
        resolveCorpusPath(plan, args.state, reference.path),
      ),
    ),
  );
  const sourceMaterial = [...materialPaths].map((path) => ({
    path,
    content: readFileSync(path, "utf-8"),
  }));
  const priorCheckpoints = Object.fromEntries(
    tasks.flatMap((task) => {
      const runtime = args.state.tasks[task.id];
      return runtime?.phase === "checkpointed"
        ? [[task.id, runtime.checkpoint]]
        : [];
    }),
  );
  return {
    workstreamId: args.workstreamId,
    worktreePath: args.workspace.worktreePath,
    baseSha: args.workspace.baseSha,
    tasks,
    priorCheckpoints,
    recoveryObligations: args.recoveryObligations ?? [],
    sourceMaterial,
  };
}

export function workstreamWorkspace(
  state: VNextRunState,
  workstreamId: string,
): TaskWorkspace {
  if (!state.workstreams.source[workstreamId]) {
    throw new WorkstreamCandidateLifecycleError(
      `Unknown source workstream: ${workstreamId}`,
    );
  }
  return {
    taskId: workstreamId,
    branchName: `pi-implement/${state.run.id}/${workstreamId}`,
    worktreePath: join(worktreesRunRoot(state), workstreamId),
    baseSha: state.run.checkout.startHead,
  };
}

function worktreesRunRoot(state: VNextRunState): string {
  return join(
    resolve(state.run.checkout.root),
    ".pi",
    "implement",
    "worktrees",
    state.run.id,
  );
}

async function validateCompletion(args: {
  completion: WorkstreamImplementerCompletion;
  workstream: ExecutionPlan["workstreams"][number];
  workspace: TaskWorkspace;
  workspaceGit: GitClient;
  protectedPaths: string[];
}): Promise<WorkstreamCandidateOutcome> {
  const taskIds = new Set(args.workstream.taskIds);
  const completions = new Map<
    string,
    Static<typeof workstreamImplementerResultSchema>["taskCompletions"][number]
  >();
  for (const completion of args.completion.taskCompletions) {
    if (!taskIds.has(completion.taskId) || completions.has(completion.taskId)) {
      throw new WorkstreamCandidateLifecycleError(
        "Workstream completion must map every assigned task exactly once.",
      );
    }
    completions.set(completion.taskId, completion);
  }
  if (completions.size !== taskIds.size) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream completion must map every assigned task exactly once.",
    );
  }
  if ((await args.workspaceGit.currentBranch()) !== args.workspace.branchName) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream candidate is no longer on its owned branch.",
    );
  }
  if ((await args.workspaceGit.activeOperation()) !== undefined) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream candidate has an active Git operation.",
    );
  }
  if (!(await args.workspaceGit.isClean())) {
    throw new WorkstreamCandidateLifecycleError(
      "Workstream candidate is dirty.",
    );
  }

  if (args.completion.outcome === "already_satisfied") {
    if (args.completion.candidateTip !== undefined) {
      throw new WorkstreamCandidateLifecycleError(
        "An already-satisfied workstream cannot return a candidate tip.",
      );
    }
    if ((await args.workspaceGit.head()) !== args.workspace.baseSha) {
      throw new WorkstreamCandidateLifecycleError(
        "An already-satisfied workstream cannot create commits.",
      );
    }
    const evidence: Record<string, string> = {};
    for (const taskId of args.workstream.taskIds) {
      const completion = completions.get(taskId)!;
      if (completion.kind !== "already_satisfied" || !completion.evidence) {
        throw new WorkstreamCandidateLifecycleError(
          "Already-satisfied tasks require concrete repository-state evidence.",
        );
      }
      evidence[taskId] = completion.evidence;
    }
    return {
      kind: "satisfaction_claimed",
      evidence,
      summary: args.completion.summary,
      verification: args.completion.verification,
      ...(args.completion.uncertainty
        ? { uncertainty: args.completion.uncertainty }
        : {}),
    };
  }

  if (!args.completion.candidateTip) {
    throw new WorkstreamCandidateLifecycleError(
      "A changed workstream requires its final candidate tip.",
    );
  }
  const candidateTip = args.completion.candidateTip;
  if (candidateTip === args.workspace.baseSha) {
    throw new WorkstreamCandidateLifecycleError(
      "A changed workstream must advance beyond its assigned base.",
    );
  }
  if ((await args.workspaceGit.head()) !== candidateTip) {
    throw new WorkstreamCandidateLifecycleError(
      "Candidate tip does not match the workstream worktree HEAD.",
    );
  }
  if (
    !(await args.workspaceGit.isAncestor(args.workspace.baseSha, candidateTip))
  ) {
    throw new WorkstreamCandidateLifecycleError(
      "Candidate does not descend from its assigned base.",
    );
  }
  const treeSha = await args.workspaceGit.tree();
  if ((await args.workspaceGit.treeAt(args.workspace.baseSha)) === treeSha) {
    throw new WorkstreamCandidateLifecycleError(
      "A changed workstream must change the candidate tree.",
    );
  }
  if ((await args.workspaceGit.treeAt(candidateTip)) !== treeSha) {
    throw new WorkstreamCandidateLifecycleError(
      "Candidate tip tree does not match its clean worktree.",
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
  const checkpoints: Record<string, string> = {};
  const satisfied: Record<string, string> = {};
  for (const taskId of args.workstream.taskIds) {
    const completion = completions.get(taskId)!;
    if (completion.kind === "already_satisfied" && completion.evidence) {
      satisfied[taskId] = completion.evidence;
      continue;
    }
    if (completion.kind !== "checkpoint" || !completion.checkpoint) {
      throw new WorkstreamCandidateLifecycleError(
        "Changed tasks require a checkpoint or concrete already-satisfied evidence.",
      );
    }
    if (
      !(await args.workspaceGit.isAncestor(
        args.workspace.baseSha,
        completion.checkpoint,
      )) ||
      !(await args.workspaceGit.isAncestor(completion.checkpoint, candidateTip))
    ) {
      throw new WorkstreamCandidateLifecycleError(
        `Task ${taskId} checkpoint is not reachable from the candidate tip.`,
      );
    }
    checkpoints[taskId] = completion.checkpoint;
  }
  if (Object.keys(checkpoints).length === 0) {
    throw new WorkstreamCandidateLifecycleError(
      "A changed workstream requires at least one checkpointed task.",
    );
  }
  return {
    kind: "candidate_ready",
    candidate: {
      id: `candidate:${args.workstream.id}:${candidateTip}`,
      workstream: { kind: "source", id: args.workstream.id },
      baseSha: args.workspace.baseSha,
      commitSha: candidateTip,
      treeSha,
    },
    checkpoints,
    satisfied,
    summary: args.completion.summary,
    verification: args.completion.verification,
    ...(args.completion.uncertainty
      ? { uncertainty: args.completion.uncertainty }
      : {}),
  };
}

function exactPlanForState(
  state: VNextRunState,
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
  state: VNextRunState,
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
  baseSha: string,
  protectedPaths: Array<string | undefined>,
): Promise<string | undefined> {
  if ((await git.activeOperation()) !== undefined) {
    return undefined;
  }
  const head = await git.head();
  if (!(await git.isAncestor(baseSha, head))) {
    return undefined;
  }
  return (await candidateChangesProtectedPaths(
    git,
    baseSha,
    head,
    protectedPaths.filter((path): path is string => path !== undefined),
  ))
    ? undefined
    : head;
}

function resolveCorpusPath(
  plan: ExecutionPlan,
  state: VNextRunState,
  path: string,
): string {
  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [
        resolve(dirname(plan.source.planPath), path),
        resolve(state.run.checkout.root, path),
      ];
  const corpusPaths = new Set(plan.source.corpusFiles.map((file) => file.path));
  const resolved = candidates.find((candidate) => corpusPaths.has(candidate));
  if (!resolved) {
    throw new WorkstreamCandidateLifecycleError(
      `Workstream provenance is outside the immutable corpus: ${path}`,
    );
  }
  return resolved;
}

function protectedPathInWorktree(
  state: VNextRunState,
  path: string,
): string | undefined {
  const relativePath = relative(state.run.checkout.root, path);
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
  const changed = git.changedPathsBetween
    ? await git.changedPathsBetween(baseSha, candidateTip)
    : (await git.diffRange(baseSha, candidateTip))
        .split("\n")
        .flatMap((line) => {
          const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
          return match ? [match[1]!, match[2]!] : [];
        });
  return protectedPaths.some((path) => changed.includes(path));
}

async function protectedArtifactsMatch(state: VNextRunState): Promise<boolean> {
  try {
    return Object.entries(state.protectedArtifactHashes).every(
      ([path, expected]) =>
        createHash("sha256")
          .update(readFileSync(path, "utf-8"))
          .digest("hex") === expected,
    );
  } catch {
    return false;
  }
}

function writeEvidence(
  artifactsPath: string | undefined,
  workstreamId: string,
  evidence: unknown,
): string | undefined {
  if (!artifactsPath) {
    return undefined;
  }
  mkdirSync(artifactsPath, { recursive: true });
  const path = join(artifactsPath, `${workstreamId}-implementation.json`);
  writeAtomicJson(path, evidence);
  return path;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
