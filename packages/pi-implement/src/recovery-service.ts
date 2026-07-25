import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { EffectiveRole } from "./config.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import { buildRecoveryPrompt } from "./prompts.js";
import {
  recoveryCompletionSchema,
  type RecoveryCompletion,
} from "./result-schemas.js";
import {
  boundedRecoveryOutput,
  type RecoveryAction,
} from "./recovery-vnext.js";
import type {
  RuntimeWorkstream,
  VNextSchedulerEffect,
} from "./scheduler-vnext.js";
import type { SubagentClient } from "./subagents.js";
import { writeAtomicJson } from "./atomic-json.js";
import {
  recreateWorkstreamWorkspace,
  workstreamWorkspace,
} from "./workstream-candidate.js";
import { overallRepairWorkspace } from "./vnext-overall-repair.js";
import type { VNextRunState } from "./vnext-store.js";

export class RecoverySafetyError extends Error {}

export type VNextRecoveryResult = {
  action: RecoveryAction;
  candidate?: VNextRunState["candidates"][string];
  correction?: {
    fromCandidateId: string;
    changedPaths: string[];
    evidence: string;
  };
};

export async function runVNextRecovery(args: {
  state: VNextRunState;
  effect: Extract<VNextSchedulerEffect, { kind: "run_recovery" }>;
  git: GitClient;
  subagents: SubagentClient;
  artifactsPath: string;
  signal?: AbortSignal;
  roles: EffectiveRole;
}): Promise<VNextRecoveryResult> {
  const episode = args.state.recoveryEpisodes[args.effect.episodeId];
  if (!episode || episode.workstream.kind !== args.effect.workstream.kind) {
    throw new Error("Recovery effect does not own a durable episode.");
  }
  const candidate = episode.candidateId
    ? args.state.candidates[episode.candidateId]
    : undefined;
  const worktreePath = recoveryWorktree(
    args.state,
    args.effect.workstream,
    candidate,
  );
  const handle = await args.subagents.spawn({
    type: args.roles.type,
    role: "recovery",
    model: args.roles.model,
    thinking: args.roles.thinking,
    taskId: recoveryTaskId(args.effect.workstream),
    description: `Recover ${episode.gateId}`,
    cwd: worktreePath,
    prompt: buildRecoveryPrompt({
      worktreePath,
      episode,
      candidate,
      target: {
        branchRef: args.state.run.checkout.branchRef,
        startHead: args.state.run.checkout.startHead,
      },
      permittedMutationBoundary:
        "The assigned disposable worktree only; the target checkout is read-only.",
    }),
    completion: {
      description: "Return one bounded recovery action.",
      schema: recoveryCompletionSchema,
    },
  });
  const response = await args.subagents.waitFor<RecoveryCompletion>(
    handle,
    args.signal,
  );
  if (response.status !== "completed") {
    throw new Error(`Recovery agent ${response.status}: ${response.error}`);
  }
  try {
    const completion = response.result;
    const action: RecoveryAction = {
      kind: completion.action,
      outcome:
        completion.action === "no_safe_action" ? "no_safe_action" : "completed",
      summary: completion.summary,
      evidence: boundedRecoveryOutput(
        completion.diagnosis
          ? `${completion.evidence}\nDiagnosis: ${completion.diagnosis}`
          : completion.evidence,
      ),
      at: new Date().toISOString(),
    };
    if (
      candidate &&
      !["rework_candidate", "reconcile", "recreate_workspace"].includes(
        completion.action,
      )
    ) {
      await assertRetainedCandidateWorkspace({
        state: args.state,
        workstream: args.effect.workstream,
        candidate,
        git: args.git,
      });
    }
    if (completion.action === "recreate_workspace") {
      if (args.effect.workstream.kind !== "source") {
        throw new Error(
          "Only source workstreams support trusted workspace recreation.",
        );
      }
      if (
        completion.trustedCheckpoint &&
        completion.trustedCheckpoint !== episode.workspace.checkpoint
      ) {
        throw new Error(
          "Workspace recreation may use only its retained checkpoint.",
        );
      }
      const checkpoint = episode.workspace.checkpoint;
      if (!checkpoint) {
        throw new Error(
          "Workspace recreation requires a retained trusted checkpoint.",
        );
      }
      await recreateWorkstreamWorkspace({
        state: args.state,
        workstreamId: args.effect.workstream.id,
        git: args.git,
        trustedCheckpoint: checkpoint,
      });
    }
    const result: VNextRecoveryResult = { action };
    if (["rework_candidate", "reconcile"].includes(completion.action)) {
      if (!candidate || !completion.candidateTip) {
        throw new Error(
          "Tracked recovery requires a retained candidate and candidate tip.",
        );
      }
      result.candidate = await recoveredCandidate({
        state: args.state,
        workstream: args.effect.workstream,
        candidate,
        candidateTip: completion.candidateTip,
        git: args.git,
      });
      const changedPaths = await changedPathsBetween(
        args.git.forWorktree(worktreePath),
        candidate.commitSha,
        completion.candidateTip,
      );
      if (
        completion.candidateTip === candidate.commitSha ||
        result.candidate.treeSha === candidate.treeSha ||
        changedPaths.length === 0
      ) {
        throw new Error(
          "Tracked recovery must produce a non-empty committed correction.",
        );
      }
      if (
        completion.changedPaths &&
        JSON.stringify([...completion.changedPaths].sort()) !==
          JSON.stringify(changedPaths)
      ) {
        throw new Error(
          "Recovery changed paths do not match the committed candidate delta.",
        );
      }
      result.correction = {
        fromCandidateId: candidate.id,
        changedPaths,
        evidence: completion.evidence,
      };
    } else if (completion.candidateTip || completion.changedPaths?.length) {
      throw new Error(
        "Only tracked recovery actions may report a candidate delta.",
      );
    }
    mkdirSync(args.artifactsPath, { recursive: true });
    writeAtomicJson(join(args.artifactsPath, `${episode.id}-recovery.json`), {
      episode,
      completion,
      result,
    });
    return result;
  } catch (error) {
    throw new RecoverySafetyError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function assertRetainedCandidateWorkspace(args: {
  state: VNextRunState;
  workstream: RuntimeWorkstream;
  candidate: VNextRunState["candidates"][string];
  git: GitClient;
}): Promise<void> {
  const workspaceGit = args.git.forWorktree(
    recoveryWorktree(args.state, args.workstream, args.candidate),
  );
  if (
    (await workspaceGit.head()) !== args.candidate.commitSha ||
    !(await workspaceGit.isClean()) ||
    (await workspaceGit.activeOperation())
  ) {
    throw new Error(
      "Same-candidate recovery requires the retained candidate identity and a clean owned workspace.",
    );
  }
}

function recoveryWorktree(
  state: VNextRunState,
  workstream: RuntimeWorkstream,
  candidate: VNextRunState["candidates"][string] | undefined,
): string {
  if (workstream.kind === "source") {
    return workstreamWorkspace(state, workstream.id).worktreePath;
  }
  return overallRepairWorkspace(
    state,
    workstream.repairId,
    candidate?.commitSha ?? state.run.checkout.startHead,
  ).worktreePath;
}

async function recoveredCandidate(args: {
  state: VNextRunState;
  workstream: RuntimeWorkstream;
  candidate: VNextRunState["candidates"][string];
  candidateTip: string;
  git: GitClient;
}): Promise<VNextRunState["candidates"][string]> {
  const worktreePath = recoveryWorktree(
    args.state,
    args.workstream,
    args.candidate,
  );
  const workspaceGit = args.git.forWorktree(worktreePath);
  if (
    (await workspaceGit.head()) !== args.candidateTip ||
    !(await workspaceGit.isClean()) ||
    (await workspaceGit.activeOperation())
  ) {
    throw new Error(
      "Tracked recovery must leave its owned workspace clean at candidateTip.",
    );
  }
  if (
    !(await workspaceGit.isAncestor(
      args.candidate.commitSha,
      args.candidateTip,
    ))
  ) {
    throw new Error(
      "Recovered candidate must descend from the retained candidate.",
    );
  }
  const changedPaths = await changedPathsBetween(
    workspaceGit,
    args.candidate.commitSha,
    args.candidateTip,
  );
  const protectedPaths = new Set(
    Object.keys(args.state.protectedArtifactHashes).map((path) =>
      relative(args.state.run.checkout.root, path),
    ),
  );
  if (changedPaths.some((path) => protectedPaths.has(path))) {
    throw new Error("Recovered candidate changes a protected source artifact.");
  }
  return {
    ...args.candidate,
    id: `recovery:${recoveryTaskId(args.workstream)}:${args.candidateTip}`,
    commitSha: args.candidateTip,
    treeSha: await workspaceGit.treeAt(args.candidateTip),
    ...(args.candidate.implementationEvidence
      ? {
          implementationEvidence: {
            ...args.candidate.implementationEvidence,
            changedPaths,
          },
        }
      : {}),
  };
}

function recoveryTaskId(workstream: RuntimeWorkstream): string {
  return workstream.kind === "source" ? workstream.id : workstream.repairId;
}
